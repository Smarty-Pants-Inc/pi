import { describe, expect, test } from "vitest";
import {
	type NativeClockSample,
	OriginalClockEvidence,
	projectClockNanoseconds,
} from "../src/core/ordinary-clock-evidence.ts";

const original: NativeClockSample = {
	monotonicNs: "9007199254740993",
	bootId: "11111111-2222-3333-4444-555555555555",
	timeNamespace: { device: "4", inode: "5" },
	pid: 6,
};
function fixture(values = [0n, 7n, 8n, 9n]) {
	let reads = 0;
	const events: string[] = [];
	const source = new OriginalClockEvidence(() => {
		events.push("native-read");
		return { ...structuredClone(original), monotonicNs: String(BigInt(original.monotonicNs) + values[reads++]) };
	}, "10");
	return { source, events, reads: () => reads };
}

describe("original native clock evidence: inert read port, no native execution", () => {
	test.each([
		["0", "0"],
		["1000000", "0"],
		["1000001", "1"],
		["99999999999999999999", "1"],
	])("display projection %s retains ns and reports actual upward-rounded binary error", (ns, error) => {
		const projected = projectClockNanoseconds(ns);
		expect(projected.monotonicNs).toBe(ns);
		expect(projected.monotonicMs).toBe(Number(ns) / 1_000_000);
		expect(projected.conversionErrorNs).toBe(error);
	});
	test("retains exact ns beyond Number precision and brackets original synchronous transition", () => {
		const f = fixture();
		const local = { monotonicMs: 0.125, wallMs: 42 };
		const first = f.source.capture("dispatch-authorized", () => {
			f.events.push("original-transition");
			return local;
		});
		expect(f.events).toEqual(["native-read", "original-transition", "native-read"]);
		expect(first.value).toBe(local);
		expect(first.witness.after.monotonicNs).toBe("9007199254741000");
		expect(first.witness.before.monotonicNs).toBe("9007199254740993");
		expect(first.eventMeaning).toBe("dispatch-authorized");
		expect(first.sequence).toBe("1");
		expect(() => { first.witness.after.timeNamespace.inode = "999"; }).toThrow(TypeError);
		expect(Object.isFrozen(first.witness)).toBe(true);
		expect(f.source.capture("window-end", () => 1).sequence).toBe("2");
	});
	test.each([
		[2n, 1n, "REVERSED"],
		[0n, 11n, "BRACKET_EXCEEDED"],
	] as const)("refuses %s -> %s with %s", (before, after, code) => {
		const f = fixture([before, after]);
		expect(() => f.source.capture("event", () => undefined)).toThrow(code);
		expect(() => f.source.capture("event", () => undefined)).toThrow(code);
		expect(f.reads()).toBe(2);
	});
	test("swallowed nested capture poisons original call before an additional read", () => {
		const f = fixture();
		let error: unknown;
		expect(() =>
			f.source.capture("event", () => {
				try {
					f.source.capture("nested", () => undefined);
				} catch (cause) {
					error = cause;
				}
			}),
		).toThrow("REENTRY");
		expect(() => f.source.check()).toThrow(error as Error);
		expect(f.reads()).toBe(1);
	});
	test("read callback reentry swallowed by the port is sticky", () => {
		const source = new OriginalClockEvidence(() => {
			try {
				source.capture("nested", () => undefined);
			} catch {
				/* modeled hostile port */
			}
			return original;
		}, "10");
		expect(() => source.capture("event", () => undefined)).toThrow("REENTRY");
	});
	test("throw/async after-edge cannot become a completed witness", async () => {
		const f = fixture();
		const failure = new Error("original transition failed");
		expect(() =>
			f.source.capture("event", () => {
				throw failure;
			}),
		).toThrow(failure);
		expect(f.reads()).toBe(1);
		const asyncSource = fixture();
		let settled = false;
		expect(() =>
			asyncSource.source.capture("event", () =>
				Promise.resolve().then(() => {
					settled = true;
				}),
			),
		).toThrow("ASYNC_TRANSITION");
		await Promise.resolve();
		expect(settled).toBe(true);
		expect(() => asyncSource.source.capture("late-completion", () => undefined)).toThrow("ASYNC_TRANSITION");
		expect(asyncSource.reads()).toBe(1);
	});
	test.each(["immediate", "delayed"])("contains %s rejected transition without an after-edge", async (mode) => {
		const f = fixture();
		const rejected = new Error("forbidden asynchronous rejection");
		let refusal: unknown;
		try {
			f.source.capture("event", () => {
				if (mode === "immediate") return Promise.reject(rejected);
				return Promise.resolve().then(() => { throw rejected; });
			});
		} catch (cause) {
			refusal = cause;
		}
		expect(refusal).toBeInstanceOf(Error);
		expect((refusal as Error).message).toContain("ASYNC_TRANSITION");
		// Do not attach a test-side handler to the forbidden Promise. Vitest must
		// see any leaked rejection; yield a full turn, not just one microtask.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(() => f.source.capture("late-completion", () => undefined)).toThrow(refusal as Error);
		expect(f.reads()).toBe(1);
	});
	test.each(["throw", "noncallable"])("contains native rejection with %s own then", async (poison) => {
		const f = fixture();
		let accesses = 0;
		expect(() => f.source.capture("event", () => {
			const rejected = Promise.reject(new Error("original native rejection"));
			Object.defineProperty(rejected, "then", {
				get() {
					accesses++;
					if (poison === "throw") throw new Error("poisoned then getter");
					return null;
				},
			});
			return rejected;
		})).toThrow("ASYNC_TRANSITION");
		// No test-side handler: the production intrinsic must observe the original.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(accesses).toBe(0);
		expect(f.reads()).toBe(1);
		expect(() => f.source.check()).toThrow("ASYNC_TRANSITION");
	});
	// Composition6 P2: UNRUN; original rejection is expected to escape until
	// the constructor/species contract has an explicit supported disposition.
	test.each(["constructor", "species"])("contains native rejection with throwing %s", async (property) => {
		const f = fixture();
		let accesses = 0;
		let refusal: unknown;
		try {
			f.source.capture("event", () => {
				const rejected = Promise.reject(new Error("original constructor/species rejection"));
				const descriptor = {
					configurable: false,
					get() {
						accesses++;
						throw new Error("attachment getter failure");
					},
				};
				if (property === "constructor") Object.defineProperty(rejected, "constructor", descriptor);
				else {
					const constructor = Object.defineProperty({}, Symbol.species, descriptor);
					Object.defineProperty(rejected, "constructor", { value: constructor, configurable: false });
				}
				return rejected;
			});
		} catch (cause) {
			refusal = cause;
		}
		expect((refusal as Error).message).toContain("ASYNC_TRANSITION");
		expect(accesses).toBe(0);
		// No test-side handler on the original rejected Promise.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(accesses).toBe(1);
		expect(() => f.source.check()).toThrow(refusal as Error);
		expect(f.reads()).toBe(1);
	});
	test("seals before a forbidden then getter can reenter or throw", async () => {
		const f = fixture();
		let refusal: unknown;
		let observed = false;
		let reentry: unknown;
		try {
			f.source.capture("event", () => ({
				get then() {
					observed = true;
					try {
						f.source.capture("reentry", () => undefined);
					} catch (cause) {
						reentry = cause;
					}
					throw new Error("forbidden getter failure");
				},
			}));
		} catch (cause) {
			refusal = cause;
		}
		expect(observed).toBe(false);
		expect((refusal as Error).message).toContain("ASYNC_TRANSITION");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(observed).toBe(true);
		expect(reentry).toBe(refusal);
		expect(() => f.source.check()).toThrow(refusal as Error);
		expect(f.reads()).toBe(1);
	});
	test("observes a returned rejection even when an earlier swallowed reentry is the first fault", async () => {
		const f = fixture();
		let first: unknown;
		expect(() => f.source.capture("event", () => {
			try {
				f.source.capture("reentry", () => undefined);
			} catch (cause) {
				first = cause;
			}
			return Promise.reject(new Error("later rejection"));
		})).toThrow("REENTRY");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(() => f.source.check()).toThrow(first as Error);
		expect(f.reads()).toBe(1);
	});
	test.each(["boot", "namespace", "pid"])("%s change refuses, never starts a new identity", (kind) => {
		let reads = 0;
		const source = new OriginalClockEvidence(() => {
			const result = structuredClone(original);
			if (reads++) {
				if (kind === "boot") result.bootId = "22222222-2222-3333-4444-555555555555";
				if (kind === "namespace") result.timeNamespace.inode = "7";
				if (kind === "pid") result.pid++;
			}
			return result;
		}, "10");
		expect(() => source.capture("event", () => undefined)).toThrow("IDENTITY_CHANGED");
	});
	test("native read failure preserves first cause and prevents transition", () => {
		const failure = new Error("native failed");
		let ran = false;
		const source = new OriginalClockEvidence(() => {
			throw failure;
		}, "10");
		expect(() =>
			source.capture("event", () => {
				ran = true;
			}),
		).toThrow(failure);
		expect(ran).toBe(false);
		expect(() => source.check()).toThrow(failure);
	});
	test.each(["01", "-0", "1e3", "100000000000000000000", "1.0"])(
		"refuses noncanonical or oversized ns %s",
		(monotonicNs) => {
			const source = new OriginalClockEvidence(() => ({ ...original, monotonicNs }), "10");
			expect(() => source.capture("event", () => undefined)).toThrow("INTEGER");
		},
	);
});
