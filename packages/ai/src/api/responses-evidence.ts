/** Native Responses-event evidence, correlated by the actual transport Response.
 * This is not a second SSE parser, credential attestation or physical retirement.
 * Kept outside AssistantMessage: default zero usage and reconstructed messages
 * must never become evidence of measured provider usage. */
export interface ResponsesUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
	readonly cachedInputTokens: number | null;
	readonly reasoningTokens: number | null;
}

export interface ResponsesEvidence {
	readonly responseId: string | null;
	readonly terminal: "completed" | "incomplete" | "failed" | null;
	readonly usage: Readonly<ResponsesUsage> | null;
	readonly streamEnded: boolean;
	readonly conflict: boolean;
}

interface Observation {
	model: string;
	record(evidence: Readonly<ResponsesEvidence>): void;
}
const observations = new WeakMap<Response, Observation>();
const claimed = new WeakSet<Response>();

/** Trusted transport owner only. The Response must be the one returned to the
 * existing SDK; a clone, equal ID, transcript or caller receipt cannot claim it. */
export function observeResponsesEvidence(response: Response, model: string, record: Observation["record"]): void {
	if (!model || observations.has(response)) throw new Error("RESPONSES_EVIDENCE_BINDING");
	observations.set(response, { model, record });
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Pure raw-counter validation. Missing/partial/invalid usage stays unknown;
 * price estimates and parser defaults are deliberately not accepted. */
export function readResponsesUsage(value: unknown): Readonly<ResponsesUsage> | null {
	const usage = object(value);
	if (
		!usage ||
		!count(usage.input_tokens) ||
		!count(usage.output_tokens) ||
		!count(usage.total_tokens) ||
		!Number.isSafeInteger(usage.input_tokens + usage.output_tokens) ||
		usage.input_tokens + usage.output_tokens !== usage.total_tokens
	)
		return null;
	const cached = object(usage.input_tokens_details)?.cached_tokens;
	const reasoning = object(usage.output_tokens_details)?.reasoning_tokens;
	if (cached !== undefined && (!count(cached) || cached > usage.input_tokens)) return null;
	if (reasoning !== undefined && (!count(reasoning) || reasoning > usage.output_tokens)) return null;
	return Object.freeze({
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		totalTokens: usage.total_tokens,
		cachedInputTokens: cached ?? null,
		reasoningTokens: reasoning ?? null,
	});
}

/** Observe the existing SDK-decoded event iterator. No consumer binding means
 * no changed provider semantics. Exactly one receipt, including on early return,
 * parser failure or disconnect; terminal evidence never implies stream retirement. */
export async function* withResponsesEvidence<T extends { type: string }>(
	response: Response,
	events: AsyncIterable<T>,
): AsyncGenerator<T> {
	const observation = observations.get(response);
	if (!observation) {
		yield* events;
		return;
	}
	if (claimed.has(response)) throw new Error("RESPONSES_EVIDENCE_REPLAY");
	claimed.add(response);
	let responseId: string | null = null;
	let terminal: ResponsesEvidence["terminal"] = null;
	let usage: Readonly<ResponsesUsage> | null = null;
	let streamEnded = false;
	let conflict = false;
	let terminalIdentity: string | undefined;
	let failed = false;
	let failure: unknown;
	try {
		for await (const event of events) {
			if (
				event.type === "response.created" ||
				event.type === "response.completed" ||
				event.type === "response.incomplete" ||
				event.type === "response.failed"
			) {
				const raw = object("response" in event ? event.response : undefined);
				const id = raw?.id;
				if (
					!raw ||
					typeof id !== "string" ||
					!id ||
					id.length > 256 ||
					(responseId !== null && responseId !== id) ||
					raw?.model !== observation.model
				) {
					conflict = true;
				} else {
					responseId = id;
					if (event.type !== "response.created") {
						const status = event.type.slice("response.".length) as Exclude<ResponsesEvidence["terminal"], null>;
						const measured = readResponsesUsage(raw.usage);
						const identity = JSON.stringify([id, status, measured]);
						if (raw.status !== status || (terminalIdentity !== undefined && terminalIdentity !== identity))
							conflict = true;
						else {
							terminalIdentity = identity;
							terminal = status;
							usage = measured;
						}
					} else if (terminal !== null) conflict = true;
				}
			}
			yield event;
		}
		streamEnded = true;
	} catch (cause) {
		failed = true;
		failure = cause;
		throw cause;
	} finally {
		try {
			observation.record(
				Object.freeze({
					responseId,
					terminal: conflict ? null : terminal,
					usage: conflict ? null : usage,
					streamEnded,
					conflict,
				}),
			);
		} catch (cause) {
			// biome-ignore lint/correctness/noUnsafeFinally: Preserve both the parser and evidence-recorder failures, including iterator return.
			if (failed) throw new AggregateError([failure, cause], "RESPONSES_EVIDENCE_FAILED", { cause: failure });
			// biome-ignore lint/correctness/noUnsafeFinally: A failed evidence receipt must reject even when the consumer returns early.
			throw cause;
		}
	}
}
