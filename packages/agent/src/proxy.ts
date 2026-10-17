/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */

// Internal import for JSON parsing utility
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type AssistantRecovery,
	createAssistantMessageEventStream,
	isContextOverflow,
	isPrematureStreamError,
	isRetryableAssistantError,
	type Model,
	parseStreamingJson,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import { classifyProviderFailure, validHttpStatus } from "@earendil-works/pi-ai/utils/recovery";

// A gateway error stream is untrusted: bound both retained bytes and total classification time.
const MAX_PROXY_ERROR_BYTES = 16 * 1024;
const MAX_PROXY_ERROR_READ_MS = 5_000;

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
			providerThinkingLevel?: string;
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
			providerThinkingLevel?: string;
	  };

type ProxySerializableStreamOptions = Pick<
	SimpleStreamOptions,
	| "temperature"
	| "samplingParams"
	| "maxTokens"
	| "reasoning"
	| "cacheRetention"
	| "sessionId"
	| "headers"
	| "metadata"
	| "transport"
	| "thinkingBudgets"
	| "maxRetryDelayMs"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
	/** Local abort signal for the proxy request */
	signal?: AbortSignal;
	/** Auth token for the proxy server */
	authToken: string;
	/** Proxy server URL (e.g., "https://genai.example.com") */
	proxyUrl: string;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
	return {
		temperature: options.temperature,
		samplingParams: options.samplingParams,
		maxTokens: options.maxTokens,
		reasoning: options.reasoning,
		cacheRetention: options.cacheRetention,
		sessionId: options.sessionId,
		headers: options.headers,
		metadata: options.metadata,
		transport: options.transport,
		thinkingBudgets: options.thinkingBudgets,
		maxRetryDelayMs: options.maxRetryDelayMs,
	};
}

export function streamProxy(
	model: Model<any>,
	context: TranscriptContext,
	options: ProxyStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		// Initialize the partial message that we'll build up from events
		const partial: AssistantMessage = {
			role: "assistant",
			stopReason: "pending",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

		const abortHandler = () => {
			if (reader) {
				reader.cancel("Request aborted by user").catch(() => {});
			}
		};

		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler);
		}

		try {
			const response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					context,
					options: buildProxyRequestOptions(options),
				}),
				signal: options.signal,
			});

			if (!response.ok) {
				const status = validHttpStatus(response.status);
				// Preserve the legacy JSON `error` / status-text fallback privately, never on an Error.
				let privateText = response.statusText;
				// The HTTP failure already owns the result; private classification must not stall it (#3155).
				const deadline = new AbortController();
				const timeout = setTimeout(() => deadline.abort(), MAX_PROXY_ERROR_READ_MS);
				const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
				try {
					reader = response.body?.getReader();
					if (reader) {
						const decoder = new TextDecoder();
						let text = "";
						let bytes = 0;
						while (!signal.aborted) {
							const { done, value } = await raceWithAbortSignal(reader.read(), signal);
							if (signal.aborted) break;
							if (done) {
								const data = JSON.parse(text + decoder.decode()) as { error?: string } | null;
								if (data?.error) privateText = `Proxy error: ${data.error}`;
								break;
							}
							bytes += value.byteLength;
							if (bytes > MAX_PROXY_ERROR_BYTES) break;
							text += decoder.decode(value, { stream: true });
						}
					}
				} catch {
					// Body/parser failures and deadlines are private too; the HTTP failure still owns the result.
				} finally {
					clearTimeout(timeout);
					if (reader) {
						// Do not await cancellation: a gateway may never settle its cancel hook.
						void reader.cancel().catch(() => {});
						reader.releaseLock();
						reader = undefined;
					}
				}
				if (options.signal?.aborted) throw new Error("Request aborted by user");
				partial.recovery = classifyProviderFailure({ text: privateText, status, provider: model.provider });
				// Only owned text crosses the catch/publication boundary (smarty-dev#5822, pi#202 CR-4).
				throw new Error(status === undefined ? "Proxy error" : `Proxy error (${status})`);
			}

			reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let sawTerminalEvent = false;

			const processLine = (line: string): void => {
				if (!line.startsWith("data: ")) return;
				const data = line.slice(6).trim();
				if (!data) return;
				const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
				const event = processProxyEvent(proxyEvent, partial);
				if (event) {
					if (event.type === "done" || event.type === "error") sawTerminalEvent = true;
					stream.push(event);
				}
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				if (options.signal?.aborted) {
					throw new Error("Request aborted by user");
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					processLine(line);
				}
			}

			if (options.signal?.aborted) {
				throw new Error("Request aborted by user");
			}

			// The final event may not be newline-terminated; flush the decoder and
			// process whatever is left in the buffer.
			buffer += decoder.decode();
			if (buffer) {
				processLine(buffer);
			}

			if (!sawTerminalEvent) {
				// A clean EOF without a done/error event means the server dropped the
				// response mid-stream. Surface it as an error instead of leaving
				// consumers waiting on a result that never arrives.
				partial.stopReason = "error";
				partial.errorMessage = "Connection closed by proxy server before the response completed";
				stream.push({
					type: "error",
					reason: "error",
					error: partial,
				});
			}

			stream.end();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
		} finally {
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
		}
	})();

	return stream;
}

