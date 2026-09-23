import { beforeEach, expect, test, vi } from "vitest";
import { OriginalClockEvidence, type OriginalClockObservation } from "../src/core/ordinary-clock-evidence.ts";
import type { OwnerAdmission, OwnerHost } from "../src/core/owner-effects.ts";
import { SessionOwnership } from "../src/core/session-ownership.ts";
import { HistoricalCompletionOwner, type HistoricalOperation } from "./fixtures/ordinary-completion-legacy-contract.ts";

// MOCK journal/native receipt ports, actual current SessionOwnership and clock
// evidence bodies. No actual owner, addon, clock syscall or custody is constructed.
// The five legacy observer scenarios use the byte-exact frozen production effect
// body, NOT the revised API and NOT absence negatives. They do not qualify C6.
const ports = vi.hoisted(() => ({
	complete: vi.fn(),
	quarantine: vi.fn(),
	read: vi.fn(),
	begin: vi.fn<(event: string) => object>(),
	commit: vi.fn<(ticket: object) => OriginalClockObservation>(),
	fail: vi.fn<(cause: unknown) => never>(),
	operation: vi.fn<(failed: boolean, observe: boolean) => Promise<OriginalClockObservation | undefined>>(),
}));
vi.mock("../src/core/ordinary-clock.ts", () => ({
	hasOriginalClockEvidence: () => true,
	beginOrdinaryClockOperation: ports.begin,
	commitOrdinaryClockOperation: ports.commit,
	failOrdinaryClockOperation: ports.fail,
}));
vi.mock("../src/core/owner-effects.ts", () => ({
	readOriginalPreparedClockSample: ports.read,
	OwnedJournal: class {
		static acquire() {
			return {
				assertActive() {},
				activate() {},
				quarantine: ports.quarantine,
				beginOperation() {
					return { check() {}, complete: ports.operation };
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
	ports.quarantine.mockReset();
	ports.read.mockReset();
	ports.begin.mockReset();
	ports.commit.mockReset();
	ports.fail.mockReset();
	ports.operation.mockReset();
});

function fixture(failRead: number, ready: Promise<void> = Promise.resolve()) {
	const events: string[] = [];
	let reads = 0;
	const failure = new Error("clock read failed");
	ports.read.mockImplementation(() => {
		events.push("native-clock");
		if (++reads === failRead) throw failure;
		return {
			monotonicNs: String(reads),
			bootId: "11111111-2222-3333-4444-555555555555",
			timeNamespace: { device: "1", inode: "2" },
			pid: 3,
		};
	});
	const evidence = new OriginalClockEvidence("10");
	ports.begin.mockImplementation((event) => evidence.begin(event));
	ports.commit.mockImplementation((ticket) => {
		const captured = evidence.commit(ticket);
		return {
			local: { monotonicMs: 0.25, wallMs: 42 },
			parent: captured.witness,
			sequence: captured.sequence,
			eventMeaning: captured.eventMeaning,
		};
	});
	ports.fail.mockImplementation((cause) => evidence.fail(cause));
	ports.complete.mockImplementation(() => {
		events.push("native-completion");
		return { next: null, value: undefined };
	});
	// ONE modeled receipt is retained before readiness and throughout cleanup.
	// This model does not prove production deadlines/next-chain/native retirement;
	// ordinary-clock-native-receipt-v2 separately targets the actual receipt loop.
	const receipt = Object.freeze({ ready, complete: ports.complete });
	let spent = false;
	ports.operation.mockImplementation(async (_failed, observe) => {
		if (spent) throw new Error("MOCK_OPERATION_SPENT");
		spent = true;
		await receipt.ready;
		let attempted = false;
		try {
			const ticket = observe ? ports.begin("native-operation-completion") : undefined;
			attempted = true;
			receipt.complete();
			return ticket ? ports.commit(ticket) : undefined;
		} catch (cause) {
			let first = cause;
			if (observe) {
				try {
					ports.fail(cause);
				} catch (latched) {
					first = latched;
				}
			}
			if (!attempted) {
				attempted = true;
				try {
					receipt.complete();
				} catch (cleanup) {
					throw new AggregateError([first, cleanup], "OWNER_LIFECYCLE_RECEIPT_FAILED", { cause: first });
				}
			}
			throw first;
		}
	});
	const owner = SessionOwnership.create({} as OwnerHost, "/synthetic");
	owner.activate({} as OwnerAdmission);
	return { owner, events, failure, receipt };
}

function legacyFixture() {
	const f = fixture(0);
	let spent = false;
	const complete = vi.fn(async (_failed: boolean, observer?: (complete: () => void) => void) => {
		if (spent) throw new Error("MOCK_LEGACY_OPERATION_SPENT");
		spent = true;
		await f.receipt.ready;
		let attempted = false;
		const accept = () => {
			if (attempted) throw new Error("MOCK_RECEIPT_COMPLETION_ONCE");
			attempted = true;
			f.receipt.complete();
		};
		try {
			if (observer) observer(accept);
			else accept();
		} catch (cause) {
			if (!attempted) {
				try {
					accept();
				} catch (cleanup) {
					throw new AggregateError([cause, cleanup], "OWNER_LIFECYCLE_RECEIPT_FAILED", { cause });
				}
			}
			throw cause;
		}
	});
	// This is an explicitly modeled journal for the historical excerpt, not
	// registration into any current owner/native registry. No result handling here.
	const owner = new HistoricalCompletionOwner({
		assertActive() {},
		quarantine: ports.quarantine,
		beginOperation: () => ({ check() {}, complete }) as unknown as HistoricalOperation,
	});
	return { ...f, owner, legacyComplete: complete };
}

test("native completion edges follow actual async join, not its start or observer receipt", async () => {
	const f = fixture(0);
	const completed = vi.fn(() => {
		f.events.push("completion-observer");
	});
	const settled = await f.owner.effectWithCompletion({ kind: "worker" }, async () => {
		f.events.push("async-start");
		await Promise.resolve();
		f.events.push("async-joined");
	});
	// Ordinary DATA consumption after settlement, not an enrolled completion hook.
	completed();
	expect(settled.completion?.eventMeaning).toBe("native-operation-completion");
	expect(f.events).toEqual([
		"async-start",
		"async-joined",
		"native-clock",
		"native-completion",
		"native-clock",
		"completion-observer",
	]);
	expect(ports.operation).toHaveBeenCalledExactlyOnceWith(false, true);
	expect(ports.complete).toHaveBeenCalledOnce();
	expect(ports.complete.mock.contexts[0]).toBe(f.receipt);
	expect(completed).toHaveBeenCalledTimes(1);
});

test.each([1, 2])("failed clock edge %s preserves single native cleanup and no success receipt", async (edge) => {
	const f = fixture(edge);
	const completed = vi.fn();
	await expect(
		(async () => {
			const settled = await f.owner.effectWithCompletion({ kind: "worker" }, () => undefined);
			completed(settled.completion);
		})(),
	).rejects.toBe(f.failure);
	// The operation starts ONCE with the same flags; a before-edge failure cleans
	// up its retained receipt, not a second operation.complete(failed=true).
	expect(ports.operation).toHaveBeenCalledExactlyOnceWith(false, true);
	expect(ports.complete).toHaveBeenCalledOnce();
	expect(ports.complete.mock.contexts[0]).toBe(f.receipt);
	expect(completed).not.toHaveBeenCalled();
	expect(f.owner.phase).toBe("quarantined");
	expect(ports.quarantine).toHaveBeenCalledOnce();
	expect(f.events).toEqual(
		edge === 1 ? ["native-clock", "native-completion"] : ["native-clock", "native-completion", "native-clock"],
	);
});

// Historical post-invocation callback contract, explicitly MOCK. The frozen
// production effect body invokes/contains results. No test attaches a rejection
// handler to any returned forbidden Promise, and no global handler is installed.
test.each(["immediate", "delayed"])(
	"contains %s rejected completion observer without repeating completion",
	async (mode) => {
		const f = legacyFixture();
		const completed = vi.fn(() => {
			const rejected = new Error("forbidden observer rejection");
			if (mode === "immediate") return Promise.reject(rejected);
			return Promise.resolve().then(() => {
				throw rejected;
			});
		});
		await expect(f.owner.effect({ kind: "worker" }, () => undefined, { completed })).rejects.toThrow(
			"OWNER_COMPLETION_OBSERVER_SYNC",
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(f.owner.phase).toBe("quarantined");
		expect(completed).toHaveBeenCalledTimes(1);
		expect(f.legacyComplete).toHaveBeenCalledExactlyOnceWith(false, expect.any(Function));
		expect(ports.complete).toHaveBeenCalledOnce();
		expect(ports.complete.mock.contexts[0]).toBe(f.receipt);
		expect(ports.quarantine).toHaveBeenCalledOnce();
		expect(f.events).toEqual(["native-clock", "native-completion", "native-clock"]);
	},
);

test.each(["throw", "noncallable"])("contains native completion rejection with %s own then", async (poison) => {
	const f = legacyFixture();
	let accesses = 0;
	let calls = 0;
	// Plain function: a vi.fn spy reads `then` on returned promises to record settled results.
	const completed = () => {
		calls++;
		const rejected = Promise.reject(new Error("original native completion rejection"));
		// biome-ignore lint/suspicious/noThenProperty: Hostile thenable fixture for the original promise boundary.
		Object.defineProperty(rejected, "then", {
			get() {
				accesses++;
				if (poison === "throw") throw new Error("poisoned observer then getter");
				return null;
			},
		});
		return rejected;
	};
	await expect(f.owner.effect({ kind: "worker" }, () => undefined, { completed })).rejects.toThrow(
		"OWNER_COMPLETION_OBSERVER_SYNC",
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(accesses).toBe(0);
	expect(f.owner.phase).toBe("quarantined");
	expect(calls).toBe(1);
	expect(f.legacyComplete).toHaveBeenCalledExactlyOnceWith(false, expect.any(Function));
	expect(ports.complete).toHaveBeenCalledOnce();
	expect(ports.complete.mock.contexts[0]).toBe(f.receipt);
	expect(ports.quarantine).toHaveBeenCalledOnce();
	expect(f.events).toEqual(["native-clock", "native-completion", "native-clock"]);
});

test("quarantines before a forbidden completion then getter can reenter", async () => {
	const f = legacyFixture();
	let phase: string | undefined;
	let reentry: unknown;
	let ran = false;
	await expect(
		f.owner.effect({ kind: "worker" }, () => undefined, {
			completed: () => ({
				// biome-ignore lint/suspicious/noThenProperty: Hostile thenable fixture for the original promise boundary.
				get then() {
					phase = f.owner.phase;
					try {
						f.owner.within(() => {
							ran = true;
						});
					} catch (cause) {
						reentry = cause;
					}
					throw new Error("forbidden observer getter");
				},
			}),
		}),
	).rejects.toThrow("OWNER_COMPLETION_OBSERVER_SYNC");
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(phase).toBe("quarantined");
	expect((reentry as Error).message).toBe("STALE_OWNER");
	expect(ran).toBe(false);
	await expect(f.owner.effect({ kind: "worker" }, () => undefined)).rejects.toThrow("STALE_OWNER");
	expect(f.legacyComplete).toHaveBeenCalledExactlyOnceWith(false, expect.any(Function));
	expect(ports.complete).toHaveBeenCalledOnce();
	expect(ports.complete.mock.contexts[0]).toBe(f.receipt);
	expect(ports.quarantine).toHaveBeenCalledOnce();
	expect(f.events).toEqual(["native-clock", "native-completion", "native-clock"]);
});

test("throwing native completion is not retried and never yields an after-edge", async () => {
	const f = fixture(0);
	const failure = new Error("completion uncertain");
	ports.complete.mockImplementation(() => {
		throw failure;
	});
	const completed = vi.fn();
	await expect(
		(async () => {
			const settled = await f.owner.effectWithCompletion({ kind: "worker" }, () => undefined);
			completed(settled.completion);
		})(),
	).rejects.toBe(failure);
	expect(ports.operation).toHaveBeenCalledExactlyOnceWith(false, true);
	expect(ports.complete).toHaveBeenCalledTimes(1);
	expect(ports.complete.mock.contexts[0]).toBe(f.receipt);
	expect(completed).not.toHaveBeenCalled();
	expect(f.events).toEqual(["native-clock"]);
	expect(f.owner.phase).toBe("quarantined");
});

test("pending native readiness precedes both clock edges and receipt completion", async () => {
	let ready!: () => void;
	const f = fixture(
		0,
		new Promise<void>((resolve) => {
			ready = resolve;
		}),
	);
	const pending = f.owner.effectWithCompletion({ kind: "worker" }, () => "result");
	await Promise.resolve();
	await Promise.resolve();
	expect(ports.operation).toHaveBeenCalledExactlyOnceWith(false, true);
	expect(f.events).toEqual([]);
	expect(ports.complete).not.toHaveBeenCalled();
	ready();
	const settled = await pending;
	expect(settled.value).toBe("result");
	expect(settled.completion?.eventMeaning).toBe("native-operation-completion");
	expect(f.events).toEqual(["native-clock", "native-completion", "native-clock"]);
	expect(ports.complete).toHaveBeenCalledOnce();
	expect(ports.complete.mock.contexts[0]).toBe(f.receipt);
});

test("before-edge and uncertain same-receipt cleanup keep first cause and do not retry", async () => {
	const f = fixture(1);
	const cleanup = new Error("receipt completion uncertain");
	ports.complete.mockImplementation(() => {
		throw cleanup;
	});
	await expect(f.owner.effectWithCompletion({ kind: "worker" }, () => undefined)).rejects.toMatchObject({
		cause: f.failure,
		errors: [f.failure, cleanup],
	});
	expect(ports.operation).toHaveBeenCalledExactlyOnceWith(false, true);
	expect(ports.complete).toHaveBeenCalledOnce();
	expect(ports.complete.mock.contexts[0]).toBe(f.receipt);
	expect(ports.quarantine).toHaveBeenCalledOnce();
	expect(f.events).toEqual(["native-clock"]);
});

test("undefined action failure is preserved and completion stays unobserved", async () => {
	const f = fixture(0);
	await expect(
		f.owner.effectWithCompletion({ kind: "worker" }, () => {
			throw undefined;
		}),
	).rejects.toBeUndefined();
	expect(ports.operation).toHaveBeenCalledExactlyOnceWith(true, false);
	expect(ports.complete).toHaveBeenCalledOnce();
	expect(ports.complete.mock.contexts[0]).toBe(f.receipt);
	expect(f.events).toEqual(["native-completion"]);
	expect(ports.quarantine).not.toHaveBeenCalled();
});
