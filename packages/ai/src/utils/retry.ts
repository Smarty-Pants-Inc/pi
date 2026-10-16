import { redactOAuthDiagnostic } from "../auth/oauth/credential-response.ts";
import type { AssistantMessage } from "../types.ts";
import { projectAssistantMessageDiagnostics } from "./diagnostics.ts";
import {
	assistantRecovery,
	isRetryableAssistantError,
	type RetryPolicy,
	retryDelayMs,
	transferThrottledLimitWait,
} from "./recovery.ts";

export {
	type AssistantStreamObservation,
	createAssistantStreamObservation,
	DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	discardPartialReasoning,
	hasAssistantAnswerOutput,
	hasAssistantOutput,
	isPrematureStreamError,
	isReasoningOnlyPrematureStream,
	isRetryableAssistantError,
	isRetryableCodexStreamDisconnect,
	observeAssistantMessage,
	observeAssistantStreamEvent,
	type RetryPolicy,
	recordThrottledLimitWait,
	retryDelayMs,
	THROTTLED_LIMIT_WAIT_MESSAGE,
	throttledLimitWait,
	transferThrottledLimitWait,
} from "./recovery.ts";

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
		const recovery = produced.stopReason === "error" ? assistantRecovery(produced) : produced.recovery;
		const errorMessage =
			produced.errorMessage === undefined ? undefined : redactOAuthDiagnostic(produced.errorMessage);
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
