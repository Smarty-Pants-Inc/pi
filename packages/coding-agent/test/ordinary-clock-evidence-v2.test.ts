import { beforeEach, expect, test, vi } from "vitest";
import {
	type NativeClockSample,
	OriginalClockEvidence,
	projectClockNanoseconds,
} from "../src/core/ordinary-clock-evidence.ts";

// Versioned boundary definitions, NOT a PASS/waiver for legacy constructor/species
// containment. The byte-exact legacy body is preserved in packet references.
// This mocks only the fixed original native source; no production read/transition
// callback injection API exists. Node 24 AND Bun runs remain UNRUN.
const port = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/core/owner-effects.ts", () => ({ readOriginalPreparedClockSample: port.read }));
const sample: NativeClockSample = {
	monotonicNs: "9007199254740993",
	bootId: "11111111-2222-3333-4444-555555555555",
	timeNamespace: { device: "4", inode: "5" },
	pid: 6,
};
beforeEach(() => {
	port.read.mockReset();
});
function fixture(values = [0n, 7n, 8n, 9n]) {
	let reads = 0;
	port.read.mockImplementation(() => ({
		...structuredClone(sample),
		monotonicNs: String(BigInt(sample.monotonicNs) + values[reads++]),
	}));
	return new OriginalClockEvidence("10");
}

test("one original before/after ticket retains exact ns and sequence", () => {
	const source = fixture();
	const ticket = source.begin("dispatch-authorization");
	expect(port.read).toHaveBeenCalledTimes(1);
	const result = source.commit(ticket);
	expect(result.witness.before.monotonicNs).toBe("9007199254740993");
	expect(result.witness.after.monotonicNs).toBe("9007199254741000");
	expect(result.sequence).toBe("1");
	expect(Object.isFrozen(result.witness.after.timeNamespace)).toBe(true);
	expect(source.commit(source.begin("original-window-finish")).sequence).toBe("2");
});

test.each([
	[2n, 1n, "REVERSED"],
	[0n, 11n, "BRACKET_EXCEEDED"],
] as const)("%s -> %s refuses %s without resampling", (before, after, code) => {
	const source = fixture([before, after]);
	const ticket = source.begin("event");
	expect(() => source.commit(ticket)).toThrow(code);
	expect(() => source.begin("later")).toThrow(code);
	expect(port.read).toHaveBeenCalledTimes(2);
});

test("duplicate and foreign tickets refuse before a new native edge", () => {
	const source = fixture();
	const ticket = source.begin("event");
	source.commit(ticket);
	expect(() => source.checkOperation(ticket)).toThrow("OPERATION_REQUIRED");
	expect(() => source.commit({})).toThrow("OPERATION_REQUIRED");
	expect(port.read).toHaveBeenCalledTimes(2);
});

test("swallowed nested begin is sticky and prevents the original after edge", () => {
	const source = fixture();
	const ticket = source.begin("event");
	expect(() => source.begin("nested")).toThrow("REENTRY");
	expect(() => source.commit(ticket)).toThrow("REENTRY");
	expect(port.read).toHaveBeenCalledTimes(1);
});

test("original native reentry remains sticky even when the native fixture swallows it", () => {
	const source = fixture();
	port.read.mockImplementation(() => {
		try {
			source.begin("nested");
		} catch {
			/* original read port reentry modeled, not a caller API */
		}
		return sample;
	});
	expect(() => source.begin("event")).toThrow("REENTRY");
	expect(port.read).toHaveBeenCalledTimes(1);
});

test("throw undefined is a sticky first cause, not an unset failure slot", () => {
	const source = fixture();
	const ticket = source.begin("event");
	let first = false,
		later = false;
	try {
		source.fail(undefined);
	} catch (cause) {
		first = true;
		expect(cause).toBeUndefined();
	}
	try {
		source.fail(new Error("later"));
	} catch (cause) {
		later = true;
		expect(cause).toBeUndefined();
	}
	expect(first && later).toBe(true);
	let committed = false;
	try {
		source.commit(ticket);
		committed = true;
	} catch (cause) {
		expect(cause).toBeUndefined();
	}
	expect(committed).toBe(false);
	expect(port.read).toHaveBeenCalledTimes(1);
});

test.each(["boot", "namespace", "pid"] as const)("%s replacement cannot start a fresh identity", (kind) => {
	const source = fixture();
	const ticket = source.begin("event");
	const changed = structuredClone(sample);
	if (kind === "boot") changed.bootId = "22222222-2222-3333-4444-555555555555";
	if (kind === "namespace") changed.timeNamespace.inode = "7";
	if (kind === "pid") changed.pid++;
	port.read.mockReturnValue(changed);
	expect(() => source.commit(ticket)).toThrow("IDENTITY_CHANGED");
});

test.each(["constructor", "species"] as const)("legacy %s supplier is never invoked by the revised API", (property) => {
	const source = fixture();
	const unsupported = vi.fn(() => {
		const rejected = Promise.reject(new Error("must never be created"));
		const descriptor = {
			configurable: false,
			get() {
				throw new Error("attachment getter failure");
			},
		};
		if (property === "constructor") Object.defineProperty(rejected, "constructor", descriptor);
		else
			Object.defineProperty(rejected, "constructor", {
				value: Object.defineProperty({}, Symbol.species, descriptor),
				configurable: false,
			});
		return rejected;
	});
	expect(Reflect.get(source, "capture")).toBeUndefined();
	expect(() => Reflect.apply(Reflect.get(source, "capture"), source, ["event", unsupported])).toThrow(TypeError);
	expect(unsupported).not.toHaveBeenCalled();
	expect(port.read).not.toHaveBeenCalled();
});

test.each([
	["0", "0"],
	["1000000", "0"],
	["1000001", "1"],
	["99999999999999999999", "1"],
])("projection %s keeps original integer and error bound", (ns, error) => {
	const projected = projectClockNanoseconds(ns);
	expect(projected.monotonicNs).toBe(ns);
	expect(projected.conversionErrorNs).toBe(error);
});
