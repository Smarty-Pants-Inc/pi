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
// `openai`, `@google/genai`, AWS Bedrock) and returns a struct each provider
// uses only to classify the failure. Provider text never becomes public error text.

import { redactOAuthDiagnostic } from "../auth/oauth/credential-response.ts";
import type { AssistantRecovery } from "../types.ts";
import { classifyProviderFailure, isSmartyLimitError, ProviderRequestLimitError, validHttpStatus } from "./recovery.ts";

export interface NormalizedProviderError {
	/** HTTP status code, when one could be extracted from the SDK error object. */
	status?: number;
	/** Owned decision classified before suppression. */
	recovery: AssistantRecovery;
	/** Masked local validation/transport failure, never provider response text. */
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
	return isLocalError(error)
		? { recovery, localMessage: redactOAuthDiagnostic(error.message, secrets) }
		: { recovery };
}

const providerDataTexts = new WeakMap<object, string>();

/** Provider-origin failures have owned name/message/stack and no raw payload or cause. */
export class ProviderDataError extends Error {
	readonly status?: number;

	constructor(privateText: string, status?: number, name = "ProviderDataError") {
		super("Provider request failed");
		this.name = name;
		const valid = validHttpStatus(status);
		if (valid !== undefined) this.status = valid;
		providerDataTexts.set(this, privateText);
	}
}
export function providerLabel(provider: string): string {
	return /^[a-z0-9-]{1,40}$/.test(provider) ? provider : "provider";
}
function isLocalError(error: unknown): error is Error {
	if (!(error instanceof Error) || !error.message) return false;
	if (error instanceof ProviderDataError) return false;
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
/** Private classification input only; never publish this text. */
export function providerErrorText(error: unknown): string {
	if (!(error instanceof Error)) return safeJsonStringify(error);
	const dataText = providerDataTexts.get(error);
	if (dataText !== undefined) return dataText;
	const body = pickBodyText(error as SdkErrorShape);
	return body === undefined ? error.message : `${error.message}\n${body}`;
}

/**
 * Probe the HTTP status, first numeric hit wins, in SDK-field order:
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
 * streams are treated as no body so they do not surface as `"{}"` or serialized
 * stream internals. The chosen body is truncated to the cap.
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
 * Compose a display string from a normalized error. When the message already
 * carries the body (Anthropic / `@google/genai` happy path) or no body/status
 * was extracted, the message is returned unchanged. Otherwise the status and
 * body are surfaced, with an optional provider prefix.
 *
 * - no prefix: `"<status>: <body>"`
 * - prefix:    `"<prefix> (<status>): <body>"`
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

export const PROVIDER_LIMIT_DIAGNOSTIC = "provider_limit";
const SMARTY_LIMIT_WINDOWS: Readonly<Record<string, string>> = {
	"5h": "5-hour",
	day: "daily",
	"1d": "daily",
	week: "weekly",
	"7d": "weekly",
	month: "monthly",
};
export const SMARTY_THROTTLE_MESSAGE = "Flash runs one request at a time";
const MAX_SMARTY_RESET_MS = 31 * 24 * 60 * 60 * 1000;

/** Render only closed window names and a bounded, locally formatted reset time. */
export function smartyLimitMessage(error: unknown): string | undefined {
	if (!isSmartyLimitError(error)) return undefined;
	const { throttled, window, resets_at: resetsAt } = error.error;
	if (throttled === true) return SMARTY_THROTTLE_MESSAGE;
	const name =
		typeof window === "string" && Object.hasOwn(SMARTY_LIMIT_WINDOWS, window) ? SMARTY_LIMIT_WINDOWS[window] : "plan";
	const resetMs =
		typeof resetsAt === "number" && Number.isFinite(resetsAt)
			? resetsAt * 1000
			: typeof resetsAt === "string"
				? Date.parse(resetsAt)
				: Number.NaN;
	const now = Date.now();
	const reset =
		Number.isFinite(resetMs) && resetMs > now && resetMs - now <= MAX_SMARTY_RESET_MS
			? ` More at ${new Date(resetMs).toISOString().slice(11, 16)}Z.`
			: "";
	return `Your ${name} limit is used up.${reset}`;
}
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
