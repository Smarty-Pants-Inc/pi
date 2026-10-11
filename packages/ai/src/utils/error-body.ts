// Shared normalization for provider HTTP error objects.
//
// Endpoints behind a proxy / gateway may return a non-2xx response whose body
// the provider SDK cannot fold into `error.message`. The SDK error object still
// carries the HTTP status and the raw/parsed body, but under SDK-specific field
// names. Provider catch blocks that read only `error.message` therefore drop
// the body and surface opaque messages like `"403 status code (no body)"` or
// collapse to `"Unknown: UnknownError"`.
//
// `normalizeProviderError` probes the known SDK field shapes (Mistral,
// `openai`, `@google/genai`, AWS Bedrock). The message and body it reads stay
// private: they only classify the failure (smarty-dev#5822, pi#202 round 2).
// `formatProviderError` renders owned text from the validated status and the
// owned recovery class, never from provider text.

import { redactOAuthDiagnostic } from "../auth/oauth/credential-response.ts";
import type { AssistantRecovery } from "../types.ts";
import { ProviderRequestLimitError } from "./provider-retry.ts";
import { classifyProviderFailure, validHttpStatus } from "./recovery.ts";

/** Owned values of a provider error: nothing in it is provider text. */
export interface NormalizedProviderError {
	/** HTTP status, only from the dedicated SDK status fields and only as an integer 100-599. */
	status?: number;
	/** Owned recovery decision, classified from the original message, body and status. */
	recovery: AssistantRecovery;
	/**
	 * Message of a local failure: an `Error` that carries no provider response field (no status, body or parsed
	 * error), such as Pi's own validation and timeout errors or a transport failure. Provider responses never set it.
	 */
	localMessage?: string;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

/**
 * Classify a provider error from its private fields. `provider` is the trusted request provider
 * (`model.provider`); it selects provider-specific classification such as Cerebras's bodyless 400/413
 * overflow. `privateText` is further provider text to classify with it (OpenRouter's `metadata.raw`).
 */
export function normalizeProviderError(
	error: unknown,
	provider?: string,
	privateText?: string,
	secrets: readonly string[] = [],
): NormalizedProviderError {
	const status = error instanceof Error ? extractStatus(error as SdkErrorShape) : undefined;
	const text = privateText ? `${providerErrorText(error)}\n${privateText}` : providerErrorText(error);
	const recovery = classifyProviderFailure({ text, status, provider });
	if (status !== undefined) return { status, recovery };
	// ponytail: label-based masking stays on local text until the universal owned rendering (next slice).
	return isLocalError(error)
		? { recovery, localMessage: redactOAuthDiagnostic(error.message, secrets) }
		: { recovery };
}

/** An `Error` with no provider response field: its text was written by Pi or the transport, not the provider. */
function isLocalError(error: unknown): error is Error {
	if (!(error instanceof Error) || !error.message) return false;
	// Pi's own admission refusal, even after an SDK attached response metadata to it.
	if (error instanceof ProviderRequestLimitError) return true;
	const fields = error as SdkErrorShape;
	return (
		fields.statusCode === undefined &&
		fields.status === undefined &&
		(fields.body === undefined || fields.body === "") &&
		fields.error === undefined &&
		fields.$metadata === undefined &&
		fields.$response === undefined
	);
}

/**
 * The original provider message and body. PRIVATE: read it only to classify or recognize a failure; never
 * publish it, in whole or in part.
 */
export function providerErrorText(error: unknown): string {
	if (!(error instanceof Error)) return safeJsonStringify(error);
	const body = pickBodyText(error as SdkErrorShape);
	return body === undefined ? error.message : `${error.message}\n${body}`;
}

/**
 * Probe the HTTP status, first integer 100-599 wins, in SDK-field order:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	return (
		validHttpStatus(error.statusCode) ??
		validHttpStatus(error.status) ??
		validHttpStatus(error.$metadata?.httpStatusCode) ??
		validHttpStatus(error.$response?.statusCode)
	);
}

/**
 * Probe the raw body reason, first usable hit wins, in SDK-field order:
 * `body` string (Mistral) → `error` parsed JSON body object (`openai` SDK's
 * `this.error`) → `$response.body` (Bedrock). Empty objects and unread response
 * streams are treated as no body. Private: classification input only.
 */
function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * Only a PLAIN object counts as an HTTP body. SDK error fields can hold class
 * instances instead of parsed bodies — AWS SDK v3's `$response.body` is an
 * HTTP stream/response wrapper object, and stringifying one produced garbage
 * like `{"_events":...}` as the "body", which then REPLACED `error.message`
 * in the composed display string. `error.message` is where the SDK puts the
 * real deserialized exception text ("Input is too long...", schema validation
 * details, ...), so the one useful string was discarded for noise. A class
 * instance yields no body, `messageCarriesBody` stays true, and the real
 * message survives. Complements the `pipe` sniffing above: web
 * ReadableStreams (pipeTo/pipeThrough, no `pipe`) and non-stream SDK wrapper
 * classes fail the prototype check, while parsed JSON bodies (plain objects
 * by construction) still pass.
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value).length > 0;
}

