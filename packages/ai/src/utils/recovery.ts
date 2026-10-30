// One universal pre-suppression classifier for failed provider responses (smarty-dev#5822 C3).
//
// Every source (API key, OAuth, custom provider, extension, model-less stream) is classified from its
// original error text, HTTP status and provider before any public text is replaced. The decision is a closed,
// Pi-owned record on `AssistantMessage.recovery`; retry, premature-stream and overflow checks read it first.

import type { AssistantMessage, AssistantRecovery, AssistantRecoveryClass } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota[_ ]exceeded",
	"billing",

	// Sign in with ChatGPT: the subscription's shared usage limit, which resets
	// after hours rather than seconds.
	"subscription_sharing_usage_limit_exceeded",

	// Known final gateway/ChatGPT refusals can arrive as streamed codes or error types without a
	// provider_limit diagnostic. They must win over an accompanying HTTP 5xx (smarty-dev#16938).
	"\\bsmarty_limit\\b",
	"\\busage_limit_reached\\b",
	"\\busage_not_included\\b",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"\\bSelected model is at capacity\\. Please try a different model\\.",
	"\\bslow_down\\b",
	"server_busy",
	"servers are currently busy",
	"currently experiencing high demand",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"520",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264) and gateway wording such as
	// "The upstream provider returned an error" (#10842).
	"provider.?returned.?(?:an.?)?error",
	"exceeded request buffer limit while retrying upstream",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	// A local gateway (CLIProxyAPI) mid-restart refuses or drops the socket (smarty-dev#1856).
	"ECONNREFUSED",
	"ECONNRESET",
	// CLIProxyAPI answers 400 while it reloads models after a restart (smarty-dev#1856).
	// ponytail: a truly unknown model now retries the normal budget (~14 s) before it fails.
	"unknown provider for model",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"http2 request did not get a response",
	// Node ERR_HTTP2_STREAM_CANCEL: the HTTP/2 session died before the request was
	// sent, e.g. after the Bedrock SDK's 5-minute session timeout (#10379).
	"pending stream has been canceled",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",

	// Sign in with ChatGPT: usage or user data temporarily unavailable. Usage
	// failures can arrive mid-stream without an HTTP 503 in the message.
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
]);

// smarty-dev#16938: the one-shot mid-output replay is a positive allowlist, separate from ordinary retryability.
// Only these exact provider error codes/types, or a dedicated HTTP 529, name an overload. A bare 5xx, overload
// wording in free text and transport failures do not.
const MIDSTREAM_OVERLOAD_CODES: ReadonlySet<string> = new Set([
	"server_is_overloaded", // OpenAI
	"overloaded_error", // Anthropic-shaped errors relayed by OpenAI-compatible gateways
	"upstream overloaded",
]);

// Any rate, quota, limit or throttle signal in the text or a code vetoes the replay, even beside an overload code.
// Word families, not spellings: any "exceeded", usage or credit wording, request/token time windows, RPM/TPM/RPS/QPS,
// concurrency and exhaustion. The veto is deliberately broad: a false match only leaves the failure final, as it was
// before this replay existed.
const MIDSTREAM_RATE_OR_QUOTA_PATTERN =
	/rate|quota|limit|exceed|throttl|too[\s_-]*many|(?<!\d)429(?!\d)|per[\s_-]*(?:\d+[\s_-]*)?(?:milli|sec|min|hour|day|week|month)|\b[rtq]p[ms]\b|concurren|in[\s_-]*flight|exhaust|slow[\s_-]*down|usage|credit|insufficient/i;

/** A provider overload with no rate/quota signal anywhere and no client-error status (smarty-dev#16938). */
function isMidstreamOverload(text: string, status: number | undefined, codes: readonly string[]): boolean {
	// Includes 429: a client-error or rate-limit status contradicts an overload.
	if (status !== undefined && status < 500) return false;
	if (MIDSTREAM_RATE_OR_QUOTA_PATTERN.test(text) || codes.some((code) => MIDSTREAM_RATE_OR_QUOTA_PATTERN.test(code))) {
		return false;
	}
	return status === 529 || codes.some((code) => MIDSTREAM_OVERLOAD_CODES.has(code));
}

const PREMATURE_STREAM_ERROR_PATTERN = buildProviderErrorPattern([
	// Anthropic SDK/transport early endings (#4433), and Responses early EOF.
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	// CLIProxyAPI Responses streams (smarty-dev#3200).
	"stream disconnected before completion",
	"stream closed before response\\.completed",
]);

/**
 * Regex patterns to detect context overflow errors from different providers.
 *
 * These patterns match error messages returned when the input exceeds
 * the model's context window.
 *
 * Provider-specific patterns (with example error messages):
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - Anthropic: "413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - OpenAI/LiteLLM: "Requested token count exceeds the model's maximum context length of 131072 tokens"
 * - OpenAI-compatible: "Input length (265330) exceeds model's maximum context length (262144)."
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - Cerebras: "400/413 status code (no body)"
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - z.ai: `{"code":"1261","message":"Prompt too long"}`, `{"code":"1261","message":"Prompt exceeds max length"}` (CN endpoint), or silent overflow via usage.input > contextWindow
 * - Xiaomi MiMo: Truncates input to fill contextWindow exactly, then returns finish_reason "length"
 *   with output=0 (no room left to generate). Detected via stopReason "length" + zero output +
 *   input filling the context window.
 * - DashScope/Qwen: "Range of input length should be [1, X]" (HTTP 400 invalid_parameter_error)
 * - Ollama: Some deployments truncate silently, others return errors like "prompt too long; exceeded max context length by X tokens"
 */
