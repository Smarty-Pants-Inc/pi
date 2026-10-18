// The assistant-message publication projector (smarty-dev#5822 C2) and its owned diagnostics (N5682).
//
// A published diagnostic is rebuilt from a closed list of Pi-owned types and a locally generated timestamp. No
// provider error, name, stack, cause, error code, nested details or provider timestamp has an output path, so
// neither a numeric `.code` nor any nested value can carry a credential equivalent into an event, result,
// callback or session file through diagnostics. The separate rawStopDetails field below is an explicit,
// bounded, untrusted record-only exception; it is not an owned diagnostic or a recovery input.

import { redactValues } from "../auth/oauth/credential-response.ts";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "../types.ts";
import { isolateValue } from "./assistant-message-snapshot.ts";

/** Diagnostic types Pi publishes. A type outside this list is dropped. */
export const ASSISTANT_DIAGNOSTIC_TYPES = [
	"provider_limit",
	"provider_stream_observer_error",
	"provider_transport_failure",
	"pi_messages_response_failure",
	"pi_messages_rewrite",
	"anthropic_input_transformations",
	"anthropic_strict_tools_fallback",
] as const;

export type AssistantMessageDiagnosticType = (typeof ASSISTANT_DIAGNOSTIC_TYPES)[number];

export interface AssistantMessageDiagnostic {
	type: AssistantMessageDiagnosticType;
	/** Local time Pi recorded the diagnostic. */
	timestamp: number;
	/** `anthropic_input_transformations` only: how many thinking blocks the provider dropped from the input. */
	thinkingBlocksDropped?: number;
}

const DIAGNOSTIC_TYPES: ReadonlySet<string> = new Set(ASSISTANT_DIAGNOSTIC_TYPES);

/** Bound of the one numeric diagnostic field: a count of input blocks, far below any request size. */
const MAX_THINKING_BLOCKS_DROPPED = 100_000;

/** Diagnostics Pi created or rebuilt; re-projection keeps their local timestamps. */
const ownedDiagnostics = new WeakSet<object>();

export function formatThrownValue(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

/** A new owned diagnostic of `type`, recorded now. */
export function createAssistantMessageDiagnostic(type: AssistantMessageDiagnosticType): AssistantMessageDiagnostic {
	const diagnostic: AssistantMessageDiagnostic = { type, timestamp: Date.now() };
	ownedDiagnostics.add(diagnostic);
	return diagnostic;
}

export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}

/**
 * Rebuild a message's diagnostics for publication: closed types only, local timestamps, and the one bounded
 * owned count. Everything else on a diagnostic, including any `details`, `error` or provider timestamp, is
 * dropped. Returns undefined when nothing remains.
 */
export function projectAssistantMessageDiagnostics(value: unknown): AssistantMessageDiagnostic[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const projected: AssistantMessageDiagnostic[] = [];
	for (const diagnostic of value) {
		if (typeof diagnostic !== "object" || diagnostic === null) continue;
		const { type, timestamp, thinkingBlocksDropped } = diagnostic as Record<string, unknown>;
		if (typeof type !== "string" || !DIAGNOSTIC_TYPES.has(type)) continue;
		const rebuilt = createAssistantMessageDiagnostic(type as AssistantMessageDiagnosticType);
		const owned = ownedDiagnostics.has(diagnostic);
		if (owned && typeof timestamp === "number") rebuilt.timestamp = timestamp;
		// The count is Pi's only when Pi created the diagnostic; a producer-supplied number could be a credential
		// or a fragment of one, so it is dropped (smarty-dev#5822 pi#202 round 2).
		if (
			owned &&
			type === "anthropic_input_transformations" &&
			typeof thinkingBlocksDropped === "number" &&
			Number.isSafeInteger(thinkingBlocksDropped) &&
			thinkingBlocksDropped >= 0
		) {
			rebuilt.thinkingBlocksDropped = Math.min(thinkingBlocksDropped, MAX_THINKING_BLOCKS_DROPPED);
		}
		projected.push(rebuilt);
	}
	return projected.length === 0 ? undefined : projected;
}

// Snapshot copies of content blocks with closed key sets: adapter scratch fields (`index`, `partialJson`,
// `partialArgs`, ...) are never copied, and later mutation of the source cannot reach the copy. Arbitrary values
// (tool arguments, usage, deferred handles, unknown blocks) are copied with `isolateValue`, which keeps Map/Set
// aliases and cycles, native Error classes and fields, own `__proto__` data keys and resizable buffers
// (smarty-dev#5443, pi#159).

export function cloneTextContent(content: TextContent): TextContent {
	return {
		type: "text",
		text: content.text,
		...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
	};
}

