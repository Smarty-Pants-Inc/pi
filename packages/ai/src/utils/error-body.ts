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
import { RequestTooLargeError } from "./request-size.ts";

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
	// This local admission refusal must not become a provider error or token-overflow retry, even if an SDK
	// attached response metadata. Rebuild its actionable text from owned byte counts, not mutable error text.
	if (error instanceof RequestTooLargeError) {
		return {
			recovery: { retryable: false },
			localMessage: new RequestTooLargeError(error.requestBytes, error.maxRequestBytes).message,
		};
	}
	// OpenAI's stream errors keep the parsed SSE error body but have no outer HTTP status.
	// A genuine SDK response status always takes precedence over that body's dedicated status fields.
	const status =
		error instanceof Error
			? (providerErrorStatus(error) ?? providerErrorStatus((error as SdkErrorShape).error))
			: undefined;
	const text = privateText ? `${providerErrorText(error)}\n${privateText}` : providerErrorText(error);
	const recovery = classifyProviderFailure({ text, status, provider, codes: providerErrorCodes(error) });
	if (status !== undefined) return { status, recovery };
	// ponytail: label-based masking stays on local text until the universal owned rendering (next slice).
	return isLocalError(error)
		? { recovery, localMessage: redactOAuthDiagnostic(error.message, secrets) }
		: { recovery };
}

/** Private provider text of errors adapters build from provider data; never on the error object itself. */
const providerDataTexts = new WeakMap<object, string>();
/** Private exact error code/type values of those errors, kept apart from the text for classification only. */
const providerDataCodes = new WeakMap<object, readonly string[]>();

/**
 * An error an adapter builds from provider data (a stream error event, a failed response, an unparsable frame).
 * Where it came from decides how it is published, not which fields it has: it is never a local error. Its
 * message, name and stack are owned; the provider text is kept in a module-private map for classification only,
 * and it has no `cause` or payload (smarty-dev#5822, pi#202 round 3).
 */
export class ProviderDataError extends Error {
	readonly status?: number;

	constructor(privateText: string, status?: number, name = "ProviderDataError", codes: readonly unknown[] = []) {
		super("Provider request failed");
		this.name = name;
		const valid = validHttpStatus(status);
		if (valid !== undefined) this.status = valid;
		providerDataTexts.set(this, privateText);
		providerDataCodes.set(this, stringValues(codes));
	}
}

/** A closed provider label for owned text: the configured id only when it is a plain slug, else `provider`. */
export function providerLabel(provider: string): string {
	return /^[a-z0-9-]{1,40}$/.test(provider) ? provider : "provider";
}

/**
 * Local means only Pi's own validation and timeout errors and transport errors raised by Node or the fetch layer:
 * an `Error` that no adapter built from provider data and that carries no provider response field.
 */
function isLocalError(error: unknown): error is Error {
	if (!(error instanceof Error) || !error.message) return false;
	if (error instanceof ProviderDataError) return false;
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
	const dataText = providerDataTexts.get(error);
	if (dataText !== undefined) return dataText;
	const body = pickBodyText(error as SdkErrorShape);
	return body === undefined ? error.message : `${error.message}\n${body}`;
}

/**
 * Exact provider error code/type values, PRIVATE and for classification only: an adapter-built error's recorded
 * values, else the SDK error's `code`/`type` and its parsed body's `code`/`type` (`openai` SDK `error.error`).
 * Only strings count; nothing is parsed out of free text.
 */
function providerErrorCodes(error: unknown): string[] {
	if (!(error instanceof Error)) return [];
	const dataCodes = providerDataCodes.get(error);
	if (dataCodes !== undefined) return [...dataCodes];
	const fields = error as SdkErrorShape & { code?: unknown; type?: unknown };
	const body =
		typeof fields.error === "object" && fields.error !== null
			? (fields.error as { code?: unknown; type?: unknown })
			: undefined;
	return stringValues([fields.code, fields.type, body?.code, body?.type]);
}

function stringValues(values: readonly unknown[]): string[] {
	return values.filter((value): value is string => typeof value === "string" && value !== "");
}

/**
 * Probe dedicated HTTP status fields on an SDK error or parsed provider error, first integer 100-599 wins:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 * Never infer a status from provider text, error codes or other numeric fields.
 */
export function providerErrorStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const fields = error as SdkErrorShape;
	return (
		validHttpStatus(fields.statusCode) ??
		validHttpStatus(fields.status) ??
		validHttpStatus(fields.$metadata?.httpStatusCode) ??
		validHttpStatus(fields.$response?.statusCode)
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

/** Owned names of the gateway's limit windows; any other window is called the plan limit. */
const SMARTY_LIMIT_WINDOWS: Readonly<Record<string, string>> = {
	"5h": "5-hour",
	day: "daily",
	"1d": "daily",
	week: "weekly",
	"7d": "weekly",
	month: "monthly",
};

/** Owned wait text of a throttled limit (one request in flight). */
export const SMARTY_THROTTLE_MESSAGE = "Flash runs one request at a time";

/** The latest reset Pi shows; a later or invalid time is omitted. */
const MAX_SMARTY_RESET_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * The Smarty Node gateway's plan-limit refusal: a 429 whose parsed body (`openai` SDK `error.error`) has
 * `code` or `type` `smarty_limit`. Returns OWNED text, or undefined for any other error (smarty-dev#5822,
 * pi#202 round 3): the gateway's own message is never published. The text uses only a closed window name and a
 * reset time Pi formats from a bounded timestamp. It is final until the window resets, so neither the provider
 * nor the agent retries it.
 */
export function smartyLimitMessage(error: unknown): string | undefined {
	const body = (error as { error?: unknown } | null | undefined)?.error;
	if (typeof body !== "object" || body === null) return undefined;
	const { code, type, throttled, window, resets_at: resetsAt } = body as Record<string, unknown>;
	if (code !== "smarty_limit" && type !== "smarty_limit") return undefined;
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
