import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MATERIALIZED_EXPORT_BYTES, prepareExportValueForJson } from "../src/core/export-limits.ts";
import { exportSessionToJsonl, serializeSessionBranch } from "../src/core/session-export.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../src/core/session-manager.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		closeSync: vi.fn(actual.closeSync),
		// Failure cleanup is observed, never executed on local files.
		unlinkSync: vi.fn(),
		rmSync: vi.fn(),
	};
});

describe("session export serialization", () => {
	let testRoot: string;

	beforeEach(() => {
		testRoot = fs.mkdtempSync(join(tmpdir(), "pi-session-export-serialization-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		const actualFs = await vi.importActual<typeof fs>("node:fs");
		actualFs.rmSync(testRoot, { recursive: true, force: true });
		expect(actualFs.existsSync(testRoot)).toBe(false);
	});

	function directory(): string {
		return fs.mkdtempSync(join(testRoot, "case-"));
	}

	function manager(): SessionManager {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("existing", { text: "session data" });
		return sessionManager;
	}

	function trailing(toJSON: (key: string) => unknown) {
		return () => [{ type: "custom", customType: "test", toJSON }];
	}

	// #11897: JSON.stringify can return undefined for an otherwise object-shaped export entry.
	it("rejects undefined JSON serialization without replacing the destination or leaking the handle", () => {
		const sessionManager = manager();
		const undefinedEntry = trailing(() => undefined);
		const destination = join(directory(), "existing.jsonl");
		fs.writeFileSync(destination, "existing destination");
		const closeCalls = vi.mocked(fs.closeSync).mock.calls.length;
		const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.length;

		expect(() => serializeSessionBranch(sessionManager, undefinedEntry)).toThrow(
			"Session entry did not serialize to JSON",
		);
		expect(() => exportSessionToJsonl(sessionManager, destination, undefinedEntry)).toThrow(
			"Session entry did not serialize to JSON",
		);

		expect(fs.readFileSync(destination, "utf8")).toBe("existing destination");
		expect(fs.closeSync).toHaveBeenCalledTimes(closeCalls + 1);
		expect(fs.unlinkSync).toHaveBeenCalledTimes(unlinkCalls + 1);
		expect(fs.unlinkSync).toHaveBeenLastCalledWith(expect.stringMatching(/existing\.jsonl\..*\.tmp$/));
	});

	// #11897 / pi#242: bound hook results before stringify or Buffer allocation, including nested hooks.
	it.each(["entry", "nested"])("rejects an oversized %s toJSON result before serialization", (position) => {
		const sessionManager = manager();
		const oversized = "x".repeat(MAX_MATERIALIZED_EXPORT_BYTES + 1);
		const toJSON = vi.fn(() => oversized);
		const entries = position === "entry" ? trailing(toJSON) : () => [{ type: "custom", data: { toJSON } }];
		const destination = join(directory(), "existing.jsonl");
		fs.writeFileSync(destination, "existing destination");
		const closeCalls = vi.mocked(fs.closeSync).mock.calls.length;
		const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.length;
		const stringify = vi.spyOn(JSON, "stringify");
		const bufferFrom = vi.spyOn(Buffer, "from");

		expect(() => serializeSessionBranch(sessionManager, entries)).toThrow(/64 MiB/);
		expect(() => exportSessionToJsonl(sessionManager, destination, entries)).toThrow(/64 MiB/);

		expect(toJSON).toHaveBeenCalledTimes(2);
		expect(toJSON).toHaveBeenNthCalledWith(1, position === "entry" ? "" : "data");
		expect(toJSON).toHaveBeenNthCalledWith(2, position === "entry" ? "" : "data");
		// Only the header and existing entry reached stringify; neither hook-containing entry did.
		expect(stringify).toHaveBeenCalledTimes(4);
		expect(
			stringify.mock.calls.every(([value]) => {
				const entry = value as { type: string; customType?: string };
				return entry.type === "session" || entry.customType === "existing";
			}),
		).toBe(true);
		expect(bufferFrom.mock.calls.every(([value]) => value !== oversized)).toBe(true);
		expect(fs.readFileSync(destination, "utf8")).toBe("existing destination");
		expect(fs.closeSync).toHaveBeenCalledTimes(closeCalls + 1);
		expect(fs.unlinkSync).toHaveBeenCalledTimes(unlinkCalls + 1);
		expect(fs.unlinkSync).toHaveBeenLastCalledWith(expect.stringMatching(/existing\.jsonl\..*\.tmp$/));
	});

	// #11897 / pi#242: a second call could change a previously checked small result into an oversized one.
	it.each(["string", "JSONL"])("serializes checked stateful hooks exactly once for %s export", (format) => {
		const sessionManager = manager();
		const returnedHook = vi.fn(() => {
			throw new Error("returned object's toJSON must not run at the same position");
		});
		let nestedCalls = 0;
		const nestedHook = vi.fn((key: string) => {
			expect(key).toBe("payload");
			if (++nestedCalls > 1) return "x".repeat(MAX_MATERIALIZED_EXPORT_BYTES + 1);
			return { text: "nested", toJSON: returnedHook };
		});
		const arrayHook = vi.fn((key: string) => ({ index: key }));
		const readValue = vi.fn(() => "read once");
		let rootCalls = 0;
		const toJSON = vi.fn((key: string) => {
			expect(key).toBe("");
			if (++rootCalls > 1) return "x".repeat(MAX_MATERIALIZED_EXPORT_BYTES + 1);
			return {
				type: "custom",
				payload: { toJSON: nestedHook },
				items: [{ toJSON: arrayHook }, undefined, () => "ignored", Symbol("ignored")],
				date: new Date("2026-01-01T00:00:00.000Z"),
				get value() {
					return readValue();
				},
				ignored: undefined,
				toJSON: returnedHook,
			};
		});
		const entries = trailing(toJSON);
		const serialized =
			format === "string"
				? serializeSessionBranch(sessionManager, entries)
				: fs.readFileSync(exportSessionToJsonl(sessionManager, join(directory(), "valid.jsonl"), entries), "utf8");

		expect(JSON.parse(serialized.trim().split("\n").at(-1)!)).toEqual({
			type: "custom",
			payload: { text: "nested" },
			items: [{ index: "0" }, null, null, null],
			date: "2026-01-01T00:00:00.000Z",
			value: "read once",
		});
		expect(toJSON).toHaveBeenCalledTimes(1);
		expect(nestedHook).toHaveBeenCalledTimes(1);
		expect(arrayHook).toHaveBeenCalledTimes(1);
		expect(arrayHook).toHaveBeenCalledWith("0");
		expect(readValue).toHaveBeenCalledTimes(1);
		expect(returnedHook).not.toHaveBeenCalled();
	});

	// #11897 / pi#242: Buffer#toJSON must not allocate its per-byte array before the guard rejects it.
	it("rejects an oversized Buffer before invoking its toJSON in either export path", () => {
		const sessionManager = manager();
		const buffer = Buffer.alloc(MAX_MATERIALIZED_EXPORT_BYTES);
		const entries = () => [{ type: "custom", data: buffer }];
		const destination = join(directory(), "existing.jsonl");
		fs.writeFileSync(destination, "existing destination");
		const toJSON = vi.spyOn(Buffer.prototype, "toJSON");

		expect(() => serializeSessionBranch(sessionManager, entries)).toThrow(/64 MiB/);
		expect(() => exportSessionToJsonl(sessionManager, destination, entries)).toThrow(/64 MiB/);

		expect(toJSON).not.toHaveBeenCalled();
		expect(fs.readFileSync(destination, "utf8")).toBe("existing destination");
	});

	// #11897 / pi#242: every binary class is charged by its intrinsic byte length, not a hook/own getter.
	it.each([
		{ name: "Buffer", create: () => Buffer.alloc(256) },
		{ name: "ArrayBuffer", create: () => new ArrayBuffer(256) },
		{ name: "SharedArrayBuffer", create: () => new SharedArrayBuffer(256) },
		{ name: "DataView", create: () => new DataView(new ArrayBuffer(256)) },
		{ name: "Int8Array", create: () => new Int8Array(256) },
		{ name: "Uint8Array", create: () => new Uint8Array(256) },
		{ name: "Uint8ClampedArray", create: () => new Uint8ClampedArray(256) },
		{ name: "Int16Array", create: () => new Int16Array(128) },
		{ name: "Uint16Array", create: () => new Uint16Array(128) },
		{ name: "Int32Array", create: () => new Int32Array(64) },
		{ name: "Uint32Array", create: () => new Uint32Array(64) },
		{ name: "Float32Array", create: () => new Float32Array(64) },
		{ name: "Float64Array", create: () => new Float64Array(32) },
		{ name: "BigInt64Array", create: () => new BigInt64Array(32) },
		{ name: "BigUint64Array", create: () => new BigUint64Array(32) },
	])("rejects oversized $name before consulting hooks or a shadowed byteLength", ({ create }) => {
		const value = create();
		const toJSON = vi.fn(() => "small hook result");
		const byteLength = vi.fn(() => 0);
		Object.defineProperties(value, { toJSON: { value: toJSON }, byteLength: { get: byteLength } });

		expect(() => prepareExportValueForJson(value, "JSONL entry", 512)).toThrow(/64 MiB/);
		expect(toJSON).not.toHaveBeenCalled();
		expect(byteLength).not.toHaveBeenCalled();
	});

	// #11897 / pi#242: binary returned by an ordinary hook is charged before walking its properties.
	it("rejects an oversized binary hook result without reading its properties or calling its hook", () => {
		const value = new ArrayBuffer(256);
		const returnedHook = vi.fn(() => "not called at this position");
		const readValue = vi.fn(() => "not read");
		Object.defineProperties(value, {
			toJSON: { value: returnedHook },
			payload: { enumerable: true, get: readValue },
		});
		const toJSON = vi.fn(() => value);

		expect(() => prepareExportValueForJson({ toJSON }, "JSONL entry", 512)).toThrow(/64 MiB/);
		expect(toJSON).toHaveBeenCalledTimes(1);
		expect(returnedHook).not.toHaveBeenCalled();
		expect(readValue).not.toHaveBeenCalled();
	});

	// #11897 / pi#242: reject a wide object without first materializing its entire Object.keys list.
	it("stops charging a wide object early without calling Object.keys on it in either export path", () => {
		const sessionManager = manager();
		const wide: Record<string, unknown> = Object.create({ inherited: "not exported" });
		const keyCount = 100_000;
		const prefix = "x".repeat(128);
		let reads = 0;
		for (let i = 0; i < keyCount; i++) {
			Object.defineProperty(wide, `${prefix}${i}`, {
				enumerable: true,
				get: () => ++reads,
			});
		}
		const entries = () => [{ type: "custom", data: wide }];
		const destination = join(directory(), "existing.jsonl");
		fs.writeFileSync(destination, "existing destination");
		const keys = vi.spyOn(Object, "keys");

		expect(() => serializeSessionBranch(sessionManager, entries)).toThrow(/64 MiB/);
		const stringReads = reads;
		reads = 0;
		expect(() => exportSessionToJsonl(sessionManager, destination, entries)).toThrow(/64 MiB/);
		const enumeratedWide = keys.mock.calls.some(([value]) => value === wide);
		keys.mockRestore();

		expect(enumeratedWide).toBe(false);
		expect(stringReads).toBeGreaterThan(0);
		expect(stringReads).toBeLessThan(keyCount);
		expect(reads).toBeGreaterThan(0);
		expect(reads).toBeLessThan(keyCount);
		expect(fs.readFileSync(destination, "utf8")).toBe("existing destination");
	});

	// #11897 / pi#242: the binary/key guards must preserve ordinary small-session output bytes.
	it("exports a small session byte-identically to native JSON serialization", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const sessionManager = manager();
			const entry = sessionManager.getEntry(sessionManager.getLeafId()!)!;
			const custom = {
				type: "custom",
				data: {
					buffer: Buffer.from([0, 127, 255]),
					bytes: new Uint8Array([0, 127, 255]),
					floats: new Float64Array([1.5, -2.25]),
					arrayBuffer: new ArrayBuffer(8),
					view: new DataView(new ArrayBuffer(8)),
					text: 'multilingual: café 日本語; escaped: "\\\n',
					date: new Date("2025-12-31T12:00:00.000Z"),
					items: [1, undefined, { value: true }],
					ignored: undefined,
					__proto__: { inherited: "not exported" },
				},
			};
			const header = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: sessionManager.getSessionId(),
				timestamp: new Date().toISOString(),
				cwd: sessionManager.getCwd(),
			};
			const expected = [header, { ...entry, parentId: null }, custom]
				.map((value) => `${JSON.stringify(value)}\n`)
				.join("");

			expect(serializeSessionBranch(sessionManager, () => [custom])).toBe(expected);
			const destination = exportSessionToJsonl(sessionManager, join(directory(), "small.jsonl"), () => [custom]);
			expect(fs.readFileSync(destination, "utf8")).toBe(expected);
		} finally {
			vi.useRealTimers();
		}
	});

	it("accepts an object whose toJSON returns a valid record", () => {
		const sessionManager = manager();
		const validEntry = trailing(() => ({ type: "custom", customType: "test", data: "valid" }));
		const serialized = serializeSessionBranch(sessionManager, validEntry);
		expect(JSON.parse(serialized.trim().split("\n").at(-1)!)).toEqual({
			type: "custom",
			customType: "test",
			data: "valid",
		});

		const destination = join(directory(), "valid.jsonl");
		exportSessionToJsonl(sessionManager, destination, validEntry);
		expect(JSON.parse(fs.readFileSync(destination, "utf8").trim().split("\n").at(-1)!)).toEqual({
			type: "custom",
			customType: "test",
			data: "valid",
		});
	});
});
