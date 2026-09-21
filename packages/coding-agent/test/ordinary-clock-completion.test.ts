import { beforeEach, expect, test, vi } from "vitest";
import { OriginalClockEvidence } from "../src/core/ordinary-clock-evidence.ts";
import type { OwnerAdmission, OwnerHost } from "../src/core/owner-effects.ts";
import { SessionOwnership } from "../src/core/session-ownership.ts";

// Original effect completion control flow with inert native/journal/manager
// ports. No real allocation, native completion, clock syscall or Host is created.
const ports = vi.hoisted(() => ({ complete: vi.fn(), capture: vi.fn() }));
vi.mock("../src/core/ordinary-clock.ts", () => ({ captureOrdinaryClockObservation: ports.capture }));
vi.mock("../src/core/owner-effects.ts", () => ({
	OwnedJournal: class {
		static acquire() {
			return {
				assertActive() {},
				activate() {},
				beginOperation() {
					return { check() {}, complete: ports.complete };
				},
			};
		}
		inspectResources() {}
		inspectPermission() {}
	},
}));
vi.mock("../src/core/session-manager.ts", () => ({
	SessionManager: {
		inMemory() {
			return { getHeader: () => ({ id: "synthetic", timestamp: "2026-09-19T00:00:00.000Z" }) };
		},
		openOwned() {
			return { persistCurrent() {} };
		},
	},
}));
beforeEach(() => {
	ports.complete.mockReset();
	ports.capture.mockReset();
});

function fixture(failRead: number) {
	const events: string[] = [];
	let reads = 0;
	const failure = new Error("clock read failed");
	const evidence = new OriginalClockEvidence(() => {
		events.push("native-clock");
		if (++reads === failRead) throw failure;
		return {
			monotonicNs: String(reads),
			bootId: "11111111-2222-3333-4444-555555555555",
			timeNamespace: { device: "1", inode: "2" },
			pid: 3,
		};
	}, "10");
	ports.capture.mockImplementation((eventMeaning: string, action: () => void) => {
		const captured = evidence.capture(eventMeaning, action);
		return {
			value: captured.value,
			observation: {
				local: { monotonicMs: 0.25, wallMs: 42 },
				parent: captured.witness,
				sequence: captured.sequence,
				eventMeaning,
			},
		};
	});
	ports.complete.mockImplementation(() => {
		events.push("native-completion");
	});
	const owner = SessionOwnership.create({} as OwnerHost, "/synthetic");
	owner.activate({} as OwnerAdmission);
	return { owner, events, failure };
}

test("native completion edges follow actual async join, not its start or observer receipt", async () => {
	const f = fixture(0);
	const completed = vi.fn(() => {
		f.events.push("completion-observer");
	});
	await f.owner.effect(
		{ kind: "worker" },
		async () => {
			f.events.push("async-start");
			await Promise.resolve();
			f.events.push("async-joined");
		},
		{ completed },
	);
	expect(f.events).toEqual([
		"async-start",
		"async-joined",
		"native-clock",
		"native-completion",
		"native-clock",
		"completion-observer",
	]);
	expect(ports.complete).toHaveBeenCalledExactlyOnceWith(false);
	expect(completed).toHaveBeenCalledTimes(1);
});

test.each([1, 2])("failed clock edge %s preserves single native cleanup and no success receipt", async (edge) => {
	const f = fixture(edge);
	const completed = vi.fn();
	await expect(f.owner.effect({ kind: "worker" }, () => undefined, { completed })).rejects.toBe(f.failure);
	expect(ports.complete).toHaveBeenCalledExactlyOnceWith(edge === 1);
	expect(completed).not.toHaveBeenCalled();
	expect(f.owner.phase).toBe("quarantined");
});

test.each(["immediate", "delayed"])("contains %s rejected completion observer without repeating completion", async (mode) => {
	const f = fixture(0);
	const completed = vi.fn(() => {
		const rejected = new Error("forbidden observer rejection");
		if (mode === "immediate") return Promise.reject(rejected);
		return Promise.resolve().then(() => { throw rejected; });
	});
	await expect(f.owner.effect({ kind: "worker" }, () => undefined, { completed })).rejects.toThrow(
		"OWNER_COMPLETION_OBSERVER_SYNC",
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(f.owner.phase).toBe("quarantined");
	expect(completed).toHaveBeenCalledTimes(1);
	expect(ports.complete).toHaveBeenCalledExactlyOnceWith(false);
	expect(f.events).toEqual(["native-clock", "native-completion", "native-clock"]);
});

test.each(["throw", "noncallable"])("contains native completion rejection with %s own then", async (poison) => {
	const f = fixture(0);
	let accesses = 0;
	const completed = vi.fn(() => {
		const rejected = Promise.reject(new Error("original native completion rejection"));
		Object.defineProperty(rejected, "then", {
			get() {
				accesses++;
				if (poison === "throw") throw new Error("poisoned observer then getter");
				return null;
			},
		});
		return rejected;
	});
	await expect(f.owner.effect({ kind: "worker" }, () => undefined, { completed })).rejects.toThrow(
		"OWNER_COMPLETION_OBSERVER_SYNC",
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(accesses).toBe(0);
	expect(f.owner.phase).toBe("quarantined");
	expect(completed).toHaveBeenCalledTimes(1);
	expect(ports.complete).toHaveBeenCalledExactlyOnceWith(false);
	expect(f.events).toEqual(["native-clock", "native-completion", "native-clock"]);
});

test("quarantines before a forbidden completion then getter can reenter", async () => {
	const f = fixture(0);
	let phase: string | undefined;
	let reentry: unknown;
	let ran = false;
	await expect(f.owner.effect({ kind: "worker" }, () => undefined, {
		completed: () => ({
			get then() {
				phase = f.owner.phase;
				try {
					f.owner.within(() => { ran = true; });
				} catch (cause) {
					reentry = cause;
				}
				throw new Error("forbidden observer getter");
			},
		}),
	})).rejects.toThrow("OWNER_COMPLETION_OBSERVER_SYNC");
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(phase).toBe("quarantined");
	expect((reentry as Error).message).toBe("STALE_OWNER");
	expect(ran).toBe(false);
	await expect(f.owner.effect({ kind: "worker" }, () => undefined)).rejects.toThrow("STALE_OWNER");
	expect(ports.complete).toHaveBeenCalledExactlyOnceWith(false);
	expect(f.events).toEqual(["native-clock", "native-completion", "native-clock"]);
});

test("throwing native completion is not retried and never yields an after-edge", async () => {
	const f = fixture(0);
	const failure = new Error("completion uncertain");
	ports.complete.mockImplementation(() => {
		throw failure;
	});
	const completed = vi.fn();
	await expect(f.owner.effect({ kind: "worker" }, () => undefined, { completed })).rejects.toBe(failure);
	expect(ports.complete).toHaveBeenCalledTimes(1);
	expect(completed).not.toHaveBeenCalled();
	expect(f.events).toEqual(["native-clock"]);
});
