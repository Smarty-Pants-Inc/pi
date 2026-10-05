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
	"quota exceeded",
	"billing",

	// Sign in with ChatGPT: the subscription's shared usage limit, which resets
	// after hours rather than seconds.
	"subscription_sharing_usage_limit_exceeded",
	"usage_limit_reached",
	"usage_not_included",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"\\bSelected model is at capacity\\. Please try a different model\\.",
	"\\bslow_down\\b",
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
	// "Provider returned error" responses (#2264).
	"provider.?returned.?error",
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

const PREMATURE_STREAM_ERROR_PATTERN = buildProviderErrorPattern([
	// Anthropic SDK/transport early endings (#4433), and Responses early EOF.
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	// CLIProxyAPI Responses streams (smarty-dev#3200).
	"stream disconnected before completion",
	"stream closed before response\\.completed",
]);

const OVERFLOW_PATTERNS = [
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

/** Classify untrusted text internally; callers publish only owned codes, never this input. */
export function isPrematureProviderError(text: string): boolean {
	return PREMATURE_STREAM_ERROR_PATTERN.test(text);
}

export function isRetryableProviderError(text: string): boolean {
	return (
		!NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(text) &&
		(isPrematureProviderError(text) || RETRYABLE_PROVIDER_ERROR_PATTERN.test(text))
	);
}

export function isProviderContextOverflow(text: string, provider?: string): boolean {
	return (
		!NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text)) &&
		(OVERFLOW_PATTERNS.some((pattern) => pattern.test(text)) ||
			(provider === "cerebras" && CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(text)))
	);
}

export function getProviderOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
