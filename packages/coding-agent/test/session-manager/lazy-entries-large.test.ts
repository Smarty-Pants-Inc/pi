import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "fs";
import { describe, expect, it, vi } from "vitest";
import { getEntryLocation, isColdEntry, toColdEntry } from "../../src/core/session-lazy-entries.ts";
import {
	buildSessionContext,
	loadEntriesFromFile,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { writeSyntheticSession } from "./lazy-entries-fixture.ts";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, readSync: vi.fn(actual.readSync), openSync: vi.fn(actual.openSync) };
});

const reads = vi.mocked(fs.readSync);
function bytesRead(): number {
	return reads.mock.results.reduce(
		(bytes, result) => bytes + (typeof result.value === "number" ? result.value : 0),
		0,
	);
}

// smarty-dev#4250: context selection includes UI/state entries; that must not hydrate their payloads.
describe("large lazy session I/O bounds", () => {
	it("bounds open, idle, turns, payload iteration, branch moves and append/reload on 150 MiB", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-large-"));
		try {
			const file = join(dir, "session.jsonl");
			const fixture = writeSyntheticSession(file, dir);
			expect(fixture.bytes).toBeGreaterThanOrEqual(150 * 1024 * 1024);
			reads.mockClear();
			const session = SessionManager.open(file);
			// One initial scan, a small header probe, and only model-contributing context hydration.
			expect(bytesRead()).toBeLessThan(fixture.bytes + 4 * 1024 * 1024);
			const entries = session.getEntries();
			const snapshots = entries.filter((entry) => entry.type === "custom");
			expect(snapshots.filter(isColdEntry).length).toBeGreaterThan(fixture.snapshots - 16);
			const residentStateBytes = snapshots
				.filter((entry) => !isColdEntry(entry))
				.reduce((bytes, entry) => bytes + getEntryLocation(entry)!.length, 0);
			expect(residentStateBytes).toBeLessThanOrEqual(8 * 1024 * 1024);

			reads.mockClear();
			for (let i = 0; i < 100; i++) {
				session.revision();
				for (const entry of session.getEntries()) {
					if (entry.type === "message" && entry.message.role === "assistant")
						expect(entry.message.usage.totalTokens).toBe(15);
				}
			}
			expect(bytesRead()).toBe(0);
			const expectedMessages = 1 + 30 + 3 * fixture.snapshots;
			for (let i = 0; i < 3; i++) {
				const context = session.buildSessionContext();
				expect(context.messages).toHaveLength(expectedMessages);
				expect(context.messages[0].role).toBe("compactionSummary");
				expect(context.model).toEqual({ provider: "faux", modelId: "faux-1" });
				JSON.stringify(context.messages);
			}
			expect(session.getBranch().map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
			expect(session.buildContextEntries()[0].id).toBe(fixture.lastCompactionId);
			expect(bytesRead()).toBe(0);

			// smarty-dev#4250: a fitting full scan hydrates once, not on every iteration.
			vi.mocked(fs.openSync).mockClear();
			for (const entry of session.getEntries()) JSON.stringify(entry);
			expect(bytesRead()).toBeLessThanOrEqual(fixture.bytes);
			expect(reads.mock.calls.length).toBeLessThanOrEqual(fixture.entries);
			expect(vi.mocked(fs.openSync).mock.calls.length).toBeLessThanOrEqual(reads.mock.calls.length);
			for (const call of reads.mock.calls) {
				expect((call as readonly unknown[])[4]).toBeGreaterThanOrEqual(0);
			}
			reads.mockClear();
			for (const entry of session.getEntries()) JSON.stringify(entry);
			expect(bytesRead()).toBe(0);
			expect(reads.mock.calls).toHaveLength(0);
			const kept = session.appendMessage({ role: "user", content: "kept after checkpoint", timestamp: 2 });
			session.appendCompaction("new checkpoint", kept, 1000);
			expect(bytesRead()).toBe(0);
			const expected = JSON.stringify(session.buildSessionContext());
			expect(session.buildSessionContext().messages.map((message) => message.role)).toEqual([
				"compactionSummary",
				"user",
			]);
			const newLeaf = session.getLeafId()!;
			session.branch(fixture.leafId);
			expect(bytesRead()).toBeLessThan(4 * 1024 * 1024);
			JSON.stringify(session.buildSessionContext().messages);
			expect(session.buildSessionContext().messages).toHaveLength(expectedMessages);
			session.branch(newLeaf);
			expect(JSON.stringify(session.buildSessionContext())).toBe(expected);
			const size = fs.statSync(file).size;
			reads.mockClear();
			const reloaded = SessionManager.open(file);
			expect(JSON.stringify(reloaded.buildSessionContext())).toBe(expected);
			expect(reloaded.getBranch()).toHaveLength(fixture.entries + 2);
			expect(bytesRead()).toBeLessThanOrEqual(size + 4096);
			reads.mockClear();
			JSON.stringify(reloaded.buildSessionContext());
			expect(bytesRead()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// smarty-dev#4250: repeatedly reading a fitting working set must not reread disk.
	it("caches demanded payloads by bytes, evicts LRU entries, and detects file changes", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-cache-"));
		try {
			const file = join(dir, "session.jsonl");
			const lines = Array.from({ length: 340 }, (_, i) => ({
				type: "custom",
				id: `cache${i}`,
				parentId: null,
				timestamp: "t",
				customType: "state",
				data: { output: "x".repeat(512 * 1024) },
			}));
			const serialized = lines.map((line) => JSON.stringify(line));
			writeFileSync(file, `${serialized.join("\n")}\n`);
			let offset = 0;
			const cold = lines.map((entry, i) => {
				const location = { file, offset, length: Buffer.byteLength(serialized[i]) };
				offset += location.length + 1;
				return toColdEntry(entry, location);
			});
			for (const entry of cold) expect(entry.data.output.length).toBe(512 * 1024);
			reads.mockClear();
			for (let round = 0; round < 3; round++) {
				for (const entry of cold.slice(300)) expect(entry.data.output.length).toBe(512 * 1024);
			}
			expect(bytesRead()).toBe(0);
			// 170 MiB cannot all remain in a 160 MiB serialized-byte cache.
			expect(cold[0].data.output.length).toBe(512 * 1024);
			expect(bytesRead()).toBeGreaterThan(0);
			reads.mockClear();
			fs.appendFileSync(file, "\n");
			expect(cold[0].data.output.length).toBe(512 * 1024);
			expect(bytesRead()).toBe(0);
			expect(cold[1].data.output.length).toBe(512 * 1024);
			writeFileSync(file, "\n");
			expect(() => cold[0].data).toThrow(/Session file changed on disk/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// smarty-dev#4250: cached payloads preserve multi-byte UTF-8 and large line values.
	it("hydrates UTF-8 and large lines without changing their values", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-block-"));
		try {
			const file = join(dir, "session.jsonl");
			const values = ["λ".repeat(300000), "z".repeat(600000), "界".repeat(500000)];
			const entries = values.map((data, i) => ({ type: "custom", id: `utf${i}`, data }));
			const lines = entries.map((entry) => JSON.stringify(entry));
			writeFileSync(file, `${lines.join("\n")}\n`);
			let offset = 0;
			for (let i = 0; i < entries.length; i++) {
				const length = Buffer.byteLength(lines[i]);
				const cold = toColdEntry(entries[i], { file, offset, length });
				expect(JSON.stringify(cold)).toBe(lines[i]);
				expect(cold.data).toBe(values[i]);
				offset += length + 1;
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not reread the parsed tail even when fewer than 100 entries exceed its byte budget", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-tail-"));
		try {
			const file = join(dir, "session.jsonl");
			const lines: object[] = [
				{ type: "session", version: 3, id: "tail", timestamp: "t", cwd: dir },
				{
					type: "compaction",
					id: "c",
					parentId: null,
					timestamp: "t",
					summary: "summary",
					firstKeptEntryId: "c",
					tokensBefore: 10,
				},
			];
			let parentId = "c";
			for (let i = 0; i < 20; i++) {
				const id = `e${i}`;
				lines.push({
					type: "custom",
					id,
					parentId,
					timestamp: "t",
					customType: "state",
					data: "x".repeat(1024 * 1024),
				});
				parentId = id;
			}
			writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
			const size = fs.statSync(file).size;
			reads.mockClear();
			const session = SessionManager.open(file);
			expect(bytesRead()).toBe(size + 4096);
			expect(session.getEntries().filter(isColdEntry)).toHaveLength(13);
			reads.mockClear();
			session.branch(parentId);
			JSON.stringify(session.buildSessionContext());
			expect(bytesRead()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps retained older compactions lazy without changing projected context", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-compactions-"));
		try {
			const file = join(dir, "session.jsonl");
			const lines: object[] = [{ type: "session", version: 3, id: "retained", timestamp: "t", cwd: dir }];
			let parentId: string | null = null;
			for (let i = 0; i < 130; i++) {
				const id = `e${i}`;
				lines.push(
					i === 0
						? {
								type: "compaction",
								id,
								parentId,
								timestamp: "t",
								summary: "old".repeat(10000),
								firstKeptEntryId: id,
								tokensBefore: 10,
							}
						: { type: "custom", id, parentId, timestamp: "t", customType: "state", data: "x".repeat(10000) },
				);
				parentId = id;
			}
			lines.push({
				type: "compaction",
				id: "latest",
				parentId,
				timestamp: "t",
				summary: "latest",
				firstKeptEntryId: "e0",
				tokensBefore: 10,
			});
			writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
			reads.mockClear();
			const session = SessionManager.open(file);
			expect(isColdEntry(session.getEntry("e0")!)).toBe(true);
			const eager = loadEntriesFromFile(file).filter((entry): entry is SessionEntry => entry.type !== "session");
			expect(session.buildSessionContext()).toEqual(buildSessionContext(eager));
			expect(session.buildSessionContext().messages).toHaveLength(1);
			reads.mockClear();
			session.branch("latest");
			JSON.stringify(session.buildSessionContext());
			expect(bytesRead()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
