import { createHash } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import {
	type NativeClockSample,
	OriginalClockEvidence,
	type OriginalClockObservation,
} from "../src/core/ordinary-clock-evidence.ts";
import { OrdinaryOperationalAudit } from "../src/core/ordinary-operational-audit.ts";
import type { OrdinaryExposureFrame, OrdinaryExposureReceipt } from "../src/core/ordinary-sense.ts";
import type { TokenReservation } from "../src/core/ordinary-token-budget.ts";
import { createHistoricalExposureAudit } from "./fixtures/ordinary-clock-events-legacy-contract.ts";

// Actual current audit/evidence bodies with isolated MOCK dependencies. These
// tests construct no original owner, addon, canonical collector or qualified clock.
// The seven callback exposure cases below instead retain historical production
// excerpts. They are not current API positives or replacements for native proof.
const ports = vi.hoisted(() => ({
	mono: vi.fn<() => number>(),
	wall: vi.fn<() => number>(),
	read: vi.fn<() => NativeClockSample>(),
	has: vi.fn<() => boolean>(),
	begin: vi.fn<(event: string) => object>(),
	finish: vi.fn<(ticket: object) => ReturnType<OriginalClockEvidence["commit"]>>(),
	commit: vi.fn<(ticket: object) => OriginalClockObservation>(),
	fail: vi.fn<(cause: unknown) => never>(),
	publish:
		vi.fn<
			(audit: OrdinaryOperationalAudit, frame: OrdinaryExposureFrame, receipt: OrdinaryExposureReceipt) => void
		>(),
	owners: new WeakMap<object, object>(),
	trace: [] as string[],
}));
vi.mock("../src/core/owner-effects.ts", () => ({ readOriginalPreparedClockSample: ports.read }));
vi.mock("../src/core/ordinary-clock.ts", () => ({
	hasOriginalClockEvidence: ports.has,
	ordinaryClock: { monotonic: ports.mono, wallTime: ports.wall },
	beginOrdinaryClockOperation: ports.begin,
	finishOrdinaryClockOperation: ports.finish,
	commitOrdinaryClockOperation: ports.commit,
	failOrdinaryClockOperation: ports.fail,
}));
vi.mock("../src/core/ordinary-runtime.ts", () => ({
	assertOrdinaryExposureAudit(owner: object, audit: object) {
		if (ports.owners.get(owner) !== audit) throw new Error("MOCK_EXPOSURE_OWNER_REQUIRED");
	},
	publishOrdinaryExposure: ports.publish,
	publishOrdinaryRequest: () => {},
	receivedOrdinaryOperationalHooks: () => {
		throw new Error("MOCK_SETUP_UNSUPPORTED");
	},
}));
vi.mock("../src/core/ordinary-owner-context.ts", () => ({
	assertOrdinaryOwner: () => {
		throw new Error("MOCK_OWNER_UNSUPPORTED");
	},
}));
vi.mock("../src/core/ordinary-sc085-source/operational-admission.ts", () => ({
	checkSc085Operation: () => {
		throw new Error("MOCK_ADMISSION_UNSUPPORTED");
	},
	guardSc085OriginalCallback: () => {
		throw new Error("MOCK_ADMISSION_UNSUPPORTED");
	},
	receiveSc085OriginalStorage: () => {
		throw new Error("MOCK_ADMISSION_UNSUPPORTED");
	},
}));
beforeEach(() => {
	vi.resetAllMocks();
	ports.owners = new WeakMap();
	ports.trace.length = 0;
	let ns = 100n;
	ports.read.mockImplementation(() => {
		ports.trace.push(`sample:${ns}`);
		return {
			monotonicNs: String(ns++),
			bootId: "11111111-2222-3333-4444-555555555555",
			timeNamespace: { device: "1", inode: "2" },
			pid: 3,
		};
	});
	const evidence = new OriginalClockEvidence("10");
	ports.has.mockImplementation(() => {
		evidence.check();
		return true;
	});
	ports.begin.mockImplementation((event) => evidence.begin(event));
	ports.finish.mockImplementation((ticket) => evidence.commit(ticket));
	ports.fail.mockImplementation((cause) => evidence.fail(cause));
	ports.mono.mockImplementation(() => {
		evidence.check();
		ports.trace.push("mono");
		return 0.125;
	});
	ports.wall.mockImplementation(() => {
		evidence.check();
		ports.trace.push("wall");
		return 42;
	});
	// Same local-before-after ordering as the fixed clock port, without preparing
	// or enrolling production native authority. Evidence/ticket checks are real.
	ports.commit.mockImplementation((ticket) => {
		try {
			evidence.checkOperation(ticket);
			const local = { monotonicMs: ports.mono(), wallMs: ports.wall() };
			const captured = ports.finish(ticket);
			return { local, parent: captured.witness, sequence: captured.sequence, eventMeaning: captured.eventMeaning };
		} catch (cause) {
			return evidence.fail(cause);
		}
	});
});
const scope = { ownerEpoch: "owner", sessionId: "session", allocationId: "allocation" };
function fixture() {
	const audit = new OrdinaryOperationalAudit(scope, 64, 65536);
	const bytes = Buffer.from("body");
	const reservation: TokenReservation = {
		scope: {
			...scope,
			decisionDigest: "decision",
			provider: "test",
			model: "test",
			contextTokens: 10,
			outputTokens: 1,
			attempts: 1,
			notBeforeMs: 1,
			expiresMs: 100,
		},
		requestId: "request",
		payloadHash: createHash("sha256").update(bytes).digest("hex"),
		reservedTokens: 10,
	};
	return { audit, reservation, bytes };
}

