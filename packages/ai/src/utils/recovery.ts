// Universal pre-suppression classification from private provider fields (smarty-dev#5822 C3).
import type { AssistantMessage, AssistantRecovery, AssistantRecoveryClass } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	"GoUsageLimitError",
	"FreeUsageLimitError",
	"Monthly usage limit reached",
	"available balance",
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
	"subscription_sharing_usage_limit_exceeded",
]);
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	"overloaded",
	"\\bSelected model is at capacity\\. Please try a different model\\.",
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
	"service.?(?:is.?)?(?:temporarily.?)?unavailable",
	"server.?error",
	"internal.?error",
	"provider.?returned.?(?:an.?)?error",
	"exceeded request buffer limit while retrying upstream",
	"unable to forward upstream",
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
	"ECONNREFUSED",
	"ECONNRESET",
	"unknown provider for model",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",
	"websocket.?closed",
	"websocket.?error",
	"http2 request did not get a response",
	"pending stream has been canceled",
	"retry delay",
	"you can retry your request",
	"try your request again",
	"please retry your request",
	"ResourceExhausted",
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
]);
const PREMATURE_STREAM_ERROR_PATTERN = buildProviderErrorPattern([
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"stream disconnected before completion",
	"stream closed before response\\.completed",
]);

export const OVERFLOW_PATTERNS = [
	/prompt (?:is )?too long/i,
	/prompt exceeds max length/i,
	/request_too_large/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
	/exceeds the limit of \d+/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/too large for model with \d+ maximum context length/i,
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
	/model_context_window_exceeded/i,
	/prompt too long; exceeded (?:max )?context length/i,
	/range of input length should be/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
];
const CEREBRAS_BODYLESS_OVERFLOW_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;
const NON_OVERFLOW_PATTERNS = [/^(Throttling error|Service unavailable):/i, /rate limit/i, /too many requests/i];

function isOverflowText(text: string, status: number | undefined, provider: string | undefined): boolean {
	if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false;
	if (OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return true;
	if (provider !== "cerebras") return false;
	return CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(text) || ((status === 400 || status === 413) && text.trim() === "");
}
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 520, 524]);

/** Original failure fields, read for classification only and never published. */
export interface ProviderFailureInput {
	text?: string;
	status?: number;
	/** Trusted request provider, never a provider-reported label. */
	provider?: string;
}
export function classifyProviderFailure(input: ProviderFailureInput): AssistantRecovery {
	const text = input.text ?? "";
	const status = validHttpStatus(input.status);
	if (isOverflowText(text, status, input.provider)) return { recovery: "context_length_exceeded", retryable: false };
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(text)) return { retryable: false };
	if (PREMATURE_STREAM_ERROR_PATTERN.test(text)) return { recovery: "premature_stream", retryable: true };
	if (RETRYABLE_PROVIDER_ERROR_PATTERN.test(text) || (status !== undefined && RETRYABLE_STATUSES.has(status))) {
		return { recovery: "retryable", retryable: true };
	}
	return { retryable: false };
}
export function validHttpStatus(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}
const RECOVERY_CLASSES: ReadonlySet<string> = new Set<AssistantRecoveryClass>([
	"retryable",
	"premature_stream",
	"context_length_exceeded",
]);
export function ownedRecovery(value: unknown): AssistantRecovery | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { recovery, retryable } = value as Record<string, unknown>;
	if (typeof retryable !== "boolean") return undefined;
	if (recovery === undefined) return { retryable };
	return typeof recovery === "string" && RECOVERY_CLASSES.has(recovery)
		? { recovery: recovery as AssistantRecoveryClass, retryable }
		: undefined;
}
export function assistantRecovery(message: AssistantMessage): AssistantRecovery {
	return (
		ownedRecovery(message.recovery) ??
		classifyProviderFailure({ text: message.errorMessage, provider: message.provider })
	);
}

// A validated wait never appears on the message or in wire diagnostics.
const throttledLimitWaits = new WeakMap<AssistantMessage, number>();
export function recordThrottledLimitWait(message: AssistantMessage, seconds: number): void {
	if (Number.isInteger(seconds) && seconds >= 0 && seconds <= 30) throttledLimitWaits.set(message, seconds);
}
export function transferThrottledLimitWait(from: AssistantMessage, to: AssistantMessage): void {
	const seconds = throttledLimitWaits.get(from);
	if (seconds !== undefined) throttledLimitWaits.set(to, seconds);
}
export function recordedThrottledLimitWait(message: AssistantMessage): number | undefined {
	return throttledLimitWaits.get(message);
}
