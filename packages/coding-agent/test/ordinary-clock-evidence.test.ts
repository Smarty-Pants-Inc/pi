import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	type NativeClockSample,
	OriginalClockEvidence,
	projectClockNanoseconds,
} from "../src/core/ordinary-clock-evidence.ts";
import { OriginalClockEvidence as HistoricalClockEvidence } from "./fixtures/ordinary-clock-events-legacy-contract.ts";

// Current evidence body, isolated fixed-addon MODULE MOCK. No production clock
// preparation, original owner, native addon or positive authority is enrolled.
const ports = vi.hoisted(() => ({ read: vi.fn<() => NativeClockSample>() }));
vi.mock("../src/core/owner-effects.ts", () => ({ readOriginalPreparedClockSample: ports.read }));
beforeEach(() => {
	ports.read.mockReset();
});

const original: NativeClockSample = {
	monotonicNs: "9007199254740993",
	bootId: "11111111-2222-3333-4444-555555555555",
	timeNamespace: { device: "4", inode: "5" },
	pid: 6,
};
function modeledSamples(values = [0n, 7n, 8n, 9n]) {
	let reads = 0;
	const events: string[] = [];
	return {
		read: () => {
			events.push("native-read");
			return { ...structuredClone(original), monotonicNs: String(BigInt(original.monotonicNs) + values[reads++]) };
		},
		events,
		reads: () => reads,
	};
}
function fixture(values = [0n, 7n, 8n, 9n]) {
	const samples = modeledSamples(values);
	ports.read.mockImplementation(samples.read);
	return { ...samples, source: new OriginalClockEvidence("10") };
}
function historicalFixture(values = [0n, 7n, 8n, 9n]) {
	const samples = modeledSamples(values);
	return { ...samples, source: new HistoricalClockEvidence(samples.read, "10") };
}

describe("current clock ticket evidence: fixed sample MODULE MOCK, no native execution", () => {
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
		const ticket = f.source.begin("dispatch-authorized");
		f.source.checkOperation(ticket);
		f.events.push("original-transition");
		const first = f.source.commit(ticket);
		expect(f.events).toEqual(["native-read", "original-transition", "native-read"]);
		// Current evidence takes only a ticket; value-transfer assertions remain
		// in the separate historical capture case, not a fabricated current value.
		expect(first.witness.after.monotonicNs).toBe("9007199254741000");
		expect(first.witness.before.monotonicNs).toBe("9007199254740993");
		expect(first.eventMeaning).toBe("dispatch-authorized");
		expect(first.sequence).toBe("1");
		expect(() => {
			first.witness.after.timeNamespace.inode = "999";
		}).toThrow(TypeError);
		expect(Object.isFrozen(first.witness)).toBe(true);
		expect(f.source.commit(f.source.begin("window-end")).sequence).toBe("2");
		expect(f.reads()).toBe(4);
	});
	test.each([
		[2n, 1n, "REVERSED"],
		[0n, 11n, "BRACKET_EXCEEDED"],
	] as const)("refuses %s -> %s with %s", (before, after, code) => {
		const f = fixture([before, after]);
		const ticket = f.source.begin("event");
		let first: unknown;
		try {
			f.source.commit(ticket);
		} catch (cause) {
			first = cause;
		}
		expect((first as Error).message).toContain(code);
		for (const attempt of [() => f.source.commit(ticket), () => f.source.begin("event")]) {
			let caught = false;
			try {
				attempt();
			} catch (cause) {
				caught = true;
				expect(cause).toBe(first);
			}
			expect(caught).toBe(true);
		}
		expect(f.reads()).toBe(2);
	});
	test("swallowed nested capture poisons original call before an additional read", () => {
		const f = fixture();
		let error: unknown;
		// Retained scenario title: current begin/commit replaces capture, but a
		// swallowed nested begin must still poison commit before its after-read.
		const ticket = f.source.begin("event");
		try {
			f.source.begin("nested");
		} catch (cause) {
			error = cause;
		}
		let completionFailure: unknown;
		try {
			f.source.commit(ticket);
		} catch (cause) {
			completionFailure = cause;
		}
		expect((completionFailure as Error).message).toContain("REENTRY");
		expect(completionFailure).toBe(error);
		expect(() => f.source.check()).toThrow(error as Error);
		expect(f.reads()).toBe(1);
	});
	test("read callback reentry swallowed by the port is sticky", () => {
		const source = new OriginalClockEvidence("10");
		let first: unknown;
		ports.read.mockImplementation(() => {
			try {
				source.begin("nested");
			} catch (cause) {
				first = cause; /* modeled hostile port */
			}
			return original;
		});
		expect(() => source.begin("event")).toThrow("REENTRY");
		let caught = false;
		try {
			source.check();
		} catch (cause) {
			caught = true;
			expect(cause).toBe(first);
		}
		expect(caught).toBe(true);
		expect(ports.read).toHaveBeenCalledTimes(1);
	});
});

