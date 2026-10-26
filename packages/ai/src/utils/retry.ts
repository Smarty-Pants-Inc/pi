import { redactOAuthDiagnostic } from "../auth/oauth/credential-response.ts";
import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";
import { projectAssistantMessageDiagnostics } from "./diagnostics.ts";
import {
	assistantRecovery,
	classifyProviderFailure,
	recordedThrottledLimitWait,
	transferThrottledLimitWait,
} from "./recovery.ts";

/** Whether a failed stream ended before its provider's completion event (owned decision first, smarty-dev#5822). */
export function isPrematureStreamError(message: AssistantMessage): boolean {
	return message.stopReason === "error" && assistantRecovery(message).recovery === "premature_stream";
}

/**
 * The specific Codex disconnect that a session may restart once after discarding its partial response
 * (smarty-dev#11900). Unlike the ordinary classifier, output is allowed here; the caller must ensure no
 * tool from this response has started, enforce the one-shot allowance, and omit the failed attempt.
 */
export function isRetryableCodexStreamDisconnect(message: AssistantMessage): boolean {
	if (
		message.stopReason !== "error" ||
		!message.errorMessage?.includes(
			"stream error: stream disconnected before completion: stream closed before response.completed",
		)
	)
		return false;
	if (
		message.diagnostics?.some(
			(diagnostic) => diagnostic.type === "provider_stream_observer_error" || diagnostic.type === "provider_limit",
		)
	)
		return false;
	// An owned refusal wins; permanent exclusions in a wrapper still win over a retryable decision.
	const recovery = assistantRecovery(message);
	return (
		recovery.retryable &&
		recovery.recovery !== "context_length_exceeded" &&
		classifyProviderFailure({ text: message.errorMessage, provider: message.provider }).retryable
	);
}

/**
 * A parsed Anthropic fallback marker after any content block began (smarty-dev#2890). The owned class is
 * assigned only by that adapter branch, never inferred from error text or the untrusted fallback record.
 * The session must discard this attempt, request the same model, allow at most one retry, and ensure no
 * tool from the failed response has started. Observer errors, limits and aborts remain terminal.
 */
export function isRetryableAnthropicMidOutputFallback(message: AssistantMessage): boolean {
	if (message.api !== "anthropic-messages" || message.stopReason !== "error") return false;
	if (
		message.diagnostics?.some(
			(diagnostic) => diagnostic.type === "provider_stream_observer_error" || diagnostic.type === "provider_limit",
		)
	)
		return false;
	return message.recovery?.recovery === "anthropic_mid_output_fallback" && message.recovery.retryable === true;
}

/** Empty reasoning signatures are metadata, not output. Even a partial tool call is output. */
export function hasAssistantOutput(message: AssistantMessage): boolean {
	return (
		message.usage.output > 0 ||
		message.content.some((block) =>
			block.type === "thinking" ? block.thinking.length > 0 : block.type === "text" ? block.text.length > 0 : true,
		)
	);
}

/** Answer output: non-empty text, any tool call (even partial), or any other non-reasoning block. */
export function hasAssistantAnswerOutput(message: AssistantMessage): boolean {
	return message.content.some((block) =>
		block.type === "thinking" ? false : block.type === "text" ? block.text.length > 0 : true,
	);
}

/**
 * What a stream consumer saw before the terminal message. A provider can drop streamed content from its
 * terminal error message, so the message alone under-reports what consumers already received.
 */
export interface AssistantStreamObservation {
	/** Non-empty reasoning was streamed. */
	reasoning: boolean;
	/** Answer text, a tool call or another non-reasoning block was streamed. */
	answer: boolean;
}

export function createAssistantStreamObservation(): AssistantStreamObservation {
	return { reasoning: false, answer: false };
}

/** Record the content of a (partial) assistant message into `observation`. */
export function observeAssistantMessage(
	observation: AssistantStreamObservation,
	message: AssistantMessage,
): AssistantStreamObservation {
	observation.answer ||= hasAssistantAnswerOutput(message);
	observation.reasoning ||= message.content.some((block) => block.type === "thinking" && block.thinking.length > 0);
	return observation;
}

/** Record one stream event, including its partial message, into `observation`. */
export function observeAssistantStreamEvent(
	observation: AssistantStreamObservation,
	event: AssistantMessageEvent,
): AssistantStreamObservation {
	const streamed = ("delta" in event && event.delta.length > 0) || ("content" in event && event.content.length > 0);
	observation.answer ||= event.type.startsWith("toolcall_") || (event.type.startsWith("text_") && streamed);
	observation.reasoning ||= event.type.startsWith("thinking_") && streamed;
	return observeAssistantMessage(
		observation,
		event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial,
	);
}

