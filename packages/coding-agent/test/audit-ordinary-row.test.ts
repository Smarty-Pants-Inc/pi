import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { OrdinaryOperationalAudit } from "../src/core/ordinary-operational-audit.ts";
import type { TokenReservation } from "../src/core/ordinary-token-budget.ts";

// smarty-dev#5822 design 9.1 row 11: defensive in-memory row publication, no owner effects.
// Stub unrelated native/owner integration ports; execute real request-row and notification bodies.
const observed = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../src/core/ordinary-clock.ts", () => ({
	ordinaryClock: { monotonic: () => 1, wallTime: () => 1 },
	hasOriginalClockEvidence: () => false,
	beginOrdinaryClockOperation: () => ({}),
	commitOrdinaryClockOperation: () => ({}),
	failOrdinaryClockOperation: () => {},
	finishOrdinaryClockOperation: () => ({}),
}));
vi.mock("../src/core/ordinary-owner-context.ts", () => ({ assertOrdinaryOwner: () => {} }));
vi.mock("../src/core/ordinary-sc085-setup.ts", () => ({ OrdinarySc085Setup: class {} }));
vi.mock("../src/core/ordinary-sc085-source/operational-admission.ts", () => ({ checkSc085Operation: () => {} }));
vi.mock("../src/core/ordinary-runtime.ts", () => ({
	publishOrdinaryRequest: (_audit: unknown, row: unknown) => {
		observed.rows.push(row);
	},
	publishOrdinaryExposure: () => {},
	assertOrdinaryExposureAudit: () => {},
	receivedOrdinaryOperationalHooks: () => ({}),
}));
it("publishes an owned ordinal instead of provider receipt text, without changing private correlation", () => {
	const scope = {
		ownerEpoch: "synthetic-owner",
		sessionId: "synthetic-session",
		allocationId: "synthetic-allocation",
	};
	const audit = new OrdinaryOperationalAudit(scope, 32, 4096);
	const bytes = new TextEncoder().encode("{}");
	const payloadHash = createHash("sha256").update(bytes).digest("hex");
	const reservation: TokenReservation = {
		scope: {
			...scope,
			decisionDigest: "0".repeat(64),
			provider: "openai",
			model: "synthetic",
			contextTokens: 100,
			outputTokens: 10,
			attempts: 1,
			notBeforeMs: 0,
			expiresMs: 100,
		},
		requestId: "synthetic-request",
		payloadHash,
		reservedTokens: 100,
	};
	const capture = { decisionId: "synthetic-decision", capturedAt: "synthetic-time", frameText: null, frameHash: null };
	const marker = "SYNTHETIC_ORDINARY_RECEIPT_5822";
	audit.capture(capture);
	audit.request(reservation, bytes);
	audit.settlement({
		reservation,
		usage: null,
		responseId: marker,
		streamEnded: true,
		terminal: "completed",
		disposition: "measured",
	});
	audit.outcome({
		capture,
		kind: "decision",
		attempt: 1,
		payloadHash,
		outcome: "accepted",
		providerResponseId: marker,
		acceptanceBasis: "native-responses-result",
	});
	audit.retired(reservation);
	expect(observed.rows).toHaveLength(1);
	expect(audit.joinedRequest(reservation).nativeAccepted).toBe(true);
	expect(JSON.stringify(observed.rows)).not.toContain(marker);
	expect(observed.rows[0]).toHaveProperty("providerResponseId", "provider-response-1");
});

// smarty-dev#5822 F6: publication must not spend or replace private correlation identity.
it("reuses public ordinals across nested positions and repeated reads, preserving private receipts", () => {
	const scope = {
		ownerEpoch: "synthetic-owner",
		sessionId: "synthetic-session",
		allocationId: "synthetic-allocation",
	};
	const audit = new OrdinaryOperationalAudit(scope, 32, 4096);
	const bytes = new TextEncoder().encode("{}");
	const payloadHash = createHash("sha256").update(bytes).digest("hex");
	for (let i = 1; i <= 2; i++) {
		const reservation: TokenReservation = {
			scope: {
				...scope,
				decisionDigest: "0".repeat(64),
				provider: "openai",
				model: "synthetic",
				contextTokens: 100,
				outputTokens: 10,
				attempts: 1,
				notBeforeMs: 0,
				expiresMs: 100,
			},
			requestId: `ordinal-request-${i}`,
			payloadHash,
			reservedTokens: 100,
		};
		const capture = {
			decisionId: `ordinal-decision-${i}`,
			capturedAt: "synthetic-time",
			frameText: null,
			frameHash: null,
		};
		const raw = `SYNTHETIC_PRIVATE_ID_${i}`;
		audit.capture(capture);
		audit.request(reservation, bytes);
		expect(audit.publishedRequest(reservation.requestId).providerResponseId).toBeNull();
		audit.settlement({
			reservation,
			usage: null,
			responseId: raw,
			streamEnded: true,
			terminal: "completed",
			disposition: "measured",
		});
		audit.outcome({
			capture,
			kind: "decision",
			attempt: 1,
			payloadHash,
			outcome: "accepted",
			providerResponseId: raw,
			acceptanceBasis: "native-responses-result",
		});
		audit.retired(reservation);
		const first = audit.publishedRequest(reservation.requestId);
		const repeated = audit.publishedRequest(reservation.requestId);
		expect(first.providerResponseId).toBe(`provider-response-${i}`);
		expect(repeated.providerResponseId).toBe(first.providerResponseId);
		expect(first.absenceOfViewAudit?.providerResponseId).toBe(first.providerResponseId);
		expect(first.native?.receipt.providerResponseId).toBe(first.providerResponseId);
		expect(audit.joinedRequest(reservation).providerResponseId).toBe(raw);
		expect(audit.joinedRequest(reservation).native?.receipt.providerResponseId).toBe(raw);
		expect(audit.joinedRequest(reservation).nativeAccepted).toBe(true);
		if (first.native) first.native.receipt.providerResponseId = "changed-public-copy";
		expect(audit.publishedRequest(reservation.requestId).native?.receipt.providerResponseId).toBe(
			`provider-response-${i}`,
		);
		expect(audit.joinedRequest(reservation).native?.receipt.providerResponseId).toBe(raw);
	}
});
