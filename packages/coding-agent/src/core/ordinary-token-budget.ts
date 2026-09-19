import { createHash, randomUUID } from "node:crypto";
import {
	type ResponsesEvidence,
	type ResponsesUsage,
	readResponsesUsage,
} from "@earendil-works/pi-ai/api/responses-evidence";
import { assertOwnedCountResult, type OwnedCountResult } from "./ordinary-provider-transport.ts";
import { type ResponsesCountProjection, validateResponsesTokenCount } from "./ordinary-token-qualification.ts";

export interface TokenCountPlan {
	readonly reservation: TokenReservation;
	readonly requestId: string;
	readonly projection: Readonly<ResponsesCountProjection>;
}
export interface TokenQualification {
	readonly reservation: TokenReservation;
	readonly countRequestId: string;
	readonly countBodyHash: string;
	readonly payloadHash: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly wireModel: string;
}

export interface TokenAllocationScope {
	readonly allocationId: string;
	readonly decisionDigest: string;
	readonly ownerEpoch: string;
	readonly sessionId: string;
	readonly provider: string;
	readonly model: string;
	readonly contextTokens: number;
	readonly outputTokens: number;
	readonly attempts: number;
	readonly notBeforeMs: number;
	readonly expiresMs: number;
}

export interface TokenReservation {
	readonly scope: Readonly<TokenAllocationScope>;
	readonly requestId: string;
	readonly payloadHash: string;
	/** Pessimistically charge the whole admitted context for each attempt. No
	 * guessed tokenizer/byte ratio, refund, or reuse after uncertain dispatch. */
	readonly reservedTokens: number;
}

export interface TokenSettlement {
	readonly reservation: TokenReservation;
	readonly usage: Readonly<ResponsesUsage> | null;
	readonly responseId: string | null;
	readonly streamEnded: boolean;
	readonly terminal: ResponsesEvidence["terminal"];
	readonly disposition: "measured" | "unknown" | "over-budget";
}

/** Accounting owned by the already-received allocation. This class does NOT
 * attest native context capacity or make an arbitrary caller's scope a grant.
 * Transport still requires the independent qualified input/context boundary. */
export class OrdinaryTokenBudget {
	readonly #scope: Readonly<TokenAllocationScope>;
	readonly #requests = new Map<
		string,
		{
			reservation: TokenReservation;
			settlement?: TokenSettlement;
			evidence?: string;
			qualification?: TokenQualification;
		}
	>();
	readonly #responses = new Map<string, TokenReservation>();
	readonly #settlements = new WeakSet<TokenSettlement>();
	readonly #countPlans = new Map<TokenReservation, TokenCountPlan>();
	readonly #countFinished = new WeakSet<TokenCountPlan>();
	readonly #qualifications = new WeakMap<TokenQualification, { plan: TokenCountPlan; consumed: boolean }>();
	#lastTime: number;
	#failed = false;

	constructor(scope: TokenAllocationScope) {
		for (const value of [scope.allocationId, scope.ownerEpoch, scope.sessionId, scope.provider, scope.model]) {
			if (!value || value.length > 256) throw new Error("OWNER_TOKEN_SCOPE");
		}
		if (!/^[a-f0-9]{64}$/.test(scope.decisionDigest)) throw new Error("OWNER_TOKEN_SCOPE");
		if (
			!Number.isSafeInteger(scope.contextTokens) ||
			scope.contextTokens <= 0 ||
			scope.contextTokens > 2_000_000 ||
			!Number.isSafeInteger(scope.outputTokens) ||
			scope.outputTokens <= 0 ||
			scope.outputTokens > scope.contextTokens ||
			!Number.isSafeInteger(scope.attempts) ||
			scope.attempts < 1 ||
			scope.attempts > 8 ||
			!Number.isSafeInteger(scope.notBeforeMs) ||
			!Number.isSafeInteger(scope.expiresMs) ||
			scope.notBeforeMs <= 0 ||
			scope.expiresMs <= scope.notBeforeMs
		)
			throw new Error("OWNER_TOKEN_LIMIT");
		this.#scope = Object.freeze({ ...scope });
		this.#lastTime = scope.notBeforeMs;
	}