/**
 * A premature close that streamed only reasoning (smarty-dev#6730): no answer output, and either non-empty
 * thinking in the message or reasoning observed in the stream. Its output tokens are reasoning, so the attempt
 * can be discarded and restarted. Without `observed`, a message whose content is empty thinking or was
 * dropped is not reasoning-only, because its reported output tokens could be answer text.
 */
export function isReasoningOnlyPrematureStream(
	message: AssistantMessage,
	observed?: AssistantStreamObservation,
): boolean {
	if (!isPrematureStreamError(message) || observed?.answer === true || hasAssistantAnswerOutput(message)) return false;
	return (
		observed?.reasoning === true ||
		message.content.some((block) => block.type === "thinking" && block.thinking.length > 0)
	);
}

/**
 * Drop the partial reasoning of an attempt that will be restarted. Thinking blocks keep their place
 * but lose text and replay signatures. Empty thinking is no evidence of reasoning, so a caller that
 * classifies the result again must pass an observation that recorded the original message.
 */
export function discardPartialReasoning<T extends AssistantMessage>(message: T): T {
	if (!message.content.some((block) => block.type === "thinking")) return message;
	return {
		...message,
		content: message.content.map((block) => (block.type === "thinking" ? { type: "thinking", thinking: "" } : block)),
	};
}

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * `maxAgentDelayMs` caps each computed delay and defaults to 60 seconds.
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`, `maxAgentDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
	/** Optional cap for agent-level retry delays in ms. Defaults to 60 seconds. */
	maxAgentDelayMs?: number;
}

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

export function retryDelayMs(policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const produced = await produce();
		// Classify first: the decision comes from the original text, before it is masked (smarty-dev#5822 C3).
		const recovery = produced.stopReason === "error" ? assistantRecovery(produced) : produced.recovery;
		const errorMessage =
			produced.errorMessage === undefined ? undefined : redactOAuthDiagnostic(produced.errorMessage);
		// A direct producer bypasses the stream projection, so rebuild its diagnostics here (smarty-dev#5822 N5682).
		const { diagnostics: rawDiagnostics, ...rest } = produced;
		const diagnostics = projectAssistantMessageDiagnostics(rawDiagnostics);
		const response =
			errorMessage === produced.errorMessage && recovery === produced.recovery && rawDiagnostics === undefined
				? produced
				: {
						...rest,
						...(errorMessage === undefined ? {} : { errorMessage }),
						...(recovery === undefined ? {} : { recovery }),
						...(diagnostics === undefined ? {} : { diagnostics }),
					};
		if (response !== produced) transferThrottledLimitWait(produced, response);

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = retryDelayMs(policy!, attempt);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				const { errorMessage: _errorMessage, ...rest } = response;
				return { ...rest, stopReason: "aborted" };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/** Owned status text while waiting out a throttled limit; the provider's wait text is never kept. */
export const THROTTLED_LIMIT_WAIT_MESSAGE = "Flash runs one request at a time";

export { recordThrottledLimitWait, transferThrottledLimitWait } from "./recovery.ts";

/**
 * The one-shot wait a provider marked on a throttled limit (the Smarty gateway's `smarty_limit` with
 * `throttled: true` and a `Retry-After` of at most 30 s): the delay and the owned status text to show while
 * waiting. Independent of {@link isRetryableAssistantError}, which stays false for the same message.
 */
export function throttledLimitWait(message: AssistantMessage): { delayMs: number; waitMessage: string } | undefined {
	if (message.stopReason !== "error") return undefined;
	const seconds = recordedThrottledLimitWait(message);
	return seconds === undefined ? undefined : { delayMs: seconds * 1000, waitMessage: THROTTLED_LIMIT_WAIT_MESSAGE };
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 *
 * Stream consumers should pass what they observed: output seen in the stream blocks a retry even when the
 * terminal message dropped it, and observed reasoning lets a premature close whose content was dropped be
 * restarted.
 */
export function isRetryableAssistantError(message: AssistantMessage, observed?: AssistantStreamObservation): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	// Marker recovery requires the dedicated one-shot policy even for an empty thinking/text start block.
	if (message.recovery?.recovery === "anthropic_mid_output_fallback") return false;
	// Output is never replayed, except reasoning-only output on a premature close (smarty-dev#6730).
	const output = hasAssistantOutput(message) || observed?.answer === true || observed?.reasoning === true;
	if (output && !isReasoningOnlyPrematureStream(message, observed)) return false;
	// An observer can fail after receiving generated output but before normalization records it.
	// Retrying its transient-looking error would regenerate output, not repair the observer.
	if (message.diagnostics?.some((diagnostic) => diagnostic.type === "provider_stream_observer_error")) return false;
	// Providers mark a limit found in the parsed error body (e.g. the Smarty gateway's `smarty_limit`).
	if (message.diagnostics?.some((diagnostic) => diagnostic.type === "provider_limit")) return false;
	// The owned decision was classified from the original error before any text suppression (smarty-dev#5822).
	return assistantRecovery(message).retryable;
}