export function cloneThinkingContent(content: ThinkingContent): ThinkingContent {
	return {
		type: "thinking",
		thinking: content.thinking,
		...(content.thinkingSignature === undefined ? {} : { thinkingSignature: content.thinkingSignature }),
		...(content.redacted === undefined ? {} : { redacted: content.redacted }),
	};
}

export function cloneToolCall(toolCall: ToolCall): ToolCall {
	return toolCallWithArguments(toolCall, isolateValue(toolCall.arguments));
}

/** The closed `ToolCall` key set around `args`, an already isolated copy of `toolCall.arguments`. */
function toolCallWithArguments(toolCall: ToolCall, args: ToolCall["arguments"]): ToolCall {
	return {
		type: "toolCall",
		id: toolCall.id,
		name: toolCall.name,
		arguments: args,
		...(toolCall.thoughtSignature === undefined ? {} : { thoughtSignature: toolCall.thoughtSignature }),
		...(toolCall.namespace === undefined ? {} : { namespace: toolCall.namespace }),
	};
}

type AssistantContent = TextContent | ThinkingContent | ToolCall;

/**
 * The arbitrary value of a block that the projector copies: tool arguments, or a whole block of an unknown type.
 * Text and thinking blocks have only closed scalar fields.
 */
function arbitraryContentValue(block: AssistantContent): unknown {
	switch (block.type) {
		case "text":
		case "thinking":
			return undefined;
		case "toolCall":
			return block.arguments;
		default:
			return block;
	}
}

/** Rebuild `block` around `isolated`, its arbitrary value from the message's one isolation pass. */
function cloneAssistantContent(block: AssistantContent, isolated: unknown): AssistantContent {
	switch (block.type) {
		case "text":
			return cloneTextContent(block);
		case "thinking":
			return cloneThinkingContent(block);
		case "toolCall":
			return toolCallWithArguments(block, isolated as ToolCall["arguments"]);
		default:
			// Not an assistant block type: keep a detached snapshot rather than the live object.
			return isolated as AssistantContent;
	}
}

/**
 * Provider stop values Pi publishes as `rawStopReason` (smarty-dev#5822 design rule 4). Every other value,
 * including any free-text suffix, is published as `other`.
 */
const KNOWN_RAW_STOP_REASONS: ReadonlySet<string> = new Set([
	// Anthropic and Bedrock
	"end_turn",
	"max_tokens",
	"stop_sequence",
	"tool_use",
	"pause_turn",
	"refusal",
	"model_context_window_exceeded",
	"guardrail_intervened",
	"content_filtered",
	// OpenAI-compatible Completions and Mistral
	"stop",
	"length",
	"tool_calls",
	"function_call",
	"content_filter",
	"network_error",
	"model_length",
	"error",
	"end",
	"sensitive",
	// OpenAI Responses and Codex (`status` or `status.incompleteReason`)
	"completed",
	"failed",
	"cancelled",
	"incomplete",
	"incomplete.max_output_tokens",
	"incomplete.content_filter",
	"incomplete.server_error",
	"incomplete.max_time_limit",
	// Google Generative AI and Vertex
	"STOP",
	"MAX_TOKENS",
	"SAFETY",
	"RECITATION",
	"LANGUAGE",
	"OTHER",
	"BLOCKLIST",
	"PROHIBITED_CONTENT",
	"SPII",
	"MALFORMED_FUNCTION_CALL",
	"IMAGE_SAFETY",
	"UNEXPECTED_TOOL_CALL",
	"FINISH_REASON_UNSPECIFIED",
]);

/** A known provider stop value, else `other`; a provider can never choose free text here. */
export function closedRawStopReason(value: unknown): string {
	return typeof value === "string" && KNOWN_RAW_STOP_REASONS.has(value) ? value : "other";
}

const MAX_STOP_DETAILS_BYTES = 4096;

/** Record opaque provider data only. Missing later deltas must not erase details already received. */
export async function recordAssistantMessageStopDetails(
	message: AssistantMessage,
	details: unknown,
	secrets: readonly string[] = [],
): Promise<void> {
	if (details == null) {
		message.stopDetailsState ??= "absent";
		return;
	}
	try {
		const serialized = JSON.stringify(details);
		if (serialized === undefined) return;
		// Size and fingerprint only the masked serialization; never retain a fingerprint of live credentials.
		const redacted = redactValues(serialized, secrets);
		const bytes = new TextEncoder().encode(redacted);
		if (bytes.length > MAX_STOP_DETAILS_BYTES) {
			const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
			message.stopDetailsSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
			message.stopDetailsBytes = bytes.length;
			delete message.rawStopDetails;
			message.stopDetailsState = "discarded";
		} else {
			message.rawStopDetails = redacted;
			delete message.stopDetailsBytes;
			delete message.stopDetailsSha256;
			message.stopDetailsState = "retained";
		}
	} catch {
		// Diagnostic failure must never change the response outcome. No exception text or partial record is retained.
	}
}