// Byte-exact historical production clock/sample bodies, reused from the events
// fixture helper. These are post-invocation contracts, NOT current API positives.
// Constructor/species rejection containment remains an unresolved obligation;
// absence of a current capture API does not satisfy it. Never attach a test-side
// rejection handler, change Promise/globals, skip or mark these expected failures.
describe("historical MOCK callback contract: rejection obligations remain UNRUN", () => {
	test("historical capture retains the original transition value and frozen exact-ns witnesses", () => {
		const f = historicalFixture();
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
		expect(() => {
			first.witness.after.timeNamespace.inode = "999";
		}).toThrow(TypeError);
		expect(Object.isFrozen(first.witness)).toBe(true);
		expect(f.source.capture("window-end", () => 1).sequence).toBe("2");
	});
	test("throw/async after-edge cannot become a completed witness", async () => {
		const f = historicalFixture();
		const failure = new Error("original transition failed");
		expect(() =>
			f.source.capture("event", () => {
				throw failure;
			}),
		).toThrow(failure);
		expect(f.reads()).toBe(1);
		const asyncSource = historicalFixture();
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
		const f = historicalFixture();
		const rejected = new Error("forbidden asynchronous rejection");
		let refusal: unknown;
		try {
			f.source.capture("event", () => {
				if (mode === "immediate") return Promise.reject(rejected);
				return Promise.resolve().then(() => {
					throw rejected;
				});
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
		const f = historicalFixture();
		let accesses = 0;
		expect(() =>
			f.source.capture("event", () => {
				const rejected = Promise.reject(new Error("original native rejection"));
				// biome-ignore lint/suspicious/noThenProperty: Hostile thenable fixture for the original promise boundary.
				Object.defineProperty(rejected, "then", {
					get() {
						accesses++;
						if (poison === "throw") throw new Error("poisoned then getter");
						return null;
					},
				});
				return rejected;
			}),
		).toThrow("ASYNC_TRANSITION");
		// No test-side handler: the production intrinsic must observe the original.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(accesses).toBe(0);
		expect(f.reads()).toBe(1);
		expect(() => f.source.check()).toThrow("ASYNC_TRANSITION");
	});
	// Composition6 P2: UNRUN; original rejection is expected to escape until
	// the constructor/species contract has an explicit supported disposition.
	test.each(["constructor", "species"])("contains native rejection with throwing %s", async (property) => {
		const f = historicalFixture();
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
					const speciesConstructor = Object.defineProperty({}, Symbol.species, descriptor);
					Object.defineProperty(rejected, "constructor", { value: speciesConstructor, configurable: false });
				}
				return rejected;
			});
		} catch (cause) {
			refusal = cause;
		}
		expect((refusal as Error).message).toContain("ASYNC_TRANSITION");
		expect(accesses).toBe(0);
		// No test-side handler on the original rejected Promise. Record its known
		// escape here instead of letting it fail the whole Vitest run.
		const escaped: unknown[] = [];
		const runnerListeners = process.listeners("unhandledRejection");
		const record = (reason: unknown) => escaped.push(reason);
		process.removeAllListeners("unhandledRejection");
		process.on("unhandledRejection", record);
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
		} finally {
			process.off("unhandledRejection", record);
			for (const listener of runnerListeners) process.on("unhandledRejection", listener);
		}
		expect(escaped).toEqual([new Error("original constructor/species rejection")]);
		expect(accesses).toBe(1);
		expect(() => f.source.check()).toThrow(refusal as Error);
		expect(f.reads()).toBe(1);
	});
	test("seals before a forbidden then getter can reenter or throw", async () => {
		const f = historicalFixture();
		let refusal: unknown;
		let observed = false;
		let reentry: unknown;
		try {
			f.source.capture("event", () => ({
				// biome-ignore lint/suspicious/noThenProperty: Hostile thenable fixture for the original promise boundary.
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
		const f = historicalFixture();
		let first: unknown;
		expect(() =>
			f.source.capture("event", () => {
				try {
					f.source.capture("reentry", () => undefined);
				} catch (cause) {
					first = cause;
				}
				return Promise.reject(new Error("later rejection"));
			}),
		).toThrow("REENTRY");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(() => f.source.check()).toThrow(first as Error);
		expect(f.reads()).toBe(1);
	});
});

describe("current clock ticket identity and first-cause refusals: MODULE MOCK", () => {
	test.each(["error", "undefined"])("explicit operation failure retains %s before every later edge", (mode) => {
		const f = fixture();
		const ticket = f.source.begin("event");
		const failure = mode === "error" ? new Error("original operation failed") : undefined;
		for (const attempt of [
			() => f.source.fail(failure),
			() => f.source.check(),
			() => f.source.checkOperation(ticket),
			() => f.source.commit(ticket),
			() => f.source.begin("retry"),
			() => f.source.fail(new Error("later cleanup")),
		]) {
			let caught = false;
			try {
				attempt();
			} catch (cause) {
				caught = true;
				expect(cause).toBe(failure);
			}
			expect(caught).toBe(true);
		}
		expect(f.reads()).toBe(1);
	});
	test("foreign ticket poisons completion before an after-read", () => {
		const f = fixture();
		const ticket = f.source.begin("event");
		expect(() => f.source.commit(Object.freeze({}))).toThrow("OPERATION_REQUIRED");
		expect(() => f.source.commit(ticket)).toThrow("OPERATION_REQUIRED");
		expect(f.reads()).toBe(1);
	});
	test("completed ticket cannot be sampled or committed twice", () => {
		const f = fixture();
		const ticket = f.source.begin("event");
		const completed = f.source.commit(ticket);
		expect(completed.sequence).toBe("1");
		expect(() => f.source.commit(ticket)).toThrow("OPERATION_REQUIRED");
		expect(() => f.source.begin("retry")).toThrow("OPERATION_REQUIRED");
		expect(f.reads()).toBe(2);
	});
	test("after-read failure retains first cause without another sample or witness", () => {
		const f = fixture();
		const ticket = f.source.begin("event");
		f.events.push("original-transition");
		const failure = new Error("native after-read failed");
		ports.read.mockImplementation(() => {
			f.events.push("native-read");
			throw failure;
		});
		let completed: ReturnType<OriginalClockEvidence["commit"]> | undefined;
		expect(() => {
			completed = f.source.commit(ticket);
		}).toThrow(failure);
		expect(completed).toBeUndefined();
		for (const attempt of [() => f.source.commit(ticket), () => f.source.begin("retry")]) {
			let caught = false;
			try {
				attempt();
			} catch (cause) {
				caught = true;
				expect(cause).toBe(failure);
			}
			expect(caught).toBe(true);
		}
		expect(ports.read).toHaveBeenCalledTimes(2);
		expect(f.events).toEqual(["native-read", "original-transition", "native-read"]);
	});
	test.each(["boot", "namespace", "pid"])("%s change refuses, never starts a new identity", (kind) => {
		let reads = 0;
		const source = new OriginalClockEvidence("10");
		ports.read.mockImplementation(() => {
			const result = structuredClone(original);
			if (reads++) {
				if (kind === "boot") result.bootId = "22222222-2222-3333-4444-555555555555";
				if (kind === "namespace") result.timeNamespace.inode = "7";
				if (kind === "pid") result.pid++;
			}
			return result;
		});
		const ticket = source.begin("event");
		expect(() => source.commit(ticket)).toThrow("IDENTITY_CHANGED");
		expect(() => source.begin("retry")).toThrow("IDENTITY_CHANGED");
		expect(reads).toBe(2);
	});
	test("native read failure preserves first cause and prevents transition", () => {
		const failure = new Error("native failed");
		let ran = false;
		const source = new OriginalClockEvidence("10");
		ports.read.mockImplementation(() => {
			throw failure;
		});
		expect(() => {
			const ticket = source.begin("event");
			ran = true;
			source.commit(ticket);
		}).toThrow(failure);
		expect(ran).toBe(false);
		expect(() => source.check()).toThrow(failure);
		expect(() => source.begin("retry")).toThrow(failure);
		expect(ports.read).toHaveBeenCalledTimes(1);
	});
	test.each(["01", "-0", "1e3", "100000000000000000000", "1.0"])(
		"refuses noncanonical or oversized ns %s",
		(monotonicNs) => {
			const source = new OriginalClockEvidence("10");
			ports.read.mockImplementation(() => ({ ...original, monotonicNs }));
			expect(() => source.begin("event")).toThrow("INTEGER");
			expect(() => source.begin("retry")).toThrow("INTEGER");
			expect(ports.read).toHaveBeenCalledTimes(1);
		},
	);
});