// Legacy scenario title retained; the provider's current reserve/authorize/
// reconcile sites now bracket direct operations, not callbacks passed to audit.
test("original reserve/authorize/reconcile source callbacks retain distinct brackets and unchanged local raw", () => {
	const { audit, reservation, bytes } = fixture();
	const preparation = ports.begin("request-preparation");
	ports.trace.push("reserve");
	audit.request(reservation, bytes);
	audit.finishPreparation(reservation, preparation);
	const dispatch = ports.begin("dispatch-authorization");
	ports.trace.push("authorize");
	audit.dispatch(reservation, dispatch);
	const settlement = ports.begin("parser-evidence-reconciliation");
	ports.trace.push("reconcile");
	audit.settlement({
		reservation,
		usage: null,
		responseId: null,
		streamEnded: false,
		terminal: null,
		disposition: "unknown",
	});
	audit.finishSettlement(reservation, settlement);
	const row = audit.requests()[0];
	expect(row.requestId).toBe(reservation.requestId);
	expect(row.finalBytes).toEqual(Uint8Array.from(bytes));
	let edge = 100n;
	for (const phase of ["prepared", "dispatch", "settled"] as const) {
		expect(row.requestTimes[phase]?.monotonicMs).toBe(0.125);
		expect(row.requestTimes[phase]?.wallMs).toBe(42);
		expect(row.requestTimes[phase]?.parent?.kind).toBe("original-native-clock-witness");
		expect(row.requestTimes[phase]?.parent?.before.monotonicNs).toBe(String(edge++));
		expect(row.requestTimes[phase]?.parent?.after.monotonicNs).toBe(String(edge++));
	}
	expect(
		[row.requestTimes.prepared, row.requestTimes.dispatch, row.requestTimes.settled].map((at) => [
			at?.clockSequence,
			at?.eventMeaning,
		]),
	).toEqual([
		["1", "request-preparation"],
		["2", "dispatch-authorization"],
		["3", "parser-evidence-reconciliation"],
	]);
	expect(ports.trace).toEqual([
		"sample:100",
		"reserve",
		"mono",
		"wall",
		"sample:101",
		"sample:102",
		"authorize",
		"mono",
		"wall",
		"sample:103",
		"sample:104",
		"reconcile",
		"mono",
		"wall",
		"sample:105",
	]);
	expect(() => audit.retired(reservation)).toThrow("ORIGINAL_COMPLETION");
	ports.mono.mockReturnValue(0.0625);
	ports.wall.mockReturnValue(40);
	const completed = ports.commit(ports.begin("native-operation-completion"));
	ports.mono.mockReturnValue(99999);
	ports.wall.mockReturnValue(99999);
	const reads = ports.read.mock.calls.length,
		localReads = ports.mono.mock.calls.length;
	audit.retired(reservation, completed);
	// Receipt DATA does not sample at the later async continuation.
	expect(audit.requests()[0].requestTimes.retired).toMatchObject({
		monotonicMs: 0.0625,
		wallMs: 40,
		parent: completed.parent,
		clockSequence: "4",
		eventMeaning: "native-operation-completion",
	});
	expect(ports.read).toHaveBeenCalledTimes(reads);
	expect(ports.mono).toHaveBeenCalledTimes(localReads);
});