/** Publication phase of a message: in progress, completed successfully, or failed or aborted. */
export type PublicationPhase = "partial" | "success" | "failure";

const SUCCESS_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "length", "toolUse", "deferred"]);

/** The phase of a terminal message: success only for a success stop reason; a pending result is partial. */
export function terminalPhase(message: AssistantMessage): PublicationPhase {
	if (SUCCESS_STOP_REASONS.has(message.stopReason)) return "success";
	return message.stopReason === "pending" ? "partial" : "failure";
}

/**
 * The one publication projector. It returns a new message and never changes the producer's object, which keeps
 * private protocol state such as Codex's `responseId` continuation. The copy has a closed key set and snapshot
 * content, usage and diagnostics, so a queued partial cannot pick up later mutations and a consumer cannot
 * mutate adapter state. Wire metadata (`responseId`, `responseModel`, `providerThinkingLevel`) is published only
 * with a successful result, never on a partial or a failed or aborted message, except for the record-only
 * responseId of an Anthropic refusal. The stream adds the owned recovery decision and carries the private
 * throttle wait (`AssistantMessageEventStream`).
 */
export function projectAssistantMessage(message: AssistantMessage, phase: PublicationPhase): AssistantMessage {
	const content = Array.isArray(message.content) ? message.content : [];
	// One isolation pass per published message: a value reachable from two fields (two tool calls' arguments, or
	// arguments and `deferred`) keeps one copy and its cycles, as one structuredClone of the message would. The
	// closed-key rebuild below then picks the copies; no second snapshot is taken. `map` keeps holes.
	const isolated = isolateValue({
		content: content.map(arbitraryContentValue),
		usage: message.usage,
		deferred: message.deferred,
	});
	const projected: AssistantMessage = {
		role: "assistant",
		content: content.map((block, index) => cloneAssistantContent(block, isolated.content[index])),
		api: message.api,
		provider: message.provider,
		model: message.model,
		usage: isolated.usage,
		stopReason: message.stopReason,
		timestamp: message.timestamp,
	};
	if (phase === "success") {
		if (message.responseModel !== undefined) projected.responseModel = message.responseModel;
		if (message.responseId !== undefined) projected.responseId = message.responseId;
		if (message.providerThinkingLevel !== undefined) projected.providerThinkingLevel = message.providerThinkingLevel;
	}
	if (
		phase === "failure" &&
		message.api === "anthropic-messages" &&
		message.stopReason === "error" &&
		message.rawStopReason === "refusal" &&
		typeof message.responseId === "string"
	) {
		projected.responseId = message.responseId;
	}
	if (message.thinkingLevel !== undefined) projected.thinkingLevel = message.thinkingLevel;
	const diagnostics = projectAssistantMessageDiagnostics(message.diagnostics);
	if (diagnostics !== undefined) projected.diagnostics = diagnostics;
	if (message.deferred !== undefined) projected.deferred = isolated.deferred;
	if (message.errorMessage !== undefined) projected.errorMessage = message.errorMessage;
	// Only the two owned hints are published; anything else a producer put there is dropped.
	if (message.errorHint === "bedrock_data_retention" || message.errorHint === "chatgpt_usage") {
		projected.errorHint = message.errorHint;
	}
	if (message.rawStopReason !== undefined) projected.rawStopReason = closedRawStopReason(message.rawStopReason);
	// Keep the record-only field on failures too; never merge it into error text, content or owned diagnostics.
	if (message.stopDetailsState === "absent") projected.stopDetailsState = "absent";
	if (
		message.stopDetailsState === "retained" &&
		typeof message.rawStopDetails === "string" &&
		new TextEncoder().encode(message.rawStopDetails).length <= MAX_STOP_DETAILS_BYTES
	) {
		projected.rawStopDetails = message.rawStopDetails;
		projected.stopDetailsState = "retained";
	}
	if (
		message.stopDetailsState === "discarded" &&
		Number.isSafeInteger(message.stopDetailsBytes) &&
		message.stopDetailsBytes! > MAX_STOP_DETAILS_BYTES &&
		typeof message.stopDetailsSha256 === "string" &&
		/^[a-f0-9]{64}$/.test(message.stopDetailsSha256)
	) {
		projected.stopDetailsState = "discarded";
		projected.stopDetailsBytes = message.stopDetailsBytes;
		projected.stopDetailsSha256 = message.stopDetailsSha256;
	}
	if (message.endTurn !== undefined) projected.endTurn = message.endTurn;
	if (message.durationMs !== undefined) projected.durationMs = message.durationMs;
	return projected;
}