export const OVERFLOW_PATTERNS = [
	/prompt (?:is )?too long/i, // Anthropic and z.ai token overflow
	/prompt exceeds max length/i, // z.ai CN endpoint token overflow
	/request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (most backends)
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
	/prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
	/range of input length should be/i, // DashScope / Qwen Token Plan
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
];

const CEREBRAS_BODYLESS_OVERFLOW_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

/**
 * Patterns that indicate non-overflow errors (e.g. rate limiting, server errors).
 * Error messages matching any of these are excluded from overflow detection
 * even if they also match an OVERFLOW_PATTERN.
 *
 * Example: Bedrock formats throttling errors as "ThrottlingException: Too many tokens,
 * please wait before trying again." which would match the /too many tokens/i overflow
 * pattern without this exclusion.
 */
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors (human-readable prefixes from formatBedrockError)
	/rate limit/i, // Generic rate limiting
	/too many requests/i, // Generic HTTP 429 style
];

/** Text-only context-overflow check; the throttling and rate-limit exclusions take precedence. */
function isOverflowText(text: string, status: number | undefined, provider: string | undefined): boolean {
	if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false;
	if (OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return true;
	if (provider !== "cerebras") return false;
	// Cerebras answers an oversized request with a bodyless 400/413.
	return CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(text) || ((status === 400 || status === 413) && text.trim() === "");
}

/** HTTP statuses that the retryable text patterns already accept as transient. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 520, 524]);

/** Original failure fields. They are read for classification only and never published. */
export interface ProviderFailureInput {
	/** Original error text: message and, when extracted, the raw body. */
	text?: string;
	/** HTTP status from the dedicated SDK status fields. */
	status?: number;
	/** Trusted request provider (`model.provider`), never a provider-reported label. */
	provider?: string;
	/** Exact provider error code/type values from dedicated fields. Only these can name an overload. */
	codes?: readonly string[];
}

/**
 * Classify one failure. Precedence matches the text checks it replaces: context overflow, then quota and
 * billing refusals (never retried), then premature stream ends, then transient load and transport failures.
 */
export function classifyProviderFailure(input: ProviderFailureInput): AssistantRecovery {
	const text = input.text ?? "";
	// The local byte-size refusal is not a token overflow or a transient failure. Check the owned wording
	// before numeric sizes such as "500 MiB" can accidentally match the generic HTTP-status retry patterns.
	if (/^request too large: [\d.]+ MiB > [\d.]+ MiB; start a new session or reduce attachments$/.test(text)) {
		return { retryable: false };
	}
	const status = validHttpStatus(input.status);
	if (isOverflowText(text, status, input.provider)) return { recovery: "context_length_exceeded", retryable: false };
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(text)) return { retryable: false };
	const midstream = isMidstreamOverload(text, status, input.codes ?? []) ? { midstream: "overload" as const } : {};
	if (PREMATURE_STREAM_ERROR_PATTERN.test(text)) {
		return { recovery: "premature_stream", retryable: true, ...midstream };
	}
	if (RETRYABLE_PROVIDER_ERROR_PATTERN.test(text) || (status !== undefined && RETRYABLE_STATUSES.has(status))) {
		return { recovery: "retryable", retryable: true, ...midstream };
	}
	return { retryable: false, ...midstream };
}

/** An HTTP status only from a dedicated status field, and only as an integer 100-599. */
export function validHttpStatus(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

const RECOVERY_CLASSES: ReadonlySet<string> = new Set<AssistantRecoveryClass>([
	"retryable",
	"premature_stream",
	"context_length_exceeded",
	"anthropic_mid_output_fallback",
]);

/** Rebuild a recovery decision from its closed fields; anything else is not a decision. */
export function ownedRecovery(value: unknown): AssistantRecovery | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { recovery, retryable, midstream } = value as Record<string, unknown>;
	if (typeof retryable !== "boolean") return undefined;
	const allowance = midstream === "overload" ? { midstream: "overload" as const } : {};
	if (recovery === undefined) return { retryable, ...allowance };
	return typeof recovery === "string" && RECOVERY_CLASSES.has(recovery)
		? { recovery: recovery as AssistantRecoveryClass, retryable, ...allowance }
		: undefined;
}

/**
 * The recovery decision of a failed message: its owned decision, or, for a message that has none (a hand-built,
 * persisted or extension message), a classification of its error text and provider.
 */
export function assistantRecovery(message: AssistantMessage): AssistantRecovery {
	return (
		ownedRecovery(message.recovery) ??
		classifyProviderFailure({ text: message.errorMessage, provider: message.provider })
	);
}

/**
 * Validated one-shot waits, in seconds, keyed by the failed message. Private by construction: the delay never
 * appears on the message, so it is never serialized, published or rebuilt from wire diagnostics (smarty-dev#5822).
 */
const throttledLimitWaits = new WeakMap<AssistantMessage, number>();

/**
 * Record the one-shot wait of a throttled provider limit on `message`. Only an integer of 0-30 seconds is kept;
 * anything else records nothing, so the limit stays final.
 */
export function recordThrottledLimitWait(message: AssistantMessage, seconds: number): void {
	if (Number.isInteger(seconds) && seconds >= 0 && seconds <= 30) throttledLimitWaits.set(message, seconds);
}

/** Carry a recorded wait to a published copy of the message. */
export function transferThrottledLimitWait(from: AssistantMessage, to: AssistantMessage): void {
	const seconds = throttledLimitWaits.get(from);
	if (seconds !== undefined) throttledLimitWaits.set(to, seconds);
}

export function recordedThrottledLimitWait(message: AssistantMessage): number | undefined {
	return throttledLimitWaits.get(message);
}
