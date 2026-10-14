import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { MAX_MATERIALIZED_EXPORT_BYTES, prepareExportValueForJson } from "../src/core/export-limits.ts";
import { exportSessionToJsonl, serializeSessionBranch } from "../src/core/session-export.ts";
import { copyEntry, type EntryLocation, isColdEntry, toColdEntry } from "../src/core/session-lazy-entries.ts";
import { CURRENT_SESSION_VERSION, type SessionEntry, SessionManager } from "../src/core/session-manager.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		closeSync: vi.fn(actual.closeSync),
		// Deletion is observed, never executed on local files. Scratch is left for parent cleanup.
		unlinkSync: vi.fn(),
		rmSync: vi.fn(),
	};
});

/** Small budget for refusal matrices: refusal must not depend on size. */
const LIMIT = 512;

const PROXY_TRAPS = [
	"apply",
	"construct",
	"defineProperty",
	"deleteProperty",
	"get",
	"getOwnPropertyDescriptor",
	"getPrototypeOf",
	"has",
	"isExtensible",
	"ownKeys",
	"preventExtensions",
	"set",
	"setPrototypeOf",
] as const;

/** Proxy whose every trap is a spy, so a test can prove no trap ever fired. */
function spiedProxy<T extends object>(target: T): { proxy: T; spies: Mock[] } {
	const spies: Mock[] = [];
	const handler: ProxyHandler<T> = {};
	for (const trap of PROXY_TRAPS) {
		const reflect = Reflect[trap] as (...args: unknown[]) => unknown;
		const spy = vi.fn((...args: unknown[]) => reflect(...args));
		spies.push(spy);
		(handler as Record<string, unknown>)[trap] = spy;
	}
	return { proxy: new Proxy(target, handler), spies };
}

function getter(target: object, key: string): Mock {
	const spy = vi.fn(() => "read");
	Object.defineProperty(target, key, { enumerable: true, configurable: true, get: spy });
	return spy;
}

interface RefusalCase {
	name: string;
	create: () => { value: unknown; spies?: Mock[] };
}

// smarty-dev#12074: the guard accepts only plain JSON. It refuses instead of invoking hooks,
// getters or proxy traps, so untrusted entry data cannot run code or allocate during export.
const refusals: RefusalCase[] = [
	{
		name: "own callable toJSON",
		create: () => {
			const toJSON = vi.fn(() => ({}));
			return { value: { toJSON }, spies: [toJSON] };
		},
	},
	{
		name: "own toJSON getter",
		create: () => {
			const value = {};
			return { value, spies: [getter(value, "toJSON")] };
		},
	},
	{
		name: "inherited toJSON from a plain prototype",
		create: () => {
			const toJSON = vi.fn(() => ({}));
			return { value: Object.create({ toJSON }), spies: [toJSON] };
		},
	},
	{
		name: "toJSON two levels up a plain prototype chain",
		create: () => {
			const toJSON = vi.fn(() => ({}));
			return { value: Object.create(Object.create({ toJSON })), spies: [toJSON] };
		},
	},
	{
		name: "inherited toJSON getter",
		create: () => {
			const prototype = {};
			const spy = getter(prototype, "toJSON");
			return { value: Object.create(prototype), spies: [spy] };
		},
	},
	{ name: "inherited noncallable toJSON", create: () => ({ value: Object.create({ toJSON: 0 }) }) },
	{
		name: "nonenumerable toJSON value",
		create: () => {
			const toJSON = vi.fn(() => ({}));
			return { value: Object.defineProperty({ kept: 1 }, "toJSON", { value: toJSON }), spies: [toJSON] };
		},
	},
	{
		name: "nonenumerable toJSON getter",
		create: () => {
			const get = vi.fn(() => () => ({}));
			return { value: Object.defineProperty({}, "toJSON", { get }), spies: [get] };
		},
	},
	{
		name: "array with a modified local prototype",
		create: () => {
			const toJSON = vi.fn(() => []);
			const prototype = Object.create(Array.prototype, { toJSON: { value: toJSON } });
			return { value: Object.setPrototypeOf([1], prototype), spies: [toJSON] };
		},
	},
	{
		name: "array with a subclass prototype",
		create: () => ({ value: Object.setPrototypeOf([1], class List extends Array {}.prototype) }),
	},
	{
		name: "array own toJSON",
		create: () => {
			const toJSON = vi.fn(() => []);
			return { value: Object.assign([1], { toJSON }), spies: [toJSON] };
		},
	},
	{
		name: "own getter",
		create: () => {
			const value = { kept: 1 };
			return { value, spies: [getter(value, "field")] };
		},
	},
	{
		name: "setter-only accessor",
		create: () => {
			const set = vi.fn();
			return { value: Object.defineProperty({}, "field", { enumerable: true, set }), spies: [set] };
		},
	},
	{
		name: "array element getter",
		create: () => {
			const value = [1];
			return { value, spies: [getter(value, "0")] };
		},
	},
	{
		name: "object proxy",
		create: () => {
			const { proxy, spies } = spiedProxy({ text: "plain target" });
			return { value: proxy, spies };
		},
	},
	{
		name: "array proxy",
		create: () => {
			const { proxy, spies } = spiedProxy([1, 2]);
			return { value: proxy, spies };
		},
	},
	{
		name: "nested proxy",
		create: () => {
			const { proxy, spies } = spiedProxy({ text: "plain target" });
			return { value: { outer: [{ inner: proxy }] }, spies };
		},
	},
	{
		name: "revoked proxy",
		create: () => {
			const { proxy, revoke } = Proxy.revocable({}, {});
			revoke();
			return { value: proxy };
		},
	},
	{
		name: "nested revoked proxy",
		create: () => {
			const { proxy, revoke } = Proxy.revocable([], {});
			revoke();
			return { value: { outer: { list: [proxy] } } };
		},
	},
	{
		name: "proxy nested in a proxy",
		create: () => {
			const inner = spiedProxy({ text: "inner" });
			const outer = spiedProxy({ inner: inner.proxy });
			return { value: outer.proxy, spies: [...outer.spies, ...inner.spies] };
		},
	},
	{ name: "class instance", create: () => ({ value: new (class Plainish {})() }) },
	{ name: "array subclass", create: () => ({ value: new (class List extends Array {})() }) },
	{ name: "RegExp", create: () => ({ value: /x/ }) },
	{ name: "Error", create: () => ({ value: new Error("x") }) },
	{
		name: "Buffer",
		create: () => ({ value: Buffer.from([1, 2]), spies: [vi.spyOn(Buffer.prototype, "toJSON")] }),
	},
	{ name: "ArrayBuffer", create: () => ({ value: new ArrayBuffer(2) }) },
	{ name: "SharedArrayBuffer", create: () => ({ value: new SharedArrayBuffer(2) }) },
	{ name: "DataView", create: () => ({ value: new DataView(new ArrayBuffer(2)) }) },
	{ name: "Int8Array", create: () => ({ value: new Int8Array(2) }) },
	{ name: "Uint8Array", create: () => ({ value: new Uint8Array(2) }) },
	{ name: "Uint8ClampedArray", create: () => ({ value: new Uint8ClampedArray(2) }) },
	{ name: "Int16Array", create: () => ({ value: new Int16Array(2) }) },
	{ name: "Uint16Array", create: () => ({ value: new Uint16Array(2) }) },
	{ name: "Int32Array", create: () => ({ value: new Int32Array(2) }) },
	{ name: "Uint32Array", create: () => ({ value: new Uint32Array(2) }) },
	{ name: "Float32Array", create: () => ({ value: new Float32Array(2) }) },
	{ name: "Float64Array", create: () => ({ value: new Float64Array(2) }) },
	{ name: "BigInt64Array", create: () => ({ value: new BigInt64Array(2) }) },
	{ name: "BigUint64Array", create: () => ({ value: new BigUint64Array(2) }) },
	{
		name: "Date",
		create: () => ({ value: new Date(0), spies: [vi.spyOn(Date.prototype, "toJSON")] }),
	},
	{ name: "Map", create: () => ({ value: new Map([["k", "v"]]) }) },
	{ name: "Set", create: () => ({ value: new Set(["v"]) }) },
	{
		name: "function",
		create: () => {
			const fn = vi.fn();
			return { value: fn, spies: [fn] };
		},
	},
	{ name: "symbol", create: () => ({ value: Symbol("x") }) },
	{ name: "bigint", create: () => ({ value: 1n }) },
	{ name: "NaN", create: () => ({ value: Number.NaN }) },
	{ name: "Infinity", create: () => ({ value: Number.POSITIVE_INFINITY }) },
	{ name: "-Infinity", create: () => ({ value: Number.NEGATIVE_INFINITY }) },
	{ name: "boxed number", create: () => ({ value: Object(1) }) },
	{ name: "boxed string", create: () => ({ value: Object("x") }) },
	{ name: "boxed boolean", create: () => ({ value: Object(true) }) },
	{ name: "boxed bigint", create: () => ({ value: Object(1n) }) },
	{ name: "boxed symbol", create: () => ({ value: Object(Symbol("x")) }) },
];

