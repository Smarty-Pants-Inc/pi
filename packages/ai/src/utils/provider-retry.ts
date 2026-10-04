import { redactOAuthDiagnostic } from "../auth/oauth/credential-response.ts";
import type { ProviderRequestOptions } from "../types.ts";
import { smartyLimitMessage } from "./error-body.ts";

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

interface ProviderRetryOptions extends Pick<ProviderRequestOptions, "beforeProviderRequest"> {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
	diagnosticSecrets?: readonly string[];
}

interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
	return (
		(error.status === undefined || typeof error.status === "number") &&
		(error.headers === undefined || error.headers instanceof Headers)
	);
}

/** Mirrors the pinned OpenAI/Anthropic SDK retry policy; review when either SDK is upgraded. */
function isRetryableProviderError(error: ProviderError): boolean {
	if (smartyLimitMessage(error) !== undefined) return false;
	const body = (error as ProviderError & { error?: { code?: unknown; type?: unknown } }).error;
	if (
		body?.code === "subscription_sharing_usage_limit_exceeded" ||
		body?.type === "subscription_sharing_usage_limit_exceeded"
	)
		return false;
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;

	if (error.status === undefined) return true;
	return (
		error.status === 408 ||
		error.status === 409 ||
		error.status === 429 ||
		(typeof error.status === "number" && error.status >= 500)
	);
}

function validateServerRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	providerErrorMessage: string,
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		throw new Error(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`,
		);
	}
	return delayMs;
}

function getRetryDelayMs(
	error: ProviderError,
	retryIndex: number,
	maxRetryDelayMs: number | undefined,
	secrets?: readonly string[],
): number {
	const message = redactOAuthDiagnostic(error.message, secrets);
	const retryAfterMs = error.headers?.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value)) return validateServerRetryDelayMs(value, maxRetryDelayMs, message);
	}

	const retryAfter = error.headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		if (Number.isFinite(delayMs)) return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, message);
	}

	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return exponentialDelay * (1 - Math.random() * 0.25);
}

/** Terminal, body-free refusal shared by admission and cancellation paths. */
export class ProviderRequestLimitError extends Error {
	constructor(requests: number, limit: number) {
		super(`Provider request limit reached (${requests}/${limit}); no further requests allowed`);
		this.name = "ProviderRequestLimitError";
	}
}

function createAbortError(signal?: AbortSignal): Error {
	if (signal?.reason instanceof ProviderRequestLimitError) return signal.reason;
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError(signal));
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(createAbortError(signal));
		};
		const timeout = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Check cancellation and dispatch admission immediately before a physical attempt. */
export function checkProviderRequest(options?: Pick<ProviderRequestOptions, "signal" | "beforeProviderRequest">): void {
	if (options?.signal?.aborted) throw createAbortError(options.signal);
	options?.beforeProviderRequest?.();
}

/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 */
export async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options: ProviderRetryOptions = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	let retriesRemaining = maxRetries;

	for (;;) {
		// Admission failures are terminal, not provider errors to retry.
		checkProviderRequest(options);
		try {
			// Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
			return await request();
		} catch (error) {
			if (options.signal?.aborted) throw createAbortError(options.signal);
			if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error)) throw error;

			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			await abortableSleep(
				getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs, options.diagnosticSecrets),
				options.signal,
			);
		}
	}
}