test("qualification of a retained window-end cursor keeps its original witness despite later samples", () => {
	const { audit } = fixture();
	audit.clockForCore();
	audit.native({ type: "attached", activeRun: false, steering: 0, followUp: 0 });
	audit.session("attached", {
		activeRun: false,
		preflights: 0,
		compacting: false,
		retrying: false,
		steering: 0,
		followUp: 0,
		attempt: null,
	});
	audit.wakeIntention({ ownerEpoch: scope.ownerEpoch, pending: false });
	audit.begin();
	const start = audit.mark(),
		interval = audit.observeSince(start);
	ports.mono.mockReturnValue(99999);
	const selected = audit.resolveSc085Stamp({ kind: "window", cursor: interval.endCursor, edge: "start" });
	expect(selected.stamp).toEqual(interval.end);
	expect(selected.stamp.monotonicMs).toBe(0.125);
	expect(selected.stamp.parent).toEqual(interval.end.parent);
	expect(selected.stamp.clockSequence).toBe(interval.end.clockSequence);
});

function exposureData() {
	const scopeValue = {
		harness: "pi" as const,
		tenantId: "tenant",
		principalId: "principal",
		sessionId: scope.sessionId,
		branchId: "branch",
		workspaceDir: "/work",
	};
	const frame: OrdinaryExposureFrame = {
		protocol: 1,
		scope: scopeValue,
		ownerEpoch: scope.ownerEpoch,
		revision: 1,
		composedAt: "local",
		outcome: "OK",
		views: [],
		text: "",
		hash: "hash",
	};
	const receipt: OrdinaryExposureReceipt = {
		scope: scopeValue,
		ownerEpoch: scope.ownerEpoch,
		requestId: "request",
		decisionId: "decision",
		attemptId: "attempt",
		commitOrder: 1,
		frameRevision: 1,
		frameHash: "hash",
		capturedAt: "local",
		outcome: "accepted",
		frameOutcome: "OK",
		views: [],
	};
	return { frame, receipt };
}

function exposure() {
	return {
		...exposureData(),
		audit: createHistoricalExposureAudit({
			scope,
			read: ports.read,
			monotonic: ports.mono,
			wallTime: ports.wall,
		}),
	};
}

function currentExposure() {
	const audit = new OrdinaryOperationalAudit(scope, 64, 65536);
	const owner = Object.freeze({});
	// MODULE-MOCK relation only; never enrolled into the production owner registry.
	ports.owners.set(owner, audit);
	return { ...exposureData(), audit, owner };
}