	#assertCurrent(now: number): void {
		if (this.#failed || !Number.isSafeInteger(now) || now < this.#lastTime || now >= this.#scope.expiresMs) {
			this.#failed = true;
			throw new Error("OWNER_TOKEN_STALE");
		}
		this.#lastTime = now;
	}

	reserve(requestId: string, payloadHash: string, now: number): TokenReservation {
		this.#assertCurrent(now);
		if (!requestId || requestId.length > 256 || !/^[a-f0-9]{64}$/.test(payloadHash))
			throw new Error("OWNER_TOKEN_REQUEST");
		if (this.#requests.has(requestId)) throw new Error("OWNER_TOKEN_REPLAY");
		if (this.#requests.size >= this.#scope.attempts) throw new Error("OWNER_TOKEN_EXHAUSTED");
		const reservation = Object.freeze({
			scope: this.#scope,
			requestId,
			payloadHash,
			reservedTokens: this.#scope.contextTokens,
		});
		this.#requests.set(requestId, { reservation });
		return reservation;
	}

	prepareCount(
		reservation: TokenReservation,
		projection: Readonly<ResponsesCountProjection>,
		now: number,
	): TokenCountPlan {
		this.#assertCurrent(now);
		const request = this.#requests.get(reservation.requestId);
		if (
			request?.reservation !== reservation ||
			request.settlement ||
			this.#countPlans.has(reservation) ||
			!Number.isSafeInteger(projection.outputTokens) ||
			projection.outputTokens <= 0 ||
			projection.payloadHash !== reservation.payloadHash ||
			projection.contextTokens !== this.#scope.contextTokens ||
			projection.outputTokens > this.#scope.outputTokens ||
			createHash("sha256").update(projection.countBody).digest("hex") !== projection.countBodyHash
		)
			throw new Error("OWNER_COUNT_PLAN_SCOPE");
		const plan = Object.freeze({
			reservation,
			requestId: randomUUID(),
			projection: Object.freeze({ ...projection }),
		});
		this.#countPlans.set(reservation, plan);
		return plan;
	}

	qualifyCount(plan: TokenCountPlan, result: OwnedCountResult, now: number): TokenQualification {
		this.#assertCurrent(now);
		if (this.#countPlans.get(plan.reservation) !== plan || this.#countFinished.has(plan))
			throw new Error("OWNER_COUNT_PLAN_REPLAY");
		this.#countFinished.add(plan);
		assertOwnedCountResult(result, plan);
		if (this.#requests.get(plan.reservation.requestId)?.settlement) throw new Error("OWNER_COUNT_PLAN_SCOPE");
		const inputTokens = validateResponsesTokenCount(plan.projection, {
			object: "response.input_tokens",
			input_tokens: result.inputTokens,
		});
		const receipt = Object.freeze({
			reservation: plan.reservation,
			countRequestId: plan.requestId,
			countBodyHash: plan.projection.countBodyHash,
			payloadHash: plan.projection.payloadHash,
			inputTokens,
			outputTokens: plan.projection.outputTokens,
			wireModel: plan.projection.wireModel,
		});
		this.#qualifications.set(receipt, { plan, consumed: false });
		return receipt;
	}

	/** Last synchronous use before native HTTP send. Copies, replay, model/output
	 * edits and any final payload-byte change fail; failed uses consume the ticket. */
	consumeQualification(
		receipt: TokenQualification,
		reservation: TokenReservation,
		bytes: Uint8Array,
		now: number,
	): void {
		this.#assertCurrent(now);
		const state = this.#qualifications.get(receipt);
		if (!state || state.consumed) throw new Error("OWNER_TOKEN_QUALIFICATION_REPLAY");
		state.consumed = true;
		const request = this.#requests.get(reservation.requestId);
		if (!request || receipt.reservation !== reservation || request.reservation !== reservation || request.settlement)
			throw new Error("OWNER_TOKEN_QUALIFICATION_SCOPE");
		// Exact byte identity covers model, output limit and all context fields;
		// do not reserialize a second possibly different inference request.
		if (
			createHash("sha256").update(bytes).digest("hex") !== receipt.payloadHash ||
			state.plan.projection.payloadHash !== receipt.payloadHash
		)
			throw new Error("OWNER_TOKEN_QUALIFICATION_CHANGED");
		request.qualification = receipt;
	}

	assertSettlement(receipt: TokenSettlement): void {
		if (!this.#settlements.has(receipt)) throw new Error("OWNER_TOKEN_SETTLEMENT_SCOPE");
	}

	/** Only the response-bound native parser observer calls this in production.
	 * Identity is the issued object, never copied fields. Late evidence may account
	 * work after expiry but cannot grant another request or reopen spent capacity. */
	reconcile(reservation: TokenReservation, evidence: Readonly<ResponsesEvidence>): TokenSettlement {
		const state = this.#requests.get(reservation.requestId);
		if (!state || state.reservation !== reservation) throw new Error("OWNER_TOKEN_RECEIPT_SCOPE");
		const identity = JSON.stringify(evidence);
		if (state.settlement) {
			if (state.evidence !== identity) {
				this.#failed = true;
				throw new Error("OWNER_TOKEN_RECEIPT_CONFLICT");
			}
			return state.settlement;
		}
		const responseId = evidence.responseId;
		if (responseId !== null) {
			if (
				!responseId ||
				responseId.length > 256 ||
				(this.#responses.has(responseId) && this.#responses.get(responseId) !== reservation)
			) {
				this.#failed = true;
				throw new Error("OWNER_TOKEN_RESPONSE_REPLAY");
			}
			this.#responses.set(responseId, reservation);
		}
		const raw = evidence.usage;
		const usage =
			responseId && evidence.terminal && !evidence.conflict && raw
				? readResponsesUsage({
						input_tokens: raw.inputTokens,
						output_tokens: raw.outputTokens,
						total_tokens: raw.totalTokens,
						input_tokens_details:
							raw.cachedInputTokens === null ? undefined : { cached_tokens: raw.cachedInputTokens },
						output_tokens_details:
							raw.reasoningTokens === null ? undefined : { reasoning_tokens: raw.reasoningTokens },
					})
				: null;
		// A provider exceeding its qualified input upper bound invalidates that
		// qualification even when this particular output happened to be short.
		const qualified = state.qualification;
		const overBudget =
			usage !== null &&
			(usage.totalTokens > reservation.reservedTokens ||
				usage.outputTokens > this.#scope.outputTokens ||
				(qualified !== undefined &&
					(usage.inputTokens > qualified.inputTokens || usage.outputTokens > qualified.outputTokens)));
		if (overBudget || evidence.conflict) this.#failed = true;
		const settlement: TokenSettlement = Object.freeze({
			reservation,
			usage,
			responseId,
			streamEnded: evidence.streamEnded,
			terminal: evidence.conflict ? null : evidence.terminal,
			disposition: overBudget ? "over-budget" : usage ? "measured" : "unknown",
		});
		this.#settlements.add(settlement);
		state.evidence = identity;
		state.settlement = settlement;
		return settlement;
	}
}
