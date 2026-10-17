/**
 * pi-messages API implementation.
 *
 * Streams pi's own message protocol directly to a backend: the request is a
 * single POST of `{ model, context, options }` to `<baseUrl>/messages`, the
 * response is an SSE stream of serialized assistant-message events plus a
 * terminal `done`/`error` event. This is the wire protocol spoken by the
 * Radius gateway, but any backend implementing it can be used, e.g. via a
 * models.json custom provider with `"api": "pi-messages"`.
 */

import { getRequestDiagnosticSecrets } from "../auth/oauth/credential-response.ts";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantRecovery,
	CacheRetention,
	Model,
	ProviderEnv,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	ThinkingLevel,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { formatProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import {
	markProviderStreamObserverFailure,
	PROVIDER_STREAM_OBSERVER_FAILED,
	providerResponse,
	providerStreamNotification,
} from "../utils/provider-observation.ts";
import { checkProviderRequest } from "../utils/provider-retry.ts";
import { classifyProviderFailure, validHttpStatus } from "../utils/recovery.ts";

export interface PiMessagesOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	/** Ask the backend for debug metadata (e.g. routing response headers). */
	debug?: boolean;
}

type PiMessagesUsage = AssistantMessage["usage"];
type PiMessagesStopReason = AssistantMessage["stopReason"];

/** Impact summary of a server-side message rewrite (e.g. a gateway policy). */
export type PiMessagesRewriteImpact = {
	policyId: string;
	policyVersion: number;
	changed: boolean;
	tokenCountChange: number;
	messageCountChange: number;
	systemPromptChanged: boolean;
};

/** Serialized assistant-message event as sent by a pi-messages backend. */
export type PiMessagesEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: string;
			contentSignature?: string;
			redacted?: boolean;
	  }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| {
			type: "done";
			reason: Extract<PiMessagesStopReason, "stop" | "length" | "toolUse">;
			usage: PiMessagesUsage;
			responseId?: string;
			providerThinkingLevel?: string;
			rewrite?: PiMessagesRewriteImpact;
	  }
	| {
			type: "error";
			reason: Extract<PiMessagesStopReason, "aborted" | "error">;
			usage: PiMessagesUsage;
			errorMessage?: string;
			responseId?: string;
			providerThinkingLevel?: string;
			rewrite?: PiMessagesRewriteImpact;
	  };

type PiMessagesErrorBody = {
	error?: {
		message?: unknown;
		code?: unknown;
		details?: unknown;
		[key: string]: unknown;
	};
};

export type PiMessagesErrorCategory =
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "rate_limited"
	| "quota_exceeded"
	| "overloaded"
	| "context_length_exceeded"
	| "invalid_request"
	| "server_error"
	| "timeout";
const PI_MESSAGES_ERROR_CATEGORIES: Readonly<Record<string, PiMessagesErrorCategory>> = {
	unauthorized: "unauthorized",
	authentication_error: "unauthorized",
	invalid_api_key: "unauthorized",
	forbidden: "forbidden",
	permission_denied: "forbidden",
	not_found: "not_found",
	model_not_found: "not_found",
	rate_limited: "rate_limited",
	rate_limit: "rate_limited",
	rate_limit_exceeded: "rate_limited",
	too_many_requests: "rate_limited",
	quota_exceeded: "quota_exceeded",
	insufficient_quota: "quota_exceeded",
	overloaded: "overloaded",
	busy: "overloaded",
	server_busy: "overloaded",
	unavailable: "overloaded",
	context_length_exceeded: "context_length_exceeded",
	invalid_request: "invalid_request",
	invalid_request_error: "invalid_request",
	bad_request: "invalid_request",
	server_error: "server_error",
	internal_error: "server_error",
	api_error: "server_error",
	timeout: "timeout",
};

/** Only owned categories, status and recovery survive this response boundary. */
export class PiMessagesResponseError extends Error {
	readonly status: number | undefined;
	readonly category: PiMessagesErrorCategory | undefined;
	readonly recovery: AssistantRecovery;