/**
 * The owned recovery decision for a proxy wire error, decided from its private text by the same public checks
 * that read the published text before (overflow, premature stream, retryable), so retry behaviour is unchanged.
 * The probe message is local and never published; it has no output, so only the text decides.
 */
function proxyRecovery(partial: AssistantMessage, wireText: unknown): AssistantRecovery {
	const probe: AssistantMessage = {
		...partial,
		content: [],
		usage: { ...partial.usage, output: 0 },
		stopReason: "error",
		errorMessage: typeof wireText === "string" ? wireText : "",
		recovery: undefined,
		diagnostics: undefined,
	};
	if (isContextOverflow(probe)) return { recovery: "context_length_exceeded", retryable: false };
	// Quota and billing refusals win over everything else, as in the shared classifier.
	if (!isRetryableAssistantError(probe)) return { retryable: false };
	return isPrematureStreamError(probe)
		? { recovery: "premature_stream", retryable: true }
		: { recovery: "retryable", retryable: true };
}

/**
 * Process a proxy event and update the partial message.
 */
function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			return { type: "start", partial };

		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		case "toolcall_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
			} satisfies ToolCall & { partialJson: string } as ToolCall;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };

		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				(content as any).partialJson += proxyEvent.delta;
				content.arguments = parseStreamingJson((content as any).partialJson) || {};
				partial.content[proxyEvent.contentIndex] = { ...content }; // Trigger reactivity
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				Object.assign(content, proxyEvent.toolCall);
				delete (content as any).partialJson;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall: content,
					partial,
				};
			}
			return undefined;
		}

		case "done":
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			if (proxyEvent.providerThinkingLevel !== undefined) {
				partial.providerThinkingLevel = proxyEvent.providerThinkingLevel;
			}
			return { type: "done", reason: proxyEvent.reason, message: partial };

		case "error": {
			// The wire text stays private: it only decides recovery, exactly as the published text used to
			// (smarty-dev#5822, pi#202 round 4). The published text is owned, with a closed reason code.
			const reason = proxyEvent.reason === "aborted" ? "aborted" : "error";
			partial.stopReason = reason;
			partial.recovery = proxyRecovery(partial, proxyEvent.errorMessage);
			partial.errorMessage = reason === "aborted" ? "Proxy error (aborted)" : "Proxy error";
			partial.usage = proxyEvent.usage;
			if (proxyEvent.providerThinkingLevel !== undefined) {
				partial.providerThinkingLevel = proxyEvent.providerThinkingLevel;
			}
			return { type: "error", reason, error: partial };
		}

		default: {
			const _exhaustiveCheck: never = proxyEvent;
			console.warn(`Unhandled proxy event type: ${(proxyEvent as any).type}`);
			return undefined;
		}
	}
}
