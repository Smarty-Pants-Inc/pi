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
// composes into its display string. The `messageCarriesBody` flag captures the
// Anthropic / `@google/genai` happy path where the SDK already folded the body
// into the message, so providers can preserve it without double-printing.

import { OAuthDiagnosticError, oauthRecoveryDecision, safeOAuthError } from "../auth/oauth/credential-response.ts";
import type { OAuthRecoveryDecision } from "../types.ts";
import { isProviderContextOverflow } from "./provider-error-classification.ts";

export { getOAuthDiagnosticSecrets } from "../auth/oauth/credential-response.ts";

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

export interface NormalizedProviderError {
	/** Present only when the OAuth projection classified the untrusted error before suppression. */
	oauthRecovery?: OAuthRecoveryDecision;
	diagnosticHint?: "bedrock_data_retention";
	/** HTTP status code, when one could be extracted from the SDK error object. */
	status?: number;
	/** Raw HTTP body reason, already trimmed and truncated to the cap. */
	body?: string;
	/** `error.message`, or `safeJsonStringify(error)` for a non-`Error` throw. */
	message: string;
	/** True when `message` already contains the body (no separate body to add). */
	messageCarriesBody: boolean;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
	code?: unknown;
};

export function normalizeProviderError(
	error: unknown,
	_secrets: readonly string[] = [],
	oauthDiagnostics = false,
	provider?: string,
): NormalizedProviderError {
	try {
		const sdkError = (typeof error === "object" && error !== null ? error : {}) as SdkErrorShape;
		const status = extractStatus(sdkError);
		const prefix =
			sdkError.name === "ThrottlingException"
				? "Throttling error: "
				: sdkError.name === "ServiceUnavailableException"
					? "Service unavailable: "
					: "";
		const text = `${prefix}${typeof sdkError.message === "string" ? sdkError.message : typeof error === "string" ? error : ""} ${pickBodyText(sdkError) ?? ""}`;
		const safe =
			error instanceof OAuthDiagnosticError
				? safeOAuthError(error, true)
				: safeOAuthError({ status, message: text, error: sdkError.error, code: sdkError.code }, true);
		const decision = oauthRecoveryDecision(safe);
		if (isProviderContextOverflow(text, provider)) decision.recovery = "context_length_exceeded";
		return {
			status: safe.status,
			message: oauthDiagnostics ? safe.message : safe.message.replace(/^oauth_/, "provider_"),
			messageCarriesBody: true,
			oauthRecovery: decision,
			...(/data retention mode/i.test(text) && provider === "amazon-bedrock"
				? { diagnosticHint: "bedrock_data_retention" as const }
				: {}),
		};
	} catch {
		const safe = safeOAuthError(undefined, true);
		return {
			message: oauthDiagnostics ? safe.message : safe.message.replace(/^oauth_/, "provider_"),
			messageCarriesBody: true,
			oauthRecovery: oauthRecoveryDecision(safe),
		};
	}
}

/**
 * Probe the HTTP status, first numeric hit wins, in SDK-field order:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	for (const status of [
		error.statusCode,
		error.status,
		error.$metadata?.httpStatusCode,
		error.$response?.statusCode,
	]) {
		if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return status;
	}
	return undefined;
}

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
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		return prefix !== undefined && norm.status !== undefined
			? `${prefix} (${norm.status}): ${norm.message}`
			: norm.message;
	}
	return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}

/** Diagnostic type marking a provider plan/usage limit refusal; the agent must not retry it. */
export { PROVIDER_LIMIT_DIAGNOSTIC } from "../auth/oauth/credential-response.ts";

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

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