describe("session export serialization", () => {
	let testRoot: string;

	beforeEach(() => {
		testRoot = fs.mkdtempSync(join(tmpdir(), "pi-session-export-serialization-"));
	});

	afterEach(() => {
		// No deletion here: unlinkSync/rmSync stay mocked and the parent removes the scratch root.
		vi.restoreAllMocks();
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	function directory(): string {
		return fs.mkdtempSync(join(testRoot, "case-"));
	}

	function manager(): SessionManager {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("existing", { text: "session data" });
		return sessionManager;
	}

	function lastLine(serialized: string): unknown {
		return JSON.parse(serialized.trim().split("\n").at(-1)!);
	}

	// smarty-dev#12074: one test per refused kind covers root and nested positions.
	it.each(refusals)("refuses $name at root and nested without invoking it", ({ create }) => {
		const { value, spies = [] } = create();
		const entry = { type: "custom", data: { items: [value] } };

		expect(() => prepareExportValueForJson(value, "JSONL entry", LIMIT)).toThrow(/plain JSON/);
		expect(() => prepareExportValueForJson(entry, "JSONL entry", LIMIT)).toThrow(/plain JSON/);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});

	// smarty-dev#12074: JSON ignores noncallable data-valued toJSON at every level, including
	// sealEntryProvenance's hidden locked undefined slot. Enumerable members still keep their bytes.
	it("matches native bytes for noncallable data-valued toJSON at root and nested levels", () => {
		for (const toJSON of [undefined, null, false, 0, "not a hook", { kept: 1 }, [1]]) {
			const object = { kept: true, toJSON };
			const hidden = Object.defineProperty({ kept: true }, "toJSON", { value: toJSON });
			const array = Object.assign([1, ""], { toJSON });
			for (const value of [object, hidden, array, { object, hidden, array }]) {
				const expected = JSON.stringify(value);
				const bytes = Buffer.byteLength(expected);
				expect(JSON.stringify(prepareExportValueForJson(value, "JSONL entry", bytes))).toBe(expected);
				expect(() => prepareExportValueForJson(value, "JSONL entry", bytes - 1)).toThrow(/limit/);
			}
		}
	});

	// smarty-dev#12074: allowed prototype chains can also contain noncallable data slots.
	it("ignores noncallable prototype toJSON descriptors without changing native bytes", () => {
		for (const prototype of [Object.prototype, Array.prototype]) {
			const original = Object.getOwnPropertyDescriptor(prototype, "toJSON");
			try {
				Object.defineProperty(prototype, "toJSON", { value: null, configurable: true });
				for (const value of [{ list: [1, ""] }, [undefined, { kept: 1 }]]) {
					expect(JSON.stringify(prepareExportValueForJson(value, "JSONL entry", LIMIT))).toBe(
						JSON.stringify(value),
					);
				}
			} finally {
				if (original) Object.defineProperty(prototype, "toJSON", original);
				else Reflect.deleteProperty(prototype, "toJSON");
			}
		}
	});

	// smarty-dev#12074: Decision D keeps native undefined semantics only in data slots.
	it("omits undefined object fields and writes undefined array elements as null", () => {
		const cases = [
			{ kept: 1, omitted: undefined, outer: { omitted: undefined, kept: true } },
			[undefined, 1, [undefined], { omitted: undefined, list: [undefined] }],
			{ outer: { omitted: undefined }, list: [undefined, { omitted: undefined }] },
		];
		for (const value of cases) {
			expect(JSON.stringify(prepareExportValueForJson(value, "JSONL entry", LIMIT))).toBe(JSON.stringify(value));
		}
		const omitted = { ["k".repeat(LIMIT)]: undefined };
		expect(JSON.stringify(prepareExportValueForJson(omitted, "JSONL entry", 24))).toBe("{}");
		expect(() => prepareExportValueForJson(undefined, "JSONL entry", LIMIT)).toThrow(/plain JSON/);
	});

	// smarty-dev#12074: JSON ignores object hidden/symbol keys and array non-index keys.
	it("skips nonserialized properties without reading getters and accepts hidden array data indices", () => {
		const read = vi.fn(() => "must not read");
		const value = Object.defineProperties(
			{ kept: 1 },
			{
				hiddenData: { value: new Map() },
				hiddenAccessor: { get: read },
				[Symbol("ignored")]: { enumerable: true, get: read },
			},
		);
		const array = Object.defineProperties([1], {
			"0": { value: 1, enumerable: false },
			named: { enumerable: true, get: read },
			[Symbol("ignored")]: { enumerable: true, get: read },
		});
		for (const data of [value, array, { value, array }]) {
			expect(JSON.stringify(prepareExportValueForJson(data, "JSONL entry", LIMIT))).toBe(JSON.stringify(data));
		}
		expect(read).not.toHaveBeenCalled();
		const indexRead = vi.fn(() => 1);
		const accessorArray = Object.defineProperty([1], "0", { enumerable: false, get: indexRead });
		expect(() => prepareExportValueForJson(accessorArray, "JSONL entry", LIMIT)).toThrow(/plain JSON/);
		expect(indexRead).not.toHaveBeenCalled();
	});

	// smarty-dev#12074: intrinsic kinds stay refused even with an otherwise allowed prototype.
	it.each([
		["Date", () => new Date(0)],
		["Map", () => new Map()],
		["Set", () => new Set()],
		["Buffer", () => Buffer.from([1])],
		["ArrayBuffer", () => new ArrayBuffer(1)],
		["SharedArrayBuffer", () => new SharedArrayBuffer(1)],
		["DataView", () => new DataView(new ArrayBuffer(1))],
		["Int8Array", () => new Int8Array(1)],
		["Uint8Array", () => new Uint8Array(1)],
		["Uint8ClampedArray", () => new Uint8ClampedArray(1)],
		["Int16Array", () => new Int16Array(1)],
		["Uint16Array", () => new Uint16Array(1)],
		["Int32Array", () => new Int32Array(1)],
		["Uint32Array", () => new Uint32Array(1)],
		["Float32Array", () => new Float32Array(1)],
		["Float64Array", () => new Float64Array(1)],
		["BigInt64Array", () => new BigInt64Array(1)],
		["BigUint64Array", () => new BigUint64Array(1)],
		["boxed number", () => Object(1)],
		["boxed string", () => Object("x")],
		["boxed boolean", () => Object(true)],
		["boxed bigint", () => Object(1n)],
		["boxed symbol", () => Object(Symbol("x"))],
	] satisfies [string, () => object][])("refuses re-prototyped %s without invoking hooks", (_name, create) => {
		for (const prototype of [null, Object.prototype]) {
			const value = Object.setPrototypeOf(create(), prototype);
			// Prove brand refusal independently of the hooks added below.
			expect(() => prepareExportValueForJson(value, "JSONL entry", LIMIT)).toThrow(/plain JSON/);
			expect(() => prepareExportValueForJson({ value }, "JSONL entry", LIMIT)).toThrow(/plain JSON/);
			const toJSON = vi.fn(() => ({}));
			Object.defineProperty(value, "toJSON", { value: toJSON });
			const read = getter(value, "field");
			expect(() => prepareExportValueForJson(value, "JSONL entry", LIMIT)).toThrow(/plain JSON/);
			expect(() => prepareExportValueForJson({ value }, "JSONL entry", LIMIT)).toThrow(/plain JSON/);
			expect(toJSON).not.toHaveBeenCalled();
			expect(read).not.toHaveBeenCalled();
		}
	});

	// smarty-dev#12074 ruling B: a re-prototyped RegExp or Error is an ordinary record to JSON (its
	// internal slots and hidden own data are not serialized). Default prototypes stay refused, and a
	// retained toJSON or accessor is still refused without invocation.
	it.each([
		["RegExp", () => /x/g],
		["Error", () => new Error("x")],
	] satisfies [string, () => object][])("accepts re-prototyped %s as native JSON", (_name, create) => {
		expect(() => prepareExportValueForJson(create(), "JSONL entry", LIMIT)).toThrow(/plain JSON/);
		for (const prototype of [null, Object.prototype]) {
			const value = Object.setPrototypeOf(create(), prototype);
			Object.defineProperty(value, "field", { value: [1, "a"], enumerable: true });
			for (const data of [value, { value }]) {
				expect(JSON.stringify(prepareExportValueForJson(data, "JSONL entry", LIMIT))).toBe(JSON.stringify(data));
			}
			expect(JSON.stringify(value)).toBe('{"field":[1,"a"]}');

			const hooked = Object.setPrototypeOf(create(), prototype);
			const toJSON = vi.fn(() => ({}));
			Object.defineProperty(hooked, "toJSON", { value: toJSON });
			const accessor = Object.setPrototypeOf(create(), prototype);
			const read = getter(accessor, "field");
			for (const refused of [hooked, accessor]) {
				expect(() => prepareExportValueForJson(refused, "JSONL entry", LIMIT)).toThrow(/plain JSON/);
				expect(() => prepareExportValueForJson({ refused }, "JSONL entry", LIMIT)).toThrow(/plain JSON/);
			}
			expect(toJSON).not.toHaveBeenCalled();
			expect(read).not.toHaveBeenCalled();
		}
	});

	// smarty-dev#12074: F-1 accepts allowed-prototype records without reading WeakMap internal slots.
	it("exports a re-prototyped WeakMap as plain JSON without invoking hidden getters or its original hook", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const hook = vi.fn(() => ({ unexpected: true }));
		class HookedWeakMap extends WeakMap<object, unknown> {
			toJSON() {
				return hook();
			}
		}
		const value = new HookedWeakMap([[{}, "internal slot data"]]);
		Object.setPrototypeOf(value, Object.prototype);
		const read = vi.fn(() => "must not read");
		Object.defineProperty(value, "hidden", { get: read });

		expect(JSON.stringify(prepareExportValueForJson(value, "JSONL entry", LIMIT))).toBe("{}");
		expect(JSON.stringify(value)).toBe("{}");
		const sessionManager = manager();
		const trailing = { type: "custom", customType: "boundary", data: value };
		const expected = `${serializeSessionBranch(sessionManager)}${JSON.stringify(trailing)}\n`;
		expect(serializeSessionBranch(sessionManager, () => [trailing])).toBe(expected);
		const destination = exportSessionToJsonl(sessionManager, join(directory(), "boundary.jsonl"), () => [trailing]);
		expect(fs.readFileSync(destination, "utf8")).toBe(expected);
		expect(lastLine(expected)).toEqual({ type: "custom", customType: "boundary", data: {} });
		expect(read).not.toHaveBeenCalled();
		expect(hook).not.toHaveBeenCalled();
	});

	// smarty-dev#12074: inspect hooks on the actual allowed chains, not only local prototypes.
	it.each(["callable", "getter", "setter"] as const)(
		"refuses allowed-chain %s toJSON descriptors without invocation",
		(kind) => {
			for (const prototype of [Object.prototype, Array.prototype]) {
				const original = Object.getOwnPropertyDescriptor(prototype, "toJSON");
				const hook = vi.fn(() => ({}));
				const read = vi.fn(() => hook);
				const descriptor: PropertyDescriptor =
					kind === "getter" ? { get: read } : kind === "setter" ? { set: read } : { value: hook };
				let objectError: unknown;
				let arrayError: unknown;
				let nullPrototypeJson: string | undefined;
				try {
					Object.defineProperty(prototype, "toJSON", { ...descriptor, configurable: true });
					try {
						prepareExportValueForJson(prototype === Object.prototype ? {} : [], "JSONL entry", LIMIT);
					} catch (error) {
						objectError = error;
					}
					try {
						prepareExportValueForJson([1], "JSONL entry", LIMIT);
					} catch (error) {
						arrayError = error;
					}
					nullPrototypeJson = JSON.stringify(prepareExportValueForJson(Object.create(null), "JSONL entry", LIMIT));
				} finally {
					if (original) Object.defineProperty(prototype, "toJSON", original);
					else Reflect.deleteProperty(prototype, "toJSON");
				}
				expect(objectError).toBeInstanceOf(TypeError);
				expect(arrayError).toBeInstanceOf(TypeError);
				expect(nullPrototypeJson).toBe("{}");
				expect(hook).not.toHaveBeenCalled();
				expect(read).not.toHaveBeenCalled();
			}
		},
	);

	// smarty-dev#12074: a trailing malicious entry fails both public paths without running it,
	// replacing the destination, leaking the handle or skipping temporary-file cleanup.
	it.each([
		{
			name: "toJSON",
			create: () => {
				const toJSON = vi.fn(() => undefined);
				return { entry: { type: "custom", customType: "test", toJSON }, spies: [toJSON] };
			},
		},
		{
			name: "getter",
			create: () => {
				const entry = { type: "custom", customType: "test" };
				return { entry, spies: [getter(entry, "data")] };
			},
		},
		{
			name: "proxy",
			create: () => {
				const { proxy, spies } = spiedProxy({ type: "custom", customType: "test" });
				return { entry: proxy, spies };
			},
		},
	])("rejects a trailing $name entry in both export paths without invoking it", ({ create }) => {
		const sessionManager = manager();
		const { entry, spies } = create();
		const entries = () => [entry];
		const destination = join(directory(), "existing.jsonl");
		fs.writeFileSync(destination, "existing destination");
		const closeCalls = vi.mocked(fs.closeSync).mock.calls.length;
		const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.length;

		expect(() => serializeSessionBranch(sessionManager, entries)).toThrow(/plain JSON/);
		expect(() => exportSessionToJsonl(sessionManager, destination, entries)).toThrow(/plain JSON/);

		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		expect(fs.readFileSync(destination, "utf8")).toBe("existing destination");
		expect(fs.closeSync).toHaveBeenCalledTimes(closeCalls + 1);
		expect(fs.unlinkSync).toHaveBeenCalledTimes(unlinkCalls + 1);
		expect(fs.unlinkSync).toHaveBeenLastCalledWith(expect.stringMatching(/existing\.jsonl\..*\.tmp$/));
	});

	// smarty-dev#12074: key bytes are charged one property at a time, so the descriptor walk of a
	// wide object stops after a partial walk. This checks descriptor reads and whole-object key
	// helpers only; it does not claim the engine never enumerates keys internally (for-in may).
	it("stops the descriptor walk of long keys early after a partial walk", () => {
		const wide: Record<string, string> = {};
		for (let i = 0; i < 8; i++) wide[`${String.fromCharCode(97 + i)}${"k".repeat(299)}`] = "v";
		const keys = vi.spyOn(Object, "keys");
		const entries = vi.spyOn(Object, "entries");
		const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
		const descriptor = vi.spyOn(Object, "getOwnPropertyDescriptor");
		const reflectDescriptor = vi.spyOn(Reflect, "getOwnPropertyDescriptor");

		let error: unknown;
		try {
			prepareExportValueForJson(wide, "JSONL entry", LIMIT);
		} catch (caught) {
			error = caught;
		}
		const wholeObject = [keys, entries, descriptors].some((spy) => spy.mock.calls.some(([v]) => v === wide));
		const keyReads = [...descriptor.mock.calls, ...reflectDescriptor.mock.calls].filter(
			([target, key]) => target === wide && key !== "toJSON",
		).length;
		vi.restoreAllMocks();

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/limit/);
		expect(wholeObject).toBe(false);
		// One 300-character member emits at least 307 bytes (quotes, colon, "v"), so the second
		// member exceeds the 512-byte budget under exact accounting.
		expect(keyReads).toBeGreaterThan(0);
		expect(keyReads).toBeLessThan(3);
	});

	// smarty-dev#12074 P2: the budget is the exact emitted byte count, including quotes, commas
	// and brackets, so many empty strings cannot hide behind a per-character estimate.
	it("charges exact emitted bytes for many empty strings", () => {
		const value = Array.from({ length: 100 }, () => "");
		const bytes = Buffer.byteLength(JSON.stringify(value));
		expect(bytes).toBe(301);
		expect(() => prepareExportValueForJson(value, "JSONL entry", bytes - 1)).toThrow(/limit/);
		expect(JSON.stringify(prepareExportValueForJson(value, "JSONL entry", bytes))).toBe(JSON.stringify(value));
	});

	// smarty-dev#12074 P2: exact UTF-8 bytes must include escapes, surrogate handling and members.
	it.each([
		"",
		'"\\\b\t\n\f\r\u0000',
		"é雪",
		"😀",
		"\ud800",
		"\udfff",
		"\ud800A",
		-0,
		1e21,
		{ "é\n": ["", undefined, "😀"], ignored: undefined },
	])("charges exact native bytes for %j", (value) => {
		const expected = JSON.stringify(value);
		const bytes = Buffer.byteLength(expected);
		expect(JSON.stringify(prepareExportValueForJson(value, "JSONL entry", bytes))).toBe(expected);
		expect(() => prepareExportValueForJson(value, "JSONL entry", bytes - 1)).toThrow(/limit/);
	});

	// smarty-dev#12074
	it("rejects nesting deeper than 100 levels", () => {
		let deep: unknown = "leaf";
		for (let i = 0; i < 102; i++) deep = { child: deep };

		expect(() => prepareExportValueForJson(deep, "JSONL entry")).toThrow(/limit/);
	});

	// smarty-dev#12074
	it("rejects a cycle but accepts acyclic repeated references each time they occur", () => {
		const cycle: Record<string, unknown> = { type: "custom" };
		cycle.self = { back: cycle };
		expect(() => prepareExportValueForJson(cycle, "JSONL entry")).toThrow(/circular/);
		const arrayCycle: unknown[] = [];
		arrayCycle.push([arrayCycle]);
		expect(() => prepareExportValueForJson(arrayCycle, "JSONL entry")).toThrow(/circular/);

		const shared = { text: "shared" };
		const sharedList = [shared, 1];
		const dag = { first: shared, list: [shared, { again: shared }, sharedList], more: sharedList };
		expect(JSON.stringify(prepareExportValueForJson(dag, "JSONL entry", 1024))).toBe(JSON.stringify(dag));
	});

	// smarty-dev#12074: ordinary parsed session data (a Date already stored as its string) keeps
	// the bytes native JSON.stringify writes.
	it("exports a small parsed session journal byte-identically to native JSON", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const sessionManager = manager();
		const data = JSON.parse(
			JSON.stringify({
				text: 'multilingual: café 日本語; escaped: "\\\n',
				date: new Date("2025-12-31T12:00:00.000Z"),
				items: [1, null, { value: true }, -0.5],
				nested: { empty: {}, list: [] },
			}),
		);
		sessionManager.appendCustomEntry("parsed", data);
		const leaf = sessionManager.getEntry(sessionManager.getLeafId()!)!;
		const first = sessionManager.getEntry(leaf.parentId!)!;
		const custom = { type: "custom", customType: "trailing", data };
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: sessionManager.getCwd(),
		};
		const expected = [header, { ...first, parentId: null }, { ...leaf, parentId: first.id }, custom]
			.map((value) => `${JSON.stringify(value)}\n`)
			.join("");

		expect(data.date).toBe("2025-12-31T12:00:00.000Z");
		expect(serializeSessionBranch(sessionManager, () => [custom])).toBe(expected);
		const destination = exportSessionToJsonl(sessionManager, join(directory(), "small.jsonl"), () => [custom]);
		expect(fs.readFileSync(destination, "utf8")).toBe(expected);
		expect(lastLine(expected)).toEqual(custom);
	});

	// smarty-dev#12074: share tool schemas carry hidden TypeBox data metadata, not hooks.
	it("exports a nested TypeBox trailing tool schema byte-identically in both paths", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const sessionManager = manager();
		const parameters = Type.Object({ nested: Type.Object({ text: Type.String() }) });
		const metadata = Object.getOwnPropertyDescriptor(parameters, "~kind")!;
		expect(metadata.enumerable).toBe(false);
		expect(metadata).toHaveProperty("value");
		const trailing = {
			type: "custom",
			customType: "pi.share",
			data: { tools: [{ name: "test", description: "test tool", parameters }] },
		};
		const expected = `${serializeSessionBranch(sessionManager)}${JSON.stringify(trailing)}\n`;
		expect(serializeSessionBranch(sessionManager, () => [trailing])).toBe(expected);
		const destination = exportSessionToJsonl(sessionManager, join(directory(), "typebox.jsonl"), () => [trailing]);
		expect(fs.readFileSync(destination, "utf8")).toBe(expected);
	});

	// smarty-dev#12074: the actual sealed entry's toJSON data slot is not a serializer hook.
	it("exports a sealed toJSON undefined entry byte-identically in both public paths", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const sessionManager = manager();
		const entry = sessionManager.getEntry(sessionManager.getLeafId()!)!;
		expect(Object.getOwnPropertyDescriptor(entry, "toJSON")).toEqual({
			value: undefined,
			enumerable: false,
			writable: false,
			configurable: false,
		});
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: sessionManager.getCwd(),
		};
		const expected = `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;
		expect(serializeSessionBranch(sessionManager)).toBe(expected);
		const output = exportSessionToJsonl(sessionManager, join(directory(), "sealed.jsonl"));
		expect(fs.readFileSync(output, "utf8")).toBe(expected);
	});

	// smarty-dev#12074: real HOT native entries contain optional undefined data slots.
	it("exports HOT compaction and branch summary optionals as native journal bytes in both paths", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const sessionManager = manager();
		const firstId = sessionManager.getLeafId()!;
		const compactionId = sessionManager.appendCompaction("summary", firstId, 1);
		const summaryId = sessionManager.branchWithSummary(compactionId, "branch summary");
		const entries = [firstId, compactionId, summaryId].map((id) => sessionManager.getEntry(id)!);
		for (const entry of entries.slice(1)) {
			expect(isColdEntry(entry)).toBe(false);
			for (const key of ["details", "usage", "fromHook"]) {
				expect(Object.getOwnPropertyDescriptor(entry, key)?.value).toBeUndefined();
				expect(Object.hasOwn(entry, key)).toBe(true);
			}
		}
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: sessionManager.getCwd(),
		};
		const expected = [header, ...entries.map((entry) => JSON.parse(JSON.stringify(entry)))]
			.map((entry) => `${JSON.stringify(entry)}\n`)
			.join("");
		expect(serializeSessionBranch(sessionManager)).toBe(expected);
		const destination = exportSessionToJsonl(sessionManager, join(directory(), "hot-optionals.jsonl"));
		expect(fs.readFileSync(destination, "utf8")).toBe(expected);
	});

	// smarty-dev#12074: cold entries expose large message fields as lazy accessors. Export must
	// read them as resident plain JSON (toHotEntry) instead of refusing or invoking the accessor.
	it("exports a cold message from a real disk journal in both paths without invoking its lazy accessor", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const sessionDir = directory();
		const writer = SessionManager.create(sessionDir, sessionDir);
		const messageId = writer.appendMessage({ role: "user", content: "x".repeat(2048), timestamp: 1 });
		writer.appendCustomEntry("later", { n: 1 });
		writer.appendCustomEntry("later", { n: 2 });
		const journal = writer.getSessionFile()!;
		const journalLines = fs.readFileSync(journal, "utf8").trimEnd().split("\n");
		const sessionManager = SessionManager.open(journal);
		// The real journal is small, so force the message cold at its actual byte range.
		const index = journalLines.findIndex((line) => (JSON.parse(line) as { id?: string }).id === messageId);
		const line = journalLines[index];
		const offset = journalLines.slice(0, index).reduce((sum, previous) => sum + Buffer.byteLength(previous) + 1, 0);
		const cold = toColdEntry(JSON.parse(line) as SessionEntry, {
			file: journal,
			offset,
			length: Buffer.byteLength(line),
		});
		expect(isColdEntry(cold)).toBe(true);
		const coldMessage = (cold as { message: object }).message;
		const lazy = Object.getOwnPropertyDescriptor(coldMessage, "content")!;
		expect(lazy.get).toBeTypeOf("function");
		const read = vi.fn(lazy.get!);
		Object.defineProperty(coldMessage, "content", { ...lazy, get: read });
		const getEntry = sessionManager.getEntry.bind(sessionManager);
		vi.spyOn(sessionManager, "getEntry").mockImplementation((id) => (id === messageId ? cold : getEntry(id)));

		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: sessionManager.getCwd(),
		};
		// Expected bytes come from disk, not live entries: the cold message shares coldMessage, so
		// stringifying a live entry would invoke the spied lazy accessor.
		const expected = `${[JSON.stringify(header), ...journalLines.slice(1)].join("\n")}\n`;

		expect(serializeSessionBranch(sessionManager)).toBe(expected);
		const destination = exportSessionToJsonl(sessionManager, join(directory(), "cold.jsonl"));
		expect(fs.readFileSync(destination, "utf8")).toBe(expected);
		expect(read).not.toHaveBeenCalled();

		// A branch copy patches resident primitive fields on the cold entry (copyEntry); export keeps
		// the patch while still reading lazy fields from disk instead of through the accessor.
		const patchedTimestamp = "2026-02-02T00:00:00.000Z";
		const patch = { timestamp: patchedTimestamp, ["__proto__"]: "resident data" };
		const patched = copyEntry(cold, patch as Partial<SessionEntry>);
		expect(isColdEntry(patched)).toBe(true);
		vi.mocked(sessionManager.getEntry).mockImplementation((id) => (id === messageId ? patched : getEntry(id)));
		const patchedLine = JSON.stringify({ ...JSON.parse(line), ...patch });
		const patchedExpected = expected.replace(`${line}\n`, `${patchedLine}\n`);
		expect(patchedExpected).not.toBe(expected);

		const patchedSerialized = serializeSessionBranch(sessionManager);
		expect(patchedSerialized.slice(patchedSerialized.indexOf("\n"))).toBe(
			patchedExpected.slice(patchedExpected.indexOf("\n")),
		);
		const patchedDestination = exportSessionToJsonl(sessionManager, join(directory(), "patched.jsonl"));
		const patchedFile = fs.readFileSync(patchedDestination, "utf8");
		expect(patchedFile.slice(patchedFile.indexOf("\n"))).toBe(patchedExpected.slice(patchedExpected.indexOf("\n")));
		expect(read).not.toHaveBeenCalled();
	});

	/** Real disk journal whose first message can be replaced by a cold copy at any byte range. */
	function coldJournal() {
		const sessionDir = directory();
		const writer = SessionManager.create(sessionDir, sessionDir);
		const messageId = writer.appendMessage({ role: "user", content: "x".repeat(2048), timestamp: 1 });
		writer.appendCustomEntry("later", { n: 1 });
		const journal = writer.getSessionFile()!;
		const journalLines = fs.readFileSync(journal, "utf8").trimEnd().split("\n");
		const index = journalLines.findIndex((line) => (JSON.parse(line) as { id?: string }).id === messageId);
		const line = journalLines[index];
		const offset = journalLines.slice(0, index).reduce((sum, previous) => sum + Buffer.byteLength(previous) + 1, 0);
		const sessionManager = SessionManager.open(journal);
		const getEntry = sessionManager.getEntry.bind(sessionManager);
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: sessionManager.getCwd(),
		};
		// Export bytes before the cold entry: the export header and earlier (hot) journal lines.
		const prefixBytes = [JSON.stringify(header), ...journalLines.slice(1, index)].reduce(
			(sum, previous) => sum + Buffer.byteLength(previous) + 1,
			0,
		);
		return {
			journal,
			line,
			offset,
			prefixBytes,
			sessionManager,
			cold: (location: Partial<EntryLocation> = {}) =>
				toColdEntry(JSON.parse(line) as SessionEntry, {
					file: journal,
					offset,
					length: Buffer.byteLength(line),
					...location,
				}),
			// A plain override, not a spy: spy result bookkeeping would trap a returned proxy.
			use: (entry: object) => {
				sessionManager.getEntry = (id) => (id === messageId ? (entry as SessionEntry) : getEntry(id));
			},
		};
	}

	// smarty-dev#12074: the live branch entry itself is guarded before its id, parentId or any field
	// is read, in the discovery pass and the output pass of both public paths.
	it.each([
		{ name: "id getter", mutate: (entry: object) => [getter(entry, "id")] },
		{ name: "parentId getter", mutate: (entry: object) => [getter(entry, "parentId")] },
		{ name: "data getter", mutate: (entry: object) => [getter(entry, "data")] },
		{
			name: "own toJSON",
			mutate: (entry: object) => {
				const toJSON = vi.fn(() => ({}));
				Object.defineProperty(entry, "toJSON", { value: toJSON });
				return [toJSON];
			},
		},
		{
			name: "prototype toJSON hook",
			mutate: (entry: object) => {
				const toJSON = vi.fn(() => ({}));
				Object.setPrototypeOf(entry, { toJSON });
				return [toJSON];
			},
		},
		{
			name: "prototype getter hook",
			mutate: (entry: object) => {
				const prototype = {};
				const read = getter(prototype, "hook");
				Object.setPrototypeOf(entry, prototype);
				return [read];
			},
		},
		{
			name: "nested proxy",
			mutate: (entry: object) => {
				const { proxy, spies } = spiedProxy({ text: "nested" });
				(entry as { data: unknown }).data = proxy;
				return spies;
			},
		},
		{ name: "proxy", mutate: () => [] as Mock[], wrap: true },
	])("rejects a live branch entry with $name in both paths without invoking it", ({ mutate, wrap }) => {
		const sessionManager = manager();
		sessionManager.appendCustomEntry("leaf", { text: "leaf data" });
		const leafId = sessionManager.getLeafId()!;
		const getEntry = sessionManager.getEntry.bind(sessionManager);
		const copy = JSON.parse(JSON.stringify(getEntry(leafId))) as object;
		let spies: Mock[] = mutate(copy);
		let entry = copy;
		if (wrap) ({ proxy: entry, spies } = spiedProxy(copy));
		// A plain override, not a spy: spy result bookkeeping would trap a returned proxy.
		sessionManager.getEntry = (id) => (id === leafId ? (entry as SessionEntry) : getEntry(id));
		const destination = join(directory(), "existing.jsonl");
		fs.writeFileSync(destination, "existing destination");

		expect(() => serializeSessionBranch(sessionManager)).toThrow(/plain JSON/);
		expect(() => exportSessionToJsonl(sessionManager, destination)).toThrow(/plain JSON/);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		expect(fs.readFileSync(destination, "utf8")).toBe("existing destination");
	});

	// smarty-dev#12074: a cold line is refused against the current remaining budget before the
	// file is read; the string export's aggregate remaining reaches cold rehydration.
	it("refuses an oversized cold line before allocating, reading or parsing it", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const journal = coldJournal();
		const overCeiling = journal.cold({ length: MAX_MATERIALIZED_EXPORT_BYTES + 1 });
		// Fits the per-entry ceiling but not what remains after the export header line.
		const overRemaining = journal.cold({ length: MAX_MATERIALIZED_EXPORT_BYTES - journal.prefixBytes + 1 });
		const destination = join(directory(), "cold.jsonl");
		const alloc = vi.spyOn(Buffer, "allocUnsafe");
		const parse = vi.spyOn(JSON, "parse");

		journal.use(overCeiling);
		expect(() => serializeSessionBranch(journal.sessionManager)).toThrow(/remaining export limit/);
		expect(() => exportSessionToJsonl(journal.sessionManager, destination)).toThrow(/remaining export limit/);
		journal.use(overRemaining);
		expect(() => serializeSessionBranch(journal.sessionManager)).toThrow(/remaining export limit/);
		// The streaming path has only the per-entry ceiling; the range check then refuses it.
		expect(() => exportSessionToJsonl(journal.sessionManager, destination)).toThrow(/changed on disk/);

		expect(alloc.mock.calls.some(([size]) => size >= 1024 * 1024)).toBe(false);
		expect(parse).not.toHaveBeenCalled();
		expect(fs.existsSync(destination)).toBe(false);
	});

	// smarty-dev#12074: the byte range is checked against the open file, and the line must still
	// hold the same entry.
	it("refuses a cold line whose range is invalid, past the end, truncated or changed", () => {
		const journal = coldJournal();
		const length = Buffer.byteLength(journal.line);
		const copy = join(directory(), "copy.jsonl");
		const original = fs.readFileSync(journal.journal);
		const cases: [string, Partial<EntryLocation>, () => void][] = [
			["negative offset", { offset: -1 }, () => {}],
			["fractional length", { length: length + 0.5 }, () => {}],
			["unsafe end", { offset: Number.MAX_SAFE_INTEGER, length: 2 }, () => {}],
			["past the end", { file: copy, offset: original.length - 2 }, () => fs.writeFileSync(copy, original)],
			["truncated", { file: copy }, () => fs.truncateSync(copy, journal.offset + 10)],
			[
				"changed",
				{ file: copy },
				() => {
					// Same length, different id: the range still parses but holds another entry.
					const changed = journal.line.replace(
						/"id":"(.)/,
						(_match, c: string) => `"id":"${c === "Z" ? "Y" : "Z"}`,
					);
					fs.writeFileSync(copy, original.toString("utf8").replace(journal.line, changed));
				},
			],
		];
		for (const [name, location, prepare] of cases) {
			fs.writeFileSync(copy, original);
			const cold = journal.cold(location);
			prepare();
			journal.use(cold);
			expect(() => serializeSessionBranch(journal.sessionManager), name).toThrow(/changed on disk/);
			expect(() => exportSessionToJsonl(journal.sessionManager, join(directory(), "out.jsonl")), name).toThrow(
				/changed on disk/,
			);
		}
	});

	// smarty-dev#12074: the cold marker trusts only generated lazy accessors; a cold entry mutated
	// to carry hooks, proxies or other accessors is refused rather than laundered from disk.
	it.each([
		{
			name: "non-plain prototype",
			mutate: (entry: object) => {
				const toJSON = vi.fn(() => ({}));
				Object.setPrototypeOf(entry, { toJSON });
				return { entry, spies: [toJSON] };
			},
		},
		{
			name: "own toJSON",
			mutate: (entry: object) => {
				const toJSON = vi.fn(() => ({}));
				Object.defineProperty(entry, "toJSON", { value: toJSON });
				return { entry, spies: [toJSON] };
			},
		},
		{
			name: "lazy-shaped id accessor",
			mutate: (entry: object) => {
				const get = vi.fn(() => "id");
				const set = vi.fn();
				Object.defineProperty(entry, "id", { get, set, enumerable: true, configurable: true });
				return { entry, spies: [get, set] };
			},
		},
		{
			name: "id object with a coercion hook",
			mutate: (entry: object) => {
				const coerce = vi.fn(() => "untrusted id");
				Object.defineProperty(entry, "id", { value: { toString: coerce }, configurable: true });
				return { entry, spies: [coerce] };
			},
		},
		{ name: "user getter", mutate: (entry: object) => ({ entry, spies: [getter(entry, "extra")] }) },
		{
			name: "lazy-shaped accessor absent from the line",
			mutate: (entry: object) => {
				const get = vi.fn(() => "extra");
				const set = vi.fn();
				Object.defineProperty(entry, "extra", { get, set, enumerable: true, configurable: true });
				return { entry, spies: [get, set] };
			},
		},
		{
			name: "message user getter",
			mutate: (entry: object) => ({
				entry,
				spies: [getter(Object.getOwnPropertyDescriptor(entry, "message")!.value, "extra")],
			}),
		},
		{
			name: "message proxy",
			mutate: (entry: object) => {
				const { proxy, spies } = spiedProxy({ role: "user" });
				Object.defineProperty(entry, "message", { value: proxy });
				return { entry, spies };
			},
		},
		{
			name: "proxy",
			mutate: (entry: object) => {
				const { proxy, spies } = spiedProxy(entry);
				return { entry: proxy, spies };
			},
		},
	] satisfies { name: string; mutate: (entry: object) => { entry: object; spies: Mock[] } }[])(
		"rejects a cold entry with $name in both paths without invoking it",
		({ mutate }) => {
			const journal = coldJournal();
			const cold = copyEntry(journal.cold(), {});
			expect(isColdEntry(cold)).toBe(true);
			const lazy = Object.getOwnPropertyDescriptor(
				Object.getOwnPropertyDescriptor(cold, "message")!.value as object,
				"content",
			)!;
			const read = vi.fn(lazy.get!);
			const message = Object.getOwnPropertyDescriptor(cold, "message")!.value as object;
			Object.defineProperty(message, "content", { ...lazy, get: read });
			const { entry, spies } = mutate(cold);
			journal.use(entry);

			expect(() => serializeSessionBranch(journal.sessionManager)).toThrow(/plain JSON/);
			expect(() => exportSessionToJsonl(journal.sessionManager, join(directory(), "out.jsonl"))).toThrow(
				/plain JSON/,
			);
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
			expect(read).not.toHaveBeenCalled();
		},
	);
});
