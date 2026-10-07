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

import {
	OAuthDiagnosticError,
	oauthDiagnosticError,
	oauthRecoveryDecision,
	oauthResponseError,
	safeOAuthError,
} from "../auth/oauth/credential-response.ts";
import type {
	AssistantMessage,
	AssistantMessageEvent,
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
import { normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord, providerResponseObservation } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

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

// HTTP failure bodies are classified privately by the bounded response helper.
export class PiMessagesResponseError extends OAuthDiagnosticError {
	constructor(error: OAuthDiagnosticError) {
		super(error.code, error.status, error.providerCode, error.recovery, error.retryable);
	}
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

function appendRewriteDiagnostic(message: AssistantMessage, rewrite: PiMessagesRewriteImpact | undefined): void {
	if (!rewrite) {
		return;
	}
	appendAssistantMessageDiagnostic(message, {
		type: "pi_messages_rewrite",
		timestamp: Date.now(),
	});
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
					usage: event.usage,
					responseId: event.responseId,
				});
				if (event.providerThinkingLevel !== undefined) {
					partial.providerThinkingLevel = event.providerThinkingLevel;
				}
				appendRewriteDiagnostic(partial, event.rewrite);
				return { type: "done", reason: event.reason, message: partial };
			case "error": {
				const reason = event.reason === "aborted" ? "aborted" : "error";
				const normalized = normalizeProviderError({ message: event.errorMessage }, [], false, model.provider);
				Object.assign(partial, {
					stopReason: reason,
					usage: event.usage,
					errorMessage: normalized.message,
					oauthRecovery: normalized.oauthRecovery,
					responseId: event.responseId,
				});
				if (event.providerThinkingLevel !== undefined) {
					partial.providerThinkingLevel = event.providerThinkingLevel;
				}
				appendRewriteDiagnostic(partial, event.rewrite);
				return { type: "error", reason, error: partial };
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
				Object.assign(partial.content[event.contentIndex]!, event.toolCall);
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

function createErrorEvent(
	model: Model<"pi-messages">,
	error: unknown,
	aborted: boolean,
	oauthDiagnostics = false,
	callbackError = false,
	partial?: AssistantMessage,
): AssistantMessageEvent {
	const reason = aborted ? "aborted" : "error";
	// Local callbacks cannot supply transport status or recovery authority.
	const diagnosticError = callbackError ? undefined : error;
	const normalized = normalizeProviderError(diagnosticError, [], false, model.provider);
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: partial?.content ?? [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: partial?.usage ?? createEmptyUsage(),
		stopReason: reason,
		oauthRecovery: callbackError
			? oauthRecoveryDecision(oauthDiagnosticError("oauth_request_failed", undefined, undefined, undefined, false))
			: oauthDiagnostics
				? // Base (98c6f900) OAuth retry contract: only owned HTTP decisions carry recovery; transport
					// and early-EOF failures stay unclassified (Radius scope cut, smarty-dev#4790).
					oauthRecoveryDecision(safeOAuthError(diagnosticError))
				: normalized.oauthRecovery,
		errorMessage: normalized.message,
		timestamp: Date.now(),
	};

	if (callbackError) {
		appendAssistantMessageDiagnostic(
			assistantMessage,
			createAssistantMessageDiagnostic(
				"provider_stream_observer_error",
				diagnosticError,
				undefined,
				[],
				oauthDiagnostics,
			),
		);
	}
	if (!callbackError && !aborted && error instanceof PiMessagesResponseError) {
		appendAssistantMessageDiagnostic(
			assistantMessage,
			createAssistantMessageDiagnostic("pi_messages_response_failure", error, undefined, [], oauthDiagnostics),
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
	const eventStream = new AssistantMessageEventStream(model, options);
	const convertEvent = createEventConverter(model);
	let callbackError = false;
	let partial: AssistantMessage | undefined;

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
			callbackError = true;
			const nextPayload = await options?.onPayload?.(payload, model);
			callbackError = false;
			if (nextPayload !== undefined) {
				payload = nextPayload;
			}

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

			callbackError = true;
			await options?.onResponse?.(providerResponseObservation(response.status));
			callbackError = false;

			if (!response.ok) {
				throw new PiMessagesResponseError(await oauthResponseError(response, true));
			}
			if (!response.body) {
				throw new Error(`${model.provider} response has no body`);
			}

			for await (const piEvent of readPiMessagesEvents(response.body)) {
				callbackError = true;
				await options?.onProviderStreamEvent?.({ type: "provider_stream_event" });
				callbackError = false;
				const event = convertEvent(piEvent);
				if ("partial" in event) partial = event.partial;
				eventStream.push(event);
				if (event.type === "done" || event.type === "error") {
					return;
				}
			}

			throw new Error(`${model.provider} stream ended without a terminal event`);
		} catch (error) {
			eventStream.push(
				createErrorEvent(
					model,
					error,
					options?.signal?.aborted ?? false,
					options?.oauthDiagnostics,
					callbackError,
					partial,
				),
			);
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