test("current Core ticket brackets direct mutation and delivers once without resampling", () => {
	const f = currentExposure();
	const ticket = f.audit.beginExposure(f.owner, f.frame, f.receipt);
	expect(ports.trace).toEqual(["sample:100"]);
	expect(ports.publish).not.toHaveBeenCalled();
	ports.trace.push("mutation");
	f.audit.commitExposure(f.owner, ticket);
	expect(ports.trace).toEqual(["sample:100", "mutation", "mono", "wall", "sample:101"]);
	expect(ports.publish).not.toHaveBeenCalled();
	ports.mono.mockReturnValue(99999);
	f.audit.deliverExposure(f.owner, ticket);
	expect(ports.publish).toHaveBeenCalledExactlyOnceWith(f.audit, f.frame, f.receipt);
	expect(ports.read).toHaveBeenCalledTimes(2);
	expect(ports.mono).toHaveBeenCalledTimes(1);
	expect(() => f.audit.deliverExposure(f.owner, ticket)).toThrow("EXPOSURE_DELIVERY_ONCE");
	expect(ports.publish).toHaveBeenCalledTimes(1);
	expect(ports.read).toHaveBeenCalledTimes(2);
	expect(ports.mono).toHaveBeenCalledTimes(1);
	expect(() => f.audit.validatedSetup()).toThrow("AUDIT_LOST");
});

test("current Core ticket cannot publish before commit", () => {
	const f = currentExposure();
	const ticket = f.audit.beginExposure(f.owner, f.frame, f.receipt);
	expect(() => f.audit.deliverExposure(f.owner, ticket)).toThrow("EXPOSURE_DELIVERY_ONCE");
	expect(() => f.audit.commitExposure(f.owner, ticket)).toThrow("EXPOSURE_DELIVERY_ONCE");
	expect(ports.publish).not.toHaveBeenCalled();
	expect(ports.read).toHaveBeenCalledTimes(1);
	expect(ports.mono).not.toHaveBeenCalled();
});

test("current swallowed Core ticket reentry never publishes evidence", () => {
	const f = currentExposure();
	const ticket = f.audit.beginExposure(f.owner, f.frame, f.receipt);
	try {
		f.audit.beginExposure(f.owner, f.frame, f.receipt);
	} catch {
		/* intentional swallowed reentry */
	}
	expect(() => f.audit.commitExposure(f.owner, ticket)).toThrow("EXPOSURE_TRANSITION");
	expect(() => f.audit.deliverExposure(f.owner, ticket)).toThrow("EXPOSURE_TRANSITION");
	expect(ports.publish).not.toHaveBeenCalled();
	expect(ports.read).toHaveBeenCalledTimes(1);
	expect(ports.mono).not.toHaveBeenCalled();
});

test.each(["error", "undefined"])("current Core abort keeps %s first cause and prevents publication", (mode) => {
	const f = currentExposure();
	const ticket = f.audit.beginExposure(f.owner, f.frame, f.receipt);
	const cause = mode === "error" ? new Error("original mutation failed") : undefined;
	for (const operation of [
		() => f.audit.abortExposure(f.owner, ticket, cause),
		() => f.audit.abortExposure(f.owner, ticket, new Error("later cleanup")),
		() => f.audit.commitExposure(f.owner, ticket),
		() => f.audit.deliverExposure(f.owner, ticket),
	]) {
		let caught = false;
		try {
			operation();
		} catch (error) {
			caught = true;
			expect(error).toBe(cause);
		}
		expect(caught).toBe(true);
	}
	expect(ports.publish).not.toHaveBeenCalled();
	expect(ports.read).toHaveBeenCalledTimes(1);
	expect(ports.mono).not.toHaveBeenCalled();
	expect(() => f.audit.validatedSetup()).toThrow("AUDIT_LOST");
});

// HISTORICAL MOCK cases: byte-exact pre-C6 callback/rejection/publication bodies.
// No production callback API is restored and no forbidden result is handled here.
test("Core transition is bracketed before callback; later evidence delivery does not resample", () => {
	const f = exposure();
	const sink = vi.fn();
	f.audit.bindExposureSink(sink);
	let committed = false;
	f.audit.exposureTransition(f.frame, f.receipt, () => {
		committed = true;
	});
	expect(committed).toBe(true);
	expect(ports.mono).toHaveBeenCalledTimes(1);
	ports.mono.mockReturnValue(99999);
	f.audit.exposure(f.frame, f.receipt);
	expect(sink).toHaveBeenCalledExactlyOnceWith(f.frame, f.receipt);
	expect(f.audit.exposureLost).toBe(false);
	expect(ports.mono).toHaveBeenCalledTimes(1);
	f.audit.exposure(f.frame, f.receipt);
	expect(sink).toHaveBeenCalledTimes(1);
	expect(() => f.audit.validatedSetup()).toThrow("AUDIT_LOST");
});