	constructor(status: number | undefined, category: PiMessagesErrorCategory | undefined, recovery: AssistantRecovery) {
		const detail = [status === undefined ? undefined : `HTTP ${status}`, category].filter(Boolean).join(", ");
		super(detail ? `Provider request failed (${detail})` : "Provider request failed");
		this.name = "PiMessagesResponseError";
		this.status = status;
		this.category = category;
		this.recovery = recovery;
	}
}

function parsePiMessagesErrorBody(body: string): PiMessagesErrorBody | undefined {
	try {
		const parsed = JSON.parse(body) as PiMessagesErrorBody | null;
		const error = parsed?.error;
		return parsed && typeof error === "object" && error !== null && !Array.isArray(error) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function createPiMessagesResponseError(
	model: Model<"pi-messages">,
	response: Response,
	body: string,
): PiMessagesResponseError {
	const error = parsePiMessagesErrorBody(body)?.error;
	const code = typeof error?.code === "string" ? error.code : undefined;
	const category =
		code !== undefined && Object.hasOwn(PI_MESSAGES_ERROR_CATEGORIES, code)
			? PI_MESSAGES_ERROR_CATEGORIES[code]
			: undefined;
	const status = validHttpStatus(response.status);
	const recovery = classifyProviderFailure({
		text: [typeof error?.message === "string" ? error.message : undefined, code, body].filter(Boolean).join("\n"),
		status,
		provider: model.provider,
	});
	return new PiMessagesResponseError(status, category, recovery);
}

function createEmptyUsage(): PiMessagesUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function boundUsageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.min(value, Number.MAX_SAFE_INTEGER)
		: 0;
}
function boundUsage(value: unknown): PiMessagesUsage {
	const wire =
		typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const wireCost =
		typeof wire.cost === "object" && wire.cost !== null && !Array.isArray(wire.cost)
			? (wire.cost as Record<string, unknown>)
			: {};
	const usage: PiMessagesUsage = {
		input: boundUsageNumber(wire.input),
		output: boundUsageNumber(wire.output),
		cacheRead: boundUsageNumber(wire.cacheRead),
		cacheWrite: boundUsageNumber(wire.cacheWrite),
		totalTokens: boundUsageNumber(wire.totalTokens),
		cost: {
			input: boundUsageNumber(wireCost.input),
			output: boundUsageNumber(wireCost.output),
			cacheRead: boundUsageNumber(wireCost.cacheRead),
			cacheWrite: boundUsageNumber(wireCost.cacheWrite),
			total: boundUsageNumber(wireCost.total),
		},
	};
	if (typeof wire.reasoning === "number" && wire.reasoning >= 0) usage.reasoning = boundUsageNumber(wire.reasoning);
	if (typeof wire.cacheWrite1h === "number" && wire.cacheWrite1h >= 0)
		usage.cacheWrite1h = boundUsageNumber(wire.cacheWrite1h);
	return usage;
}
function isWireObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeWireToolCall(value: unknown, fallback: ToolCall | undefined): ToolCall {
	const source = isWireObject(value) ? value : {};
	const text = (key: "id" | "name" | "thoughtSignature" | "namespace" | "argumentsError"): string | undefined => {
		const field = source[key];
		return typeof field === "string" ? field : typeof fallback?.[key] === "string" ? fallback[key] : undefined;
	};
	const thoughtSignature = text("thoughtSignature");
	const namespace = text("namespace");
	const argumentsError = text("argumentsError");
	return {
		type: "toolCall",
		id: text("id") ?? "",
		name: text("name") ?? "",
		arguments: isWireObject(source.arguments)
			? (source.arguments as ToolCall["arguments"])
			: isWireObject(fallback?.arguments)
				? fallback.arguments
				: {},
		...(thoughtSignature === undefined ? {} : { thoughtSignature }),
		...(namespace === undefined ? {} : { namespace }),
		...(argumentsError === undefined ? {} : { argumentsError }),
	};
}

function appendRewriteDiagnostic(message: AssistantMessage, rewrite: PiMessagesRewriteImpact | undefined): void {
	if (!rewrite) {
		return;
	}
	appendAssistantMessageDiagnostic(message, createAssistantMessageDiagnostic("pi_messages_rewrite"));
}

function createEventConverter(model: Model<"pi-messages">) {
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
	const toolJson = new Map<number, string>();

	return (event: PiMessagesEvent): AssistantMessageEvent => {
		switch (event.type) {
			case "done":
				Object.assign(partial, {
					stopReason: event.reason,
					usage: boundUsage(event.usage),
					responseId: event.responseId,
				});
				if (event.providerThinkingLevel !== undefined) {
					partial.providerThinkingLevel = event.providerThinkingLevel;
				}
				appendRewriteDiagnostic(partial, event.rewrite);
				return { type: "done", reason: event.reason, message: partial };
			case "error": {
				const recovery = classifyProviderFailure({
					text: typeof event.errorMessage === "string" ? event.errorMessage : undefined,
					provider: model.provider,
				});
				Object.assign(partial, {
					stopReason: event.reason,
					usage: boundUsage(event.usage),
					errorMessage: formatProviderError({ recovery }),
					recovery,
					responseId: event.responseId,
				});
				if (event.providerThinkingLevel !== undefined) {
					partial.providerThinkingLevel = event.providerThinkingLevel;
				}
				appendRewriteDiagnostic(partial, event.rewrite);
				return { type: "error", reason: event.reason, error: partial };
			}
			case "start":
				break;
			case "text_start":
				partial.content[event.contentIndex] = { type: "text", text: "" };
				break;
			case "text_delta":
				(partial.content[event.contentIndex] as { text: string }).text += event.delta;
				break;
			case "text_end":
				Object.assign(partial.content[event.contentIndex]!, {
					text: event.content,
					textSignature: event.contentSignature,
				});
				break;
			case "thinking_start":
				partial.content[event.contentIndex] = { type: "thinking", thinking: "" };
				break;
			case "thinking_delta":
				(partial.content[event.contentIndex] as { thinking: string }).thinking += event.delta;
				break;
			case "thinking_end":
				Object.assign(partial.content[event.contentIndex]!, {
					thinking: event.content,
					thinkingSignature: event.contentSignature,
					redacted: event.redacted,
				});
				break;
			case "toolcall_start":
				partial.content[event.contentIndex] = {
					type: "toolCall",
					id: event.id,
					name: event.toolName,
					arguments: {},
				};
				toolJson.set(event.contentIndex, "");
				break;
			case "toolcall_delta": {
				const json = `${toolJson.get(event.contentIndex) ?? ""}${event.delta}`;
				toolJson.set(event.contentIndex, json);
				(partial.content[event.contentIndex] as ToolCall).arguments =
					parseStreamingJson<ToolCall["arguments"]>(json);
				break;
			}
			case "toolcall_end":
				partial.content[event.contentIndex] = normalizeWireToolCall(
					event.toolCall,
					partial.content[event.contentIndex] as ToolCall | undefined,
				);
				toolJson.delete(event.contentIndex);
				return {
					type: "toolcall_end",
					contentIndex: event.contentIndex,
					toolCall: partial.content[event.contentIndex] as ToolCall,
					partial,
				};
		}

		return { ...event, partial } as AssistantMessageEvent;
	};
}

async function* readPiMessagesEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<PiMessagesEvent> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n");

			let split = buffer.indexOf("\n\n");
			while (split !== -1) {
				const event = parsePiMessagesEvent(buffer.slice(0, split));
				if (event) {
					yield event;
				}
				buffer = buffer.slice(split + 2);
				split = buffer.indexOf("\n\n");
			}

			if (done) {
				break;
			}
		}

		if (buffer.trim()) {
			const event = parsePiMessagesEvent(buffer);
			if (event) {
				yield event;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function parsePiMessagesEvent(raw: string): PiMessagesEvent | undefined {
	const data = raw
		.split("\n")
		.find((line) => line.startsWith("data:"))
		?.slice(5)
		.trim();

	return data && data !== "[DONE]" ? (JSON.parse(data) as PiMessagesEvent) : undefined;
}

function createErrorEvent(model: Model<"pi-messages">, error: unknown, aborted: boolean): AssistantMessageEvent {
	const reason = aborted ? "aborted" : "error";
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: reason,
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};

	if (!aborted && error instanceof PiMessagesResponseError) {
		assistantMessage.recovery = error.recovery;
		appendAssistantMessageDiagnostic(
			assistantMessage,
			createAssistantMessageDiagnostic("pi_messages_response_failure"),
		);
	}

	return { type: "error", reason, error: assistantMessage };
}

function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention | undefined {
	if (cacheRetention) {
		return cacheRetention;
	}
	// Backend defaults apply when unset; only the legacy env opt-in is mapped.
	return getProviderEnvValue("PI_CACHE_RETENTION", env) === "long" ? "long" : undefined;
}

export const stream: StreamFunction<"pi-messages", PiMessagesOptions> = (
	model: Model<"pi-messages">,
	context: TranscriptContext,
	options?: PiMessagesOptions,
): AssistantMessageEventStream => {
	const diagnosticSecrets = getRequestDiagnosticSecrets(model, options);
	const eventStream = new AssistantMessageEventStream(diagnosticSecrets);
	const convertEvent = createEventConverter(model);
	let observerFailed = false;
	let observerFailureUsage: PiMessagesUsage | undefined;

	void (async () => {
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key provided for provider "${model.provider}"`);
			}

			const url = new URL(`${model.baseUrl.replace(/\/+$/u, "")}/messages`);
			if (options?.debug) {
				url.searchParams.set("debug", "1");
			}

			let payload: unknown = {
				model: model.id,
				context,
				options: {
					temperature: options?.temperature,
					maxTokens: options?.maxTokens,
					reasoning: options?.reasoning,
					cacheRetention: resolveCacheRetention(options?.cacheRetention, options?.env),
					sessionId: options?.sessionId,
					toolChoice: options?.toolChoice,
				},
			};
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload;
			}

			checkProviderRequest(options);
			const response = await (options?.fetch ?? globalThis.fetch)(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					accept: "text/event-stream",
					"content-type": "application/json",
					...providerHeadersToRecord(options?.headers),
				},
				body: JSON.stringify(payload),
				signal: options?.signal,
			});

			await options?.onResponse?.(providerResponse(response.status));

			if (!response.ok) {
				const body = await response.text();
				throw createPiMessagesResponseError(model, response, body);
			}
			if (!response.body) {
				throw new Error(`${model.provider} response has no body`);
			}

			for await (const piEvent of readPiMessagesEvents(response.body)) {
				try {
					await options?.onProviderStreamEvent?.(providerStreamNotification());
				} catch {
					observerFailed = true;
					// Keep billable accounting without converting or publishing the rejected wire event.
					if (piEvent.type === "done" || piEvent.type === "error") {
						observerFailureUsage = boundUsage(piEvent.usage);
					}
					throw new Error(PROVIDER_STREAM_OBSERVER_FAILED);
				}
				const event = convertEvent(piEvent);
				eventStream.push(event);
				if (event.type === "done" || event.type === "error") {
					return;
				}
			}

			throw new Error(`${model.provider} stream ended without a terminal event`);
		} catch (error) {
			const event = createErrorEvent(model, error, options?.signal?.aborted ?? false);
			if (observerFailed && event.type === "error") {
				if (observerFailureUsage !== undefined) event.error.usage = observerFailureUsage;
				markProviderStreamObserverFailure(event.error);
			}
			eventStream.push(event);
		}
	})();

	return eventStream;
};

export const streamSimple: StreamFunction<"pi-messages", SimpleStreamOptions> = (
	model: Model<"pi-messages">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const extra = options as PiMessagesOptions | undefined;
	return stream(model, context, {
		...options,
		reasoning: options?.reasoning,
		toolChoice: options?.toolChoice,
		debug: extra?.debug,
	});
};
