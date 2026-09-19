import assert from "node:assert/strict";
import { test } from "node:test";
import { OrdinaryOperationalAudit } from "../src/core/ordinary-operational-audit.ts";
import { requestCost, requestDigest } from "../src/core/ordinary-request-evidence.ts";
import type { OrdinaryCapture } from "../src/core/ordinary-sense.ts";
import type { TokenReservation } from "../src/core/ordinary-token-budget.ts";

const scope = { ownerEpoch: "epoch", sessionId: "session", allocationId: "allocation" };
const source = {
	profileSha256: "a".repeat(64),
	recipe: "synthetic",
	packageSha256: "b".repeat(64),
	applicationSha256: "c".repeat(64),
	senseSha256: "d".repeat(64),
	provider: "synthetic",
	model: "model",
	api: "openai-responses",
	baseUrl: "https://synthetic.invalid",
};
function accepted(
	audit: OrdinaryOperationalAudit,
	requestId: string,
	frame: string | null,
	history = "same",
	model = "model",
) {
	const input = [{ role: "user", content: [{ type: "input_text", text: history }] }];
	if (frame !== null) input.push({ role: "user", content: [{ type: "input_text", text: frame }] });
	const bytes = new TextEncoder().encode(
		JSON.stringify({ model, input, store: false, stream: true, max_output_tokens: 10 }),
	);
	const reservation: TokenReservation = {
		requestId,
		payloadHash: requestDigest(bytes),
		reservedTokens: 100,
		scope: {
			...scope,
			decisionDigest: "e".repeat(64),
			provider: "synthetic",
			model,
			contextTokens: 100,
			outputTokens: 10,
			attempts: 8,
			notBeforeMs: 1,
			expiresMs: 100,
		},
	};
	const capture: OrdinaryCapture = {
		decisionId: requestId,
		capturedAt: "synthetic",
		frameText: frame,
		frameHash: frame === null ? null : requestDigest(new TextEncoder().encode(frame)),
	};
	audit.capture(capture);
	audit.request(reservation, bytes);
	audit.dispatch(reservation);
	audit.settlement({
		reservation,
		responseId: requestId,
		terminal: "completed",
		streamEnded: true,
		disposition: "unknown",
		usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 3, reasoningTokens: null },
	});
	audit.outcome({
		capture,
		kind: "decision",
		attempt: 1,
		payloadHash: reservation.payloadHash,
		outcome: "accepted",
		providerResponseId: requestId,
		acceptanceBasis: "native-responses-result",
	});
	audit.retired(reservation);
	return reservation;
}

test("original Core and audit receive exactly one clock object; timestamps stay unqualified", () => {
	const audit = new OrdinaryOperationalAudit(scope, 100, 4096, source);
	assert.equal(audit.clockForCore(), audit.clock);
	assert.throws(() => audit.clockForCore(), /CLOCK_BOUND/);
	accepted(audit, "one", null);
	const row = audit.requestEvidence("one");
	assert.equal(row.coreClockSupplied, true);
	assert.equal(row.clockIdentity.restartComparable, false);
	assert.equal(row.clockIdentity.uncertaintyMs, null);
	assert.equal(row.clockIdentity.ownerEpoch, scope.ownerEpoch);
	assert.equal(row.qualifiedClock, null);
	const stamps = [
		row.requestTimes.prepared,
		row.requestTimes.dispatch!,
		row.requestTimes.settled!,
		row.requestTimes.retired!,
	];
	assert(stamps.every((at) => at.clockId === row.clockIdentity.id && at.uncertaintyMs === null));
	assert(stamps.every((at, i) => i === 0 || at.monotonicMs >= stamps[i - 1].monotonicMs));
	const other = new OrdinaryOperationalAudit(scope, 100, 4096, source);
	assert.notEqual(other.clockIdentity.id, row.clockIdentity.id);
});

test("only original matched non-view wire history/model/config/artifact produces comparison", () => {
	const audit = new OrdinaryOperationalAudit(scope, 100, 4096, source);
	const without = accepted(audit, "without", null);
	accepted(audit, "with", "original view");
	const proof = audit.compareRequests("without", "with");
	assert.equal(proof.basis, "original-retained-final-requests");
	assert.equal(proof.withoutPayloadHash, without.payloadHash);
	assert.equal(proof.source?.applicationSha256, source.applicationSha256);
	const copy = audit.requestEvidence("without");
	copy.nonViewBytes.fill(0);
	copy.finalBytes.fill(0);
	assert.equal(audit.compareRequests("without", "with").nonViewHash, proof.nonViewHash);
	assert.throws(() => audit.joinedRequest({ ...without }), /OWNER_AUDIT_REQUEST/);
});

test("same last prompt with different actual history or model cannot prove pairing", () => {
	const audit = new OrdinaryOperationalAudit(scope, 100, 8192, source);
	accepted(audit, "without", null);
	accepted(audit, "changed-history", "view", "different actual context");
	accepted(audit, "changed-model", "view", "same", "another-model");
	assert.throws(() => audit.compareRequests("without", "changed-history"), /HISTORY_MISMATCH/);
	assert.throws(() => audit.compareRequests("without", "changed-model"), /HISTORY_MISMATCH/);
	assert.throws(() => audit.compareRequests("without", "missing"), /HISTORY_UNAVAILABLE/);
	assert.throws(() => audit.compareRequests("without", "without"), /HISTORY_MISMATCH/);
});

test("missing artifact correspondence refuses; raw usage is reused without billing or latency guesses", () => {
	const unavailable = new OrdinaryOperationalAudit(scope, 100, 4096);
	accepted(unavailable, "one", null);
	assert.throws(() => unavailable.requestEvidence("one"), /HISTORY_UNAVAILABLE/);
	const audit = new OrdinaryOperationalAudit(scope, 100, 4096, source);
	accepted(audit, "one", null);
	const row = audit.requestEvidence("one"),
		cost = audit.requestCost("one");
	assert.equal(cost.uncachedTokens.value, 7);
	assert.equal(cost.cachedTokens.value, 3);
	assert.equal(cost.finalInputBytes.value, row.finalBytes.length);
	assert.equal(cost.latencyMs.value, null);
	assert.equal(cost.latencyMs.raw, null);
	assert.equal(row.billing, null);
	assert.equal(requestCost(null, 1).uncachedTokens.value, null);
	assert.equal(
		requestCost(
			{ inputTokens: 10, outputTokens: 1, totalTokens: 11, cachedInputTokens: null, reasoningTokens: null },
			1,
		).uncachedTokens.value,
		null,
	);
});
