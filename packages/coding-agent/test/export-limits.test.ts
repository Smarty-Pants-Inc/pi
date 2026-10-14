import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportFromFile, exportSessionToHtml } from "../src/core/export-html/index.ts";
import { MAX_MATERIALIZED_EXPORT_BYTES, MAX_MATERIALIZED_EXPORT_ENTRIES } from "../src/core/export-limits.ts";
import { exportSessionToJsonl, serializeSessionBranch } from "../src/core/session-export.ts";
import { type FileEntry, SessionManager } from "../src/core/session-manager.ts";

const writeBehavior = vi.hoisted(() => ({ maxBytes: Number.POSITIVE_INFINITY, fail: false, zero: false }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		writeSync: vi.fn((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number) => {
			if (writeBehavior.fail) throw new Error("disk full");
			if (writeBehavior.zero) return 0;
			return actual.writeSync(fd, buffer, offset, Math.min(length, writeBehavior.maxBytes));
		}),
		closeSync: vi.fn(actual.closeSync),
		// Export failure cleanup is observed, never executed on local files.
		unlinkSync: vi.fn(),
		rmSync: vi.fn(),
	};
});

// #11897: keep these boundary/failure tests because real oversized exports can exhaust the process heap.
describe("bounded session exports (#11897)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		writeBehavior.maxBytes = Number.POSITIVE_INFINITY;
		writeBehavior.fail = false;
		writeBehavior.zero = false;
	});

	function directory(): string {
		return fs.mkdtempSync(join(tmpdir(), "pi-export-limits-"));
	}

	function oversizedFile(dir: string): string {
		const file = join(dir, "large.jsonl");
		const fd = fs.openSync(file, "wx");
		try {
			fs.ftruncateSync(fd, MAX_MATERIALIZED_EXPORT_BYTES + 1);
		} finally {
			fs.closeSync(fd);
		}
		return file;
	}

	function manager(): SessionManager {
		const sm = SessionManager.inMemory();
		sm.appendCustomEntry("first", { text: "hello <world> 雪" });
		sm.appendCustomEntry("last", { text: "second" });
		return sm;
	}

	it("refuses a large current file before entries, branch reads or custom rendering", async () => {
		const sm = manager();
		vi.spyOn(sm, "getSessionFile").mockReturnValue(oversizedFile(directory()));
		const entries = vi.spyOn(sm, "getEntries");
		const entry = vi.spyOn(sm, "getEntry");
		const branch = vi.spyOn(sm, "getBranch");
		const renderCall = vi.fn();
		const renderResult = vi.fn();
		await expect(exportSessionToHtml(sm, undefined, { toolRenderer: { renderCall, renderResult } })).rejects.toThrow(
			/64 MiB.*use JSONL/,
		);
		expect(() => serializeSessionBranch(sm)).toThrow(/64 MiB.*use JSONL/);
		expect(() => exportSessionToJsonl(sm, join(directory(), "output.jsonl"))).toThrow(/64 MiB/);
		expect(entries).not.toHaveBeenCalled();
		expect(entry).not.toHaveBeenCalled();
		expect(branch).not.toHaveBeenCalled();
		expect(renderCall).not.toHaveBeenCalled();
		expect(renderResult).not.toHaveBeenCalled();
	});

	it("refuses a large input file before SessionManager.open", async () => {
		const open = vi.spyOn(SessionManager, "open");
		await expect(exportFromFile(oversizedFile(directory()))).rejects.toThrow(/64 MiB.*use JSONL/);
		expect(open).not.toHaveBeenCalled();
	});

	it("guards entry count before history materialization for string exports", () => {
		const sm = manager();
		vi.spyOn(sm, "getEntryCount").mockReturnValue(MAX_MATERIALIZED_EXPORT_ENTRIES + 1);
		const entry = vi.spyOn(sm, "getEntry");
		const branch = vi.spyOn(sm, "getBranch");
		expect(() => serializeSessionBranch(sm)).toThrow(/10000 entry.*use JSONL/);
		expect(entry).not.toHaveBeenCalled();
		expect(branch).not.toHaveBeenCalled();
	});

	it("preflights a single huge unsaved entry before stringify", () => {
		const sm = SessionManager.inMemory();
		sm.appendCustomEntry("large", "x".repeat(MAX_MATERIALIZED_EXPORT_BYTES));
		const stringify = vi.spyOn(JSON, "stringify");
		expect(() => serializeSessionBranch(sm)).toThrow(/64 MiB/);
		expect(() => exportSessionToJsonl(sm, join(directory(), "huge.jsonl"))).toThrow(/64 MiB/);
		// Only the tiny header may be stringified, never the oversized entry.
		expect(stringify.mock.calls.every(([value]) => (value as { type: string }).type === "session")).toBe(true);
	});

	it("preflights oversized live payloads before HTML custom rendering or stringify", async () => {
		const sm = SessionManager.inMemory();
		sm.appendCustomEntry("large", "x".repeat(MAX_MATERIALIZED_EXPORT_BYTES));
		const file = join(directory(), "small.jsonl");
		fs.writeFileSync(file, "{}\n");
		vi.spyOn(sm, "getSessionFile").mockReturnValue(file);
		const renderCall = vi.fn();
		const renderResult = vi.fn();
		const stringify = vi.spyOn(JSON, "stringify");
		await expect(exportSessionToHtml(sm, undefined, { toolRenderer: { renderCall, renderResult } })).rejects.toThrow(
			/64 MiB.*use JSONL/,
		);
		expect(renderCall).not.toHaveBeenCalled();
		expect(renderResult).not.toHaveBeenCalled();
		expect(stringify).not.toHaveBeenCalled();
	});

	it("caps aggregate string output incrementally without stringifying the next oversized contribution", () => {
		const sm = SessionManager.inMemory();
		const payload = "x".repeat(1024 * 1024);
		for (let i = 0; i < 70; i++) sm.appendCustomEntry("chunk", payload);
		const stringify = vi.spyOn(JSON, "stringify");
		expect(() => serializeSessionBranch(sm)).toThrow(/64 MiB/);
		expect(stringify.mock.calls.length).toBeLessThan(65);
		const branch = vi.spyOn(sm, "getBranch");
		const output = exportSessionToJsonl(sm, join(directory(), "large-stream.jsonl"));
		expect(fs.statSync(output).size).toBeGreaterThan(MAX_MATERIALIZED_EXPORT_BYTES);
		expect(branch).not.toHaveBeenCalled();
	});

	it("streams normal/trailing records with partial UTF-8 writes and unchanged links", () => {
		const sm = manager();
		const first = sm.getEntries()[0].id;
		sm.branch(first);
		const last = sm.appendCustomEntry("selected", { text: "selected 雪" });
		const trailing = (parentId: string | null, timestamp: string) => [
			{ type: "custom", id: "share", parentId, timestamp, customType: "pi.share", data: { title: "example" } },
		];
		const expected = serializeSessionBranch(sm, trailing);
		const branch = vi.spyOn(sm, "getBranch").mockImplementation(() => {
			throw new Error("whole branch must not be materialized");
		});
		writeBehavior.maxBytes = 7;
		const path = exportSessionToJsonl(sm, join(directory(), "stream.jsonl"), trailing);
		const actual = fs.readFileSync(path, "utf8");
		const records = actual
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const expectedRecords = expected
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		// Header/trailing timestamps are export-time values; everything else must match.
		for (const record of [records[0], records.at(-1)!]) record.timestamp = "export-time";
		for (const record of [expectedRecords[0], expectedRecords.at(-1)!]) record.timestamp = "export-time";
		expect(records).toEqual(expectedRecords);
		expect(records.slice(1).map((record) => record.parentId)).toEqual([null, first, last]);
		expect(actual.endsWith("\n")).toBe(true);
		expect(branch).not.toHaveBeenCalled();
	});

	// #11897: streaming's atomic replacement must not make a private existing export public.
	it.skipIf(process.platform === "win32")(
		"preserves private permissions when replacing an existing destination",
		() => {
			const destination = join(directory(), "private.jsonl");
			fs.writeFileSync(destination, "existing", { mode: 0o600 });
			exportSessionToJsonl(manager(), destination);
			expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
			expect(fs.readFileSync(destination, "utf8")).toContain("hello <world>");
		},
	);

	it("closes the handle on a failed write and preserves an existing destination", () => {
		const dir = directory();
		const destination = join(dir, "existing.jsonl");
		fs.writeFileSync(destination, "existing");
		writeBehavior.fail = true;
		const closeCalls = vi.mocked(fs.closeSync).mock.calls.length;
		const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.length;
		expect(() => exportSessionToJsonl(manager(), destination)).toThrow("disk full");
		expect(fs.closeSync).toHaveBeenCalledTimes(closeCalls + 1);
		expect(fs.readFileSync(destination, "utf8")).toBe("existing");
		expect(fs.unlinkSync).toHaveBeenCalledTimes(unlinkCalls + 1);
		expect(fs.unlinkSync).toHaveBeenLastCalledWith(expect.stringMatching(/existing\.jsonl\..*\.tmp$/));
	});

	it("fails rather than looping on zero-byte writes", () => {
		writeBehavior.zero = true;
		expect(() => exportSessionToJsonl(manager(), join(directory(), "zero.jsonl"))).toThrow("no progress");
	});

	it("keeps valid HTML session data unchanged through both entry points", async () => {
		const dir = directory();
		const input = exportSessionToJsonl(manager(), join(dir, "valid.jsonl"));
		const sm = SessionManager.open(input);
		const tui = await exportSessionToHtml(sm, undefined, { outputPath: join(dir, "tui.html"), themeName: "dark" });
		const cli = await exportFromFile(input, { outputPath: join(dir, "cli.html"), themeName: "dark" });
		const html = fs.readFileSync(tui, "utf8");
		expect(html).toBe(fs.readFileSync(cli, "utf8"));
		const dataMatch = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
		expect(dataMatch).not.toBeNull();
		const data = JSON.parse(Buffer.from(dataMatch![1], "base64").toString("utf8"));
		expect(data).toEqual({ header: sm.getHeader(), entries: sm.getEntries(), leafId: sm.getLeafId() });
	});

	it("can replace its own cold-entry source without truncating it early", () => {
		const dir = directory();
		const file = join(dir, "cold.jsonl");
		const entries: FileEntry[] = [
			{ type: "session", version: 3, id: "cold", timestamp: "2026-01-01T00:00:00Z", cwd: dir },
		];
		for (let i = 0; i < 110; i++)
			entries.push({
				type: "custom",
				id: String(i),
				parentId: i ? String(i - 1) : null,
				timestamp: "2026-01-01T00:00:00Z",
				customType: "cold",
				data: "x".repeat(2048),
			});
		fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const sm = SessionManager.open(file);
		exportSessionToJsonl(sm, file);
		expect(SessionManager.open(file).getEntries()).toEqual(entries.slice(1));
	});
});