/**
 * Owned display text for a provider error (smarty-dev#5822, pi#202 round 2): the caller's Pi-side label, the
 * validated HTTP status and the owned recovery class, never the provider's message, body or code. The class
 * wording keeps the text classifiable when a message without an owned decision is read back.
 *
 * - `"<label> (<status>): <class>"`, with each part present only when known
 * - a local failure (Pi's own or the transport's, never a provider response) keeps its masked message
 */
export function formatProviderError(norm: NormalizedProviderError, label = "Provider request failed"): string {
	if (norm.localMessage !== undefined) return norm.localMessage;
	const status = norm.status === undefined ? "" : ` (${norm.status})`;
	const detail =
		norm.recovery.recovery === "context_length_exceeded"
			? ": context length exceeded"
			: norm.recovery.recovery === "premature_stream"
				? ": stream ended without completing"
				: norm.recovery.retryable && norm.status === undefined
					? ": network or server error"
					: "";
	return `${label}${status}${detail}`;
}

/** Diagnostic type marking a provider plan/usage limit refusal; the agent must not retry it. */
export const PROVIDER_LIMIT_DIAGNOSTIC = "provider_limit";

/**
 * The Smarty Node gateway's plan-limit refusal: a 429 whose parsed body (`openai` SDK `error.error`) has
 * `code` or `type` `smarty_limit`. Returns the gateway's message to show as-is, or undefined for any other error.
 * It is final until the window resets, so neither the provider nor the agent retries it.
 */
export function smartyLimitMessage(error: unknown): string | undefined {
	const body = (error as { error?: unknown } | null | undefined)?.error;
	if (typeof body !== "object" || body === null) return undefined;
	const { code, type, message } = body as Record<string, unknown>;
	if (code !== "smarty_limit" && type !== "smarty_limit") return undefined;
	return typeof message === "string" && message.length > 0 ? message : "smarty_limit";
}

/**
 * A throttled `smarty_limit` (`throttled: true`: the org already has a request in flight) with an integer
 * `Retry-After` of at most 30 seconds. Returns those seconds, or undefined for any other error, including
 * period and size limits (`throttled: false`) and a missing, longer or non-integer `Retry-After`.
 * The agent waits that long and retries once; this is not a retry the provider or the generic retry loop makes.
 */
export function smartyThrottleRetryAfterSeconds(error: unknown): number | undefined {
	if (smartyLimitMessage(error) === undefined) return undefined;
	const { error: body, headers } = error as { error: { throttled?: unknown }; headers?: unknown };
	if (body.throttled !== true || !(headers instanceof Headers)) return undefined;
	const retryAfter = headers.get("retry-after")?.trim();
	if (!retryAfter || !/^\d+$/.test(retryAfter)) return undefined;
	const seconds = Number(retryAfter);
	return seconds <= 30 ? seconds : undefined;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
