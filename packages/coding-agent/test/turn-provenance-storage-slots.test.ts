import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { serializeSessionBranch } from "../src/core/session-export.ts";
import { isColdEntry } from "../src/core/session-lazy-entries.ts";
import { type FileEntry, SessionManager } from "../src/core/session-manager.ts";
import { getTurnProvenance } from "../src/core/turn-provenance.ts";

const raw = { v: 99, channel: "voice", principal: { id: "historical", nested: [{ value: "original" }] } };
const header = {
	type: "session" as const,
	version: 3,
	id: "history",
	cwd: "/tmp",
	timestamp: "2020-01-01T00:00:00.000Z",
};
function historical(provenance?: unknown): FileEntry {
	return JSON.parse(
		JSON.stringify({
			type: "message",
			id: "old",
			parentId: null,
			timestamp: header.timestamp,
			message: { role: "user", content: "old", timestamp: 1 },
			...(provenance === undefined ? {} : { provenance }),
		}),
	) as FileEntry;
}
function guarded(entry: object, expected: unknown): void {
	const slot = Object.getOwnPropertyDescriptor(entry, "provenance");
	expect(slot).toMatchObject({ value: expected, writable: false, configurable: false, enumerable: true });
	expect(slot).not.toHaveProperty("get");
	expect(Reflect.set(entry, "provenance", { forged: true })).toBe(false);
	expect(Reflect.deleteProperty(entry, "provenance")).toBe(false);
	expect(() => Object.defineProperty(entry, "provenance", { value: { forged: true } })).toThrow();
}

describe("canonical provenance-only slots", () => {
	test.each([undefined, raw])("historical preload %j is detached without backfill", (record) => {
		const supplied = [header, historical(record)];
		const m = SessionManager.inMemory("/tmp", undefined, supplied);
		const e = m.getEntry("old")!;
		guarded(e, record);
		if (record) {
			const stored = Reflect.get(e, "provenance");
			expect(stored).not.toBe(record);
			expect(Object.isFrozen(stored.principal.nested[0])).toBe(true);
			expect(Reflect.set(stored.principal.nested[0], "value", "forged")).toBe(false);
			Reflect.get(supplied[1], "provenance").principal.nested[0].value = "external mutation";
		}
		supplied[1] = historical({ forged: true });
		supplied.push(historical({ injected: true }));
		expect(m.getEntries()).toHaveLength(1);
		expect(Reflect.get(m.getEntry("old")!, "provenance")).toEqual(record);
		const line = JSON.parse(serializeSessionBranch(m).trim().split("\n")[1]);
		if (record) expect(line.provenance).toEqual(record);
		else expect(line).not.toHaveProperty("provenance");
	});

	test("every entry-shaped inspection and mutable state return has a locked absent or present slot", () => {
		const m = SessionManager.inMemory();
		const id = m.appendMessage({ role: "user", content: "one", timestamp: 1 });
		const receipt = getTurnProvenance(m.getEntry(id));
		expect(receipt).toBeDefined();
		const child = m.appendCustomMessageEntry("two", "two", false);
		const views = [
			m.getEntry(id)!,
			m.getEntries()[0],
			m.getBranch()[0],
			m.buildContextEntries()[0],
			m.getTree()[0].entry,
			m.buildSessionProjection().entries[0].sourceEntry,
		];
		for (const e of views) guarded(e, receipt);
		guarded(m.getLeafEntry()!, getTurnProvenance(m.getEntry(child)));
		guarded(m.getChildren(id)[0], getTurnProvenance(m.getEntry(child)));
		guarded(m.appendUsage("test", "faux", "faux", fauxAssistantMessage("x").usage), undefined);
	});

	test.each([undefined, { ...raw, payload: "p".repeat(4000) }])("cold/hot/rebound/fork/export: %j", (record) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provenance-cold-"));
		try {
			const file = join(dir, "source.jsonl");
			writeFileSync(
				file,
				`${[header, { ...historical(record), message: { role: "user", content: "x".repeat(4000), timestamp: 1 } }].map((e) => JSON.stringify(e)).join("\n")}\n`,
			);
			const m = SessionManager.open(file);
			for (let i = 0; i < 105; i++) m.appendCustomEntry("state", i);
			const compaction = m.appendCompaction("summary", null, 100);
			const cold = m.getEntry("old")!;
			expect(isColdEntry(cold)).toBe(true);
			guarded(cold, record);
			const coldReceipt = Reflect.get(cold, "provenance");
			if (record) expect(Object.isFrozen(coldReceipt.principal.nested)).toBe(true);
			m.branch("old");
			const hot = m.getEntry("old")!;
			expect(isColdEntry(hot)).toBe(false);
			guarded(hot, record);
			m.branch(compaction);
			m.appendMessage(fauxAssistantMessage("saved"));
			const fork = SessionManager.forkFrom(file, dir, dir);
			guarded(fork.getEntry("old")!, record);
			const selected = m.createBranchedSession(m.getLeafId()!)!;
			guarded(m.getEntry("old")!, record);
			guarded(SessionManager.open(selected).getEntry("old")!, record);
			const exported = serializeSessionBranch(m)
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			expect(exported.find((e) => e.id === "old").provenance).toEqual(record);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
