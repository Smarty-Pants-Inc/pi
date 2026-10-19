import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportFromFile, exportSessionToHtml } from "../src/core/export-html/index.ts";
import {
	MAX_MATERIALIZED_EXPORT_BYTES,
	MAX_MATERIALIZED_EXPORT_ENTRIES,
	prepareExportValueForJson,
} from "../src/core/export-limits.ts";
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

	it("preflights parsed entry count before SessionManager.open (#11897)", async () => {
		const dir = directory();
		const header = { type: "session", version: 3, id: "count", timestamp: "2026-01-01T00:00:00Z", cwd: dir };
		const entryLine = (id: number) =>
			JSON.stringify({
				type: "custom",
				id: String(id),
				parentId: id === 1 ? null : String(id - 1),
				timestamp: "2026-01-01T00:00:00Z",
				customType: "count",
				data: id,
			});
		const fileForCount = (count: number, name: string) => {
			const file = join(dir, name);
			const lines = [JSON.stringify(header), "", "not-json"];
			for (let id = 1; id <= count; id++) lines.push(entryLine(id));
			fs.writeFileSync(file, `${lines.join("\n")}\n`);
			return file;
		};

		const overLimit = fileForCount(MAX_MATERIALIZED_EXPORT_ENTRIES + 1, "over-limit.jsonl");
		const open = vi.spyOn(SessionManager, "open");
		await expect(exportFromFile(overLimit)).rejects.toThrow(/10000 entry.*use JSONL/);
		expect(open).not.toHaveBeenCalled();

		const atLimit = fileForCount(MAX_MATERIALIZED_EXPORT_ENTRIES, "at-limit.jsonl");
		const output = await exportFromFile(atLimit, { outputPath: join(dir, "at-limit.html") });
		expect(open).toHaveBeenCalledTimes(1);
		const html = fs.readFileSync(output, "utf8");
		const dataMatch = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
		expect(dataMatch).not.toBeNull();
		const data = JSON.parse(Buffer.from(dataMatch![1], "base64").toString("utf8"));
		expect(data.entries).toHaveLength(MAX_MATERIALIZED_EXPORT_ENTRIES);
	});

	// #11897: the file-entry array retains duplicates even when the ID index does not.
	it.each(["duplicate IDs", "extra headers"])("counts %s before SessionManager.open", async (kind) => {
		const dir = directory();
		const header = { type: "session", version: 3, id: "count", timestamp: "2026-01-01T00:00:00Z", cwd: dir };
		const record = kind === "extra headers" ? header : { type: "custom", id: "same", parentId: null };
		const file = join(dir, "duplicates.jsonl");
		fs.writeFileSync(
			file,
			`${JSON.stringify(header)}\n${`${JSON.stringify(record)}\n`.repeat(MAX_MATERIALIZED_EXPORT_ENTRIES + 1)}`,
		);
		const open = vi.spyOn(SessionManager, "open");
		await expect(exportFromFile(file)).rejects.toThrow(/10000 entry.*use JSONL/);
		expect(open).not.toHaveBeenCalled();
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

	it("bounds nested toJSON results after one hook and matches normal JSON serialization", () => {
		const payload = Buffer.alloc(8);
		let hookCalls = 0;
		Object.defineProperty(payload, "toJSON", {
			value: () => {
				hookCalls++;
				return "x".repeat(32);
			},
		});
		const value = { payload };
		expect(() => prepareExportValueForJson(value, "JSONL", 16)).toThrow(/materialization limit/);
		expect(hookCalls).toBe(1);

		const expected = JSON.stringify(value);
		hookCalls = 0;
		const prepared = prepareExportValueForJson(value, "JSONL", 128);
		expect(JSON.stringify(prepared)).toBe(expected);
		expect(hookCalls).toBe(1);
	});

	// #3155: a hook returning its receiver is not itself a cycle, including repeated references.
	it("matches native self-returning hooks at root, object and array positions with nested hooks once", () => {
		const hook = vi.fn(function (this: object, _key: string) {
			return this;
		});
		const nestedHook = vi.fn((key: string) => ({ key, value: "nested" }));
		const receiver = { value: "ok", nested: { toJSON: nestedHook }, toJSON: hook };
		const cases: [unknown, string[]][] = [
			[receiver, [""]],
			[{ payload: receiver }, ["payload"]],
			[[receiver], ["0"]],
			[{ first: receiver, second: receiver }, ["first", "second"]],
		];
		for (const [value, keys] of cases) {
			const expected = JSON.stringify(value);
			hook.mockClear();
			nestedHook.mockClear();
			const prepared = prepareExportValueForJson(value, "JSONL", Buffer.byteLength(expected));
			expect(JSON.stringify(prepared)).toBe(expected);
			expect(hook.mock.calls).toEqual(keys.map((key) => [key]));
			expect(nestedHook.mock.calls).toEqual(keys.map(() => ["nested"]));
		}
	});

	// #3155: native stringify still rejects a self data field after applying the hook at each occurrence.
	it("refuses actual circular self data after a receiver-returning hook", () => {
		const hook = vi.fn(function (this: object, _key: string) {
			return this;
		});
		const receiver: Record<string, unknown> = { value: "ok", toJSON: hook };
		receiver.self = receiver;
		const value = { payload: receiver };
		expect(() => JSON.stringify(value)).toThrow(/circular/);
		expect(hook.mock.calls).toEqual([["payload"], ["self"]]);
		hook.mockClear();
		expect(() => prepareExportValueForJson(value, "JSONL", 128)).toThrow(/circular session data/);
		expect(hook.mock.calls).toEqual([["payload"], ["self"]]);
	});

	// #3155: a nested hook gets the chance to remove a backreference before the native cycle check.
	it("applies a revisited ancestor's hook before checking its serialized result for cycles", () => {
		let calls = 0;
		const hook = vi.fn(function (this: object, _key: string): unknown {
			return ++calls === 1 ? this : "finished";
		});
		const receiver: Record<string, unknown> = { toJSON: hook };
		receiver.self = receiver;
		const value = { payload: receiver };
		const expected = JSON.stringify(value);
		calls = 0;
		hook.mockClear();
		expect(JSON.stringify(prepareExportValueForJson(value, "JSONL", 128))).toBe(expected);
		expect(hook.mock.calls).toEqual([["payload"], ["self"]]);
	});

	// #3155: tiny exact-output budgets cover both acceptance and bounded oversized self-return refusal.
	it("charges a self-returning receiver's exact output bytes before stringify", () => {
		const hook = vi.fn(function (this: object, _key: string) {
			return this;
		});
		const value = { payload: { text: '雪\n"', toJSON: hook } };
		const expected = JSON.stringify(value);
		const bytes = Buffer.byteLength(expected);
		hook.mockClear();
		expect(JSON.stringify(prepareExportValueForJson(value, "JSONL", bytes))).toBe(expected);
		expect(hook.mock.calls).toEqual([["payload"]]);
		hook.mockClear();
		const stringify = vi.spyOn(JSON, "stringify");
		expect(() => prepareExportValueForJson(value, "JSONL", bytes - 1)).toThrow(/materialization limit/);
		expect(hook.mock.calls).toEqual([["payload"]]);
		expect(stringify).not.toHaveBeenCalled();
	});

	// #3155: allowing self-return must not cause serialized accessors to execute.
	it("rejects an accessor on a self-returning receiver without invoking it", () => {
		const hook = vi.fn(function (this: object, _key: string) {
			return this;
		});
		const read = vi.fn(() => "must not read");
		const value = Object.defineProperty({ toJSON: hook }, "field", { enumerable: true, get: read });
		expect(() => prepareExportValueForJson({ payload: value }, "JSONL", 128)).toThrow(/an accessor property/);
		expect(hook.mock.calls).toEqual([["payload"]]);
		expect(read).not.toHaveBeenCalled();
	});

	// #289/#291: append owns the hook's wire result; later caller cycles cannot poison history.
	it.each(["string", "streaming"] as const)("exports owned self-return data through %s JSONL", (format) => {
		const sm = SessionManager.inMemory();
		const hook = vi.fn(function (this: object, _key: string) {
			return this;
		});
		const receiver: Record<string, unknown> = { value: "ok", toJSON: hook };
		const id = sm.appendCustomEntry("self-return", { payload: receiver });
		expect(hook.mock.calls).toEqual([["payload"]]);
		const native = sm.getEntry(id);
		if (native?.type !== "custom") throw new Error("missing owned entry");
		const owned = native.data as { payload: { value: string } };
		expect(owned.payload).not.toBe(receiver);
		expect(Object.isFrozen(owned.payload)).toBe(true);
		expect(Object.isFrozen(receiver)).toBe(false);
		const revision = sm.revision();
		hook.mockClear();
		const outputPath = join(directory(), "self-return.jsonl");
		const serialized =
			format === "string"
				? serializeSessionBranch(sm)
				: fs.readFileSync(exportSessionToJsonl(sm, outputPath), "utf8");
		const entry = JSON.parse(serialized.trimEnd().split("\n").at(-1)!) as { data: unknown };
		expect(entry.data).toEqual({ payload: { value: "ok" } });
		receiver.value = "caller edit";
		receiver.self = receiver;
		const later =
			format === "string"
				? serializeSessionBranch(sm)
				: fs.readFileSync(exportSessionToJsonl(sm, outputPath), "utf8");
		expect(JSON.parse(later.trimEnd().split("\n").at(-1)!)).toEqual(entry);
		expect(hook).not.toHaveBeenCalled();
		expect(sm.getEntry(id)).toBe(native);
		expect(native.data).toBe(owned);
		expect(owned).toEqual({ payload: { value: "ok" } });
		expect(sm.revision()).toBe(revision);
	});

	// #3155: export-only records have no ingress capture. Both real receivers must guard their hooks.
	it.each(["string", "streaming"] as const)("guards untrusted self-return hooks through %s JSONL", (format) => {
		const sm = SessionManager.inMemory();
		const hook = vi.fn(function (this: object, _key: string) {
			return this;
		});
		const receiver: Record<string, unknown> = { value: "ok", toJSON: hook };
		const trailing = (parentId: string | null, timestamp: string) => [
			{
				type: "custom",
				id: "export-only",
				parentId,
				timestamp,
				customType: "self-return",
				data: { payload: receiver },
			},
		];
		const outputPath = join(directory(), "untrusted-self-return.jsonl");
		const serialized =
			format === "string"
				? serializeSessionBranch(sm, trailing)
				: fs.readFileSync(exportSessionToJsonl(sm, outputPath, trailing), "utf8");
		const entry = JSON.parse(serialized.trimEnd().split("\n").at(-1)!) as { data: unknown };
		expect(entry.data).toEqual({ payload: { value: "ok" } });
		expect(hook.mock.calls).toEqual([["payload"]]);
		expect(receiver).toEqual({ value: "ok", toJSON: hook });
		expect(Object.isFrozen(receiver)).toBe(false);
		receiver.self = receiver;
		hook.mockClear();
		expect(() =>
			format === "string" ? serializeSessionBranch(sm, trailing) : exportSessionToJsonl(sm, outputPath, trailing),
		).toThrow(/circular session data/);
		expect(hook.mock.calls).toEqual([["payload"], ["self"]]);
		expect(receiver.self).toBe(receiver);
		expect(sm.getEntries()).toEqual([]);
		if (format === "streaming") expect(fs.readFileSync(outputPath, "utf8")).toBe(serialized);
	});

	// #291: cloneable exceptional native graphs stay owned and still reach the export cycle guard.
	it.each(["string", "streaming"] as const)("refuses an owned native cycle through %s JSONL", (format) => {
		const sm = SessionManager.inMemory();
		const caller: { values: number[]; self?: unknown } = { values: [1] };
		caller.self = caller;
		const id = sm.appendCustomEntry("native-cycle", caller);
		const native = sm.getEntry(id);
		if (native?.type !== "custom") throw new Error("missing exceptional entry");
		const owned = native.data as typeof caller;
		expect(owned).not.toBe(caller);
		expect(owned.self).toBe(owned);
		caller.values.push(2);
		expect(owned.values).toEqual([1]);
		expect(Object.isFrozen(caller)).toBe(false);
		const outputPath = join(directory(), "native-cycle.jsonl");
		fs.writeFileSync(outputPath, "existing");
		const stringify = vi.spyOn(JSON, "stringify");
		expect(() => (format === "string" ? serializeSessionBranch(sm) : exportSessionToJsonl(sm, outputPath))).toThrow(
			/circular session data/,
		);
		expect(stringify.mock.calls.every(([value]) => (value as { type: string }).type === "session")).toBe(true);
		expect(fs.readFileSync(outputPath, "utf8")).toBe("existing");
		expect(owned.self).toBe(owned);
		expect(owned.values).toEqual([1]);
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