test.each(["immediate", "delayed"])("contains %s rejected Core transition before publication", async (mode) => {
	const f = exposure();
	const sink = vi.fn();
	f.audit.bindExposureSink(sink);
	expect(() =>
		f.audit.exposureTransition(f.frame, f.receipt, () => {
			const rejected = new Error("forbidden Core rejection");
			if (mode === "immediate") return Promise.reject(rejected);
			return Promise.resolve().then(() => {
				throw rejected;
			});
		}),
	).toThrow("EXPOSURE_TRANSITION_SYNC");
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(() => f.audit.exposureTransition(f.frame, f.receipt, () => {})).toThrow("EXPOSURE_TRANSITION_SYNC");
	f.audit.exposure(f.frame, f.receipt);
	expect(sink).not.toHaveBeenCalled();
	expect(ports.read).toHaveBeenCalledTimes(1);
	expect(ports.mono).not.toHaveBeenCalled();
});

test.each(["throw", "noncallable"])("contains native Core rejection with %s own then", async (poison) => {
	const f = exposure();
	const sink = vi.fn();
	f.audit.bindExposureSink(sink);
	let accesses = 0;
	expect(() =>
		f.audit.exposureTransition(f.frame, f.receipt, () => {
			const rejected = Promise.reject(new Error("original native Core rejection"));
			// biome-ignore lint/suspicious/noThenProperty: Hostile thenable fixture for the original promise boundary.
			Object.defineProperty(rejected, "then", {
				get() {
					accesses++;
					if (poison === "throw") throw new Error("poisoned Core then getter");
					return null;
				},
			});
			return rejected;
		}),
	).toThrow("EXPOSURE_TRANSITION_SYNC");
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(accesses).toBe(0);
	f.audit.exposure(f.frame, f.receipt);
	expect(sink).not.toHaveBeenCalled();
	expect(ports.read).toHaveBeenCalledTimes(1);
	expect(ports.mono).not.toHaveBeenCalled();
	expect(() => f.audit.validatedSetup()).toThrow("AUDIT_LOST");
});

test("Core failure is sealed before a forbidden then getter reenters", async () => {
	const f = exposure();
	let refusal: unknown;
	let reentry: unknown;
	let observed = false;
	try {
		f.audit.exposureTransition(f.frame, f.receipt, () => ({
			// biome-ignore lint/suspicious/noThenProperty: Hostile thenable fixture for the original promise boundary.
			get then() {
				observed = true;
				try {
					f.audit.exposureTransition(f.frame, f.receipt, () => {});
				} catch (cause) {
					reentry = cause;
				}
				throw new Error("forbidden Core getter");
			},
		}));
	} catch (cause) {
		refusal = cause;
	}
	expect(observed).toBe(false);
	expect((refusal as Error).message).toContain("EXPOSURE_TRANSITION_SYNC");
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(observed).toBe(true);
	expect(reentry).toBe(refusal);
	expect(ports.read).toHaveBeenCalledTimes(1);
	expect(() => f.audit.validatedSetup()).toThrow("AUDIT_LOST");
});

test("swallowed Core transition reentry never publishes evidence", () => {
	const f = exposure();
	const sink = vi.fn();
	f.audit.bindExposureSink(sink);
	expect(() =>
		f.audit.exposureTransition(f.frame, f.receipt, () => {
			try {
				f.audit.exposureTransition(f.frame, f.receipt, () => {});
			} catch {
				/* intentional swallowed reentry */
			}
		}),
	).toThrow("EXPOSURE_TRANSITION");
	f.audit.exposure(f.frame, f.receipt);
	expect(sink).not.toHaveBeenCalled();
});
