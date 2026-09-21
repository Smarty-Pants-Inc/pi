import { createHash } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import { OriginalClockEvidence } from "../src/core/ordinary-clock-evidence.ts";
import { OrdinaryOperationalAudit } from "../src/core/ordinary-operational-audit.ts";
import type { OrdinaryExposureFrame, OrdinaryExposureReceipt } from "../src/core/ordinary-sense.ts";
import type { TokenReservation } from "../src/core/ordinary-token-budget.ts";

const ports = vi.hoisted(() => ({ capture: vi.fn(), mono: vi.fn(), wall: vi.fn(), read: vi.fn() }));
vi.mock("../src/core/ordinary-clock.ts", () => ({
	hasOriginalClockEvidence: () => true,
	ordinaryClock: { capture: ports.capture, monotonic: ports.mono, wallTime: ports.wall },
}));
beforeEach(() => {
	vi.clearAllMocks();
	let ns = 100n;
	ports.read.mockImplementation(() => ({
		monotonicNs: String(ns++),
		bootId: "11111111-2222-3333-4444-555555555555",
		timeNamespace: { device: "1", inode: "2" },
		pid: 3,
	}));
	const evidence = new OriginalClockEvidence(ports.read, "10");
	ports.capture.mockImplementation((name: string, transition: () => unknown) => evidence.capture(name, transition));
	ports.mono.mockReturnValue(0.125);
	ports.wall.mockReturnValue(42);
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

test("original reserve/authorize/reconcile source callbacks retain distinct brackets and unchanged local raw", () => {
	const { audit, reservation, bytes } = fixture();
	expect(audit.prepareRequest(() => reservation, bytes)).toBe(reservation);
	const request = new Request("https://invalid.test");
	expect(audit.dispatch(reservation, () => request)).toBe(request);
	audit.recordSettlement(reservation, () =>
		audit.settlement({
			reservation,
			usage: null,
			responseId: null,
			streamEnded: false,
			terminal: null,
			disposition: "unknown",
		}),
	);
	const row = audit.requests()[0];
	for (const phase of ["prepared", "dispatch", "settled"] as const) {
		expect(row.requestTimes[phase]?.monotonicMs).toBe(0.125);
		expect(row.requestTimes[phase]?.parent?.kind).toBe("original-native-clock-witness");
	}
	expect(row.requestTimes.dispatch?.eventMeaning).toBe("dispatch-authorization");
	expect(() => audit.retired(reservation)).toThrow("ORIGINAL_COMPLETION");
	const completed = ports.capture("native-operation-completion", () => undefined);
	audit.retired(reservation, {
		local: { monotonicMs: 0.0625, wallMs: 40 },
		parent: completed.witness,
		sequence: completed.sequence,
		eventMeaning: completed.eventMeaning,
	});
	// Receipt does not sample at the later async continuation.
	expect(audit.requests()[0].requestTimes.retired?.monotonicMs).toBe(0.0625);
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
});

function exposure() {
	const audit = new OrdinaryOperationalAudit(scope, 64, 65536);
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
	return { audit, frame, receipt };
}

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
	expect(ports.mono).toHaveBeenCalledTimes(1);
	f.audit.exposure(f.frame, f.receipt);
	expect(sink).toHaveBeenCalledTimes(1);
	expect(() => f.audit.validatedSetup()).toThrow("AUDIT_LOST");
});

test.each(["immediate", "delayed"])("contains %s rejected Core transition before publication", async (mode) => {
	const f = exposure();
	const sink = vi.fn();
	f.audit.bindExposureSink(sink);
	expect(() => f.audit.exposureTransition(f.frame, f.receipt, () => {
		const rejected = new Error("forbidden Core rejection");
		if (mode === "immediate") return Promise.reject(rejected);
		return Promise.resolve().then(() => { throw rejected; });
	})).toThrow("EXPOSURE_TRANSITION_SYNC");
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
	expect(() => f.audit.exposureTransition(f.frame, f.receipt, () => {
		const rejected = Promise.reject(new Error("original native Core rejection"));
		Object.defineProperty(rejected, "then", {
			get() {
				accesses++;
				if (poison === "throw") throw new Error("poisoned Core then getter");
				return null;
			},
		});
		return rejected;
	})).toThrow("EXPOSURE_TRANSITION_SYNC");
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
