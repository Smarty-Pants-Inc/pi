import { describe, expect, it } from "vitest";
import { OrdinaryTokenBudget, type TokenAllocationScope } from "../src/core/ordinary-token-budget.ts";
import { projectResponsesTokenCount } from "../src/core/ordinary-token-qualification.ts";

// Synthetic nonsecret inputs to production accounting. No native capacity,
// credential, provider response or physical retirement qualification is claimed.
const scope: TokenAllocationScope = {
	allocationId: "synthetic-allocation",
	decisionDigest: "d".repeat(64),
	ownerEpoch: "owner-A",
	sessionId: "session-A",
	provider: "synthetic",
	model: "synthetic-model",
	contextTokens: 100,
	outputTokens: 20,
	attempts: 2,
	notBeforeMs: 1000,
	expiresMs: 2000,
};
const hash = "a".repeat(64);
const unknown = { responseId: null, terminal: null, usage: null, streamEnded: false, conflict: false } as const;
const completed = {
	responseId: "synthetic-response",
	terminal: "completed",
	streamEnded: true,
	conflict: false,
	usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40, cachedInputTokens: null, reasoningTokens: null },
} as const;

describe("original allocation token accounting", () => {
	it("reserves finite capacity atomically and binds exact request/payload/owner", () => {
		const budget = new OrdinaryTokenBudget(scope);
		const ticket = budget.reserve("one", hash, 1000);
		expect(ticket).toMatchObject({ requestId: "one", payloadHash: hash, reservedTokens: 100, scope });
		expect(Object.isFrozen(ticket.scope)).toBe(true);
		expect(() => budget.reserve("one", hash, 1000)).toThrow("REPLAY");
		budget.reserve("two", hash, 1000);
		expect(() => budget.reserve("three", hash, 1000)).toThrow("EXHAUSTED");
	});

	it("binds one count plan to the original reservation and rejects a well-shaped integer as evidence", () => {
		const budget = new OrdinaryTokenBudget(scope);
		const bytes = Buffer.from(
			JSON.stringify({ model: scope.model, input: "synthetic", stream: true, store: false, max_output_tokens: 20 }),
		);
		const projection = projectResponsesTokenCount(bytes, {
			wireModel: scope.model,
			contextTokens: 100,
			outputTokens: 20,
		});
		const reservation = budget.reserve("one", projection.payloadHash, 1000);
		expect(() => budget.prepareCount({ ...reservation }, projection, 1000)).toThrow("SCOPE");
		const plan = budget.prepareCount(reservation, projection, 1000);
		expect(() => budget.prepareCount(reservation, projection, 1000)).toThrow("SCOPE");
		expect(() => budget.qualifyCount({ ...plan }, { inputTokens: 1 }, 1000)).toThrow("REPLAY");
		expect(() => budget.qualifyCount(plan, { inputTokens: 1 }, 1000)).toThrow("SCOPE");
		expect(() => budget.qualifyCount(plan, { inputTokens: 1 }, 1000)).toThrow("REPLAY");
	});

	it("does not start a count after settlement or with an invalid output reservation", () => {
		const budget = new OrdinaryTokenBudget(scope);
		const bytes = Buffer.from(
			JSON.stringify({ model: scope.model, input: "synthetic", stream: true, store: false, max_output_tokens: 20 }),
		);
		const projection = projectResponsesTokenCount(bytes, {
			wireModel: scope.model,
			contextTokens: 100,
			outputTokens: 20,
		});
		const ticket = budget.reserve("one", projection.payloadHash, 1000);
		for (const outputTokens of [0, -1, Number.NaN, 1.5, 21]) {
			expect(() => budget.prepareCount(ticket, { ...projection, outputTokens }, 1000)).toThrow("SCOPE");
		}
		budget.reconcile(ticket, unknown);
		expect(() => budget.prepareCount(ticket, projection, 1000)).toThrow("SCOPE");
	});

	it("never refunds unknown, aborted or unobserved attempts", () => {
		const budget = new OrdinaryTokenBudget({ ...scope, attempts: 1 });
		const ticket = budget.reserve("one", hash, 1000);
		expect(budget.reconcile(ticket, unknown).disposition).toBe("unknown");
		expect(() => budget.reserve("two", hash, 1000)).toThrow("EXHAUSTED");
	});

	it("reconciles actual usage exactly once, including out-of-order completions", () => {
		const budget = new OrdinaryTokenBudget(scope);
		const one = budget.reserve("one", hash, 1000),
			two = budget.reserve("two", hash, 1000);
		const second = budget.reconcile(two, completed);
		expect(budget.reconcile(two, completed)).toBe(second);
		expect(budget.reconcile(one, { ...completed, responseId: "other-response" }).disposition).toBe("measured");
		expect(() => budget.reconcile(two, unknown)).toThrow("CONFLICT");
	});

	it("refuses foreign/copied tickets and retains over-budget usage without another admission", () => {
		const budget = new OrdinaryTokenBudget(scope);
		const one = budget.reserve("one", hash, 1000);
		expect(() => budget.reconcile({ ...one }, completed)).toThrow("SCOPE");
		const exceeded = { ...completed, usage: { ...completed.usage, outputTokens: 21, totalTokens: 51 } };
		expect(budget.reconcile(one, exceeded).disposition).toBe("over-budget");
		expect(() => budget.reserve("two", hash, 1000)).toThrow("STALE");
	});

	it("refuses a provider response replay across different request reservations", () => {
		const budget = new OrdinaryTokenBudget(scope);
		const one = budget.reserve("one", hash, 1000),
			two = budget.reserve("two", hash, 1000);
		budget.reconcile(one, completed);
		expect(() => budget.reconcile(two, completed)).toThrow("RESPONSE_REPLAY");
	});

	it.each([999, 2000, Number.NaN])("refuses stale/invalid time %s", (now) => {
		const budget = new OrdinaryTokenBudget(scope);
		expect(() => budget.reserve("one", hash, now)).toThrow("STALE");
	});

	it("fences clock rollback but permits accounting for already-spent expired work", () => {
		const budget = new OrdinaryTokenBudget(scope);
		const ticket = budget.reserve("one", hash, 1500);
		expect(() => budget.reserve("two", hash, 1499)).toThrow("STALE");
		expect(budget.reconcile(ticket, completed).disposition).toBe("measured");
	});
});
