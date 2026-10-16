// Published diagnostics are rebuilt from Pi-owned fields; provider text stays private.
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "../types.ts";
import { isolateValue } from "./assistant-message-snapshot.ts";

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
	timestamp: number;
	thinkingBlocksDropped?: number;
}
const DIAGNOSTIC_TYPES: ReadonlySet<string> = new Set(ASSISTANT_DIAGNOSTIC_TYPES);
const MAX_THINKING_BLOCKS_DROPPED = 100_000;
const ownedDiagnostics = new WeakSet<object>();

export function formatThrownValue(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

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

/** Drop producer extras, timestamps and unowned numeric counts. */
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
function toolCallWithArguments(toolCall: ToolCall, args: ToolCall["arguments"]): ToolCall {
	return {
		type: "toolCall",
		id: toolCall.id,
		name: toolCall.name,
		arguments: args,
		...(toolCall.thoughtSignature === undefined ? {} : { thoughtSignature: toolCall.thoughtSignature }),
		...(toolCall.namespace === undefined ? {} : { namespace: toolCall.namespace }),
		...(toolCall.argumentsError === undefined ? {} : { argumentsError: toolCall.argumentsError }),
	};
}
type AssistantContent = TextContent | ThinkingContent | ToolCall;
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
function cloneAssistantContent(block: AssistantContent, isolated: unknown): AssistantContent {
	switch (block.type) {
		case "text":
			return cloneTextContent(block);
		case "thinking":
			return cloneThinkingContent(block);
		case "toolCall":
			return toolCallWithArguments(block, isolated as ToolCall["arguments"]);
		default:
			return isolated as AssistantContent;
	}
}
const KNOWN_RAW_STOP_REASONS: ReadonlySet<string> = new Set([
	"end_turn",
	"max_tokens",
	"stop_sequence",
	"tool_use",
	"pause_turn",
	"refusal",
	"model_context_window_exceeded",
	"guardrail_intervened",
	"content_filtered",
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
	"completed",
	"failed",
	"cancelled",
	"incomplete",
	"incomplete.max_output_tokens",
	"incomplete.content_filter",
	"incomplete.server_error",
	"incomplete.max_time_limit",
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
export function closedRawStopReason(value: unknown): string {
	return typeof value === "string" && KNOWN_RAW_STOP_REASONS.has(value) ? value : "other";
}
export type PublicationPhase = "partial" | "success" | "failure";
const SUCCESS_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "length", "toolUse", "deferred"]);
export function terminalPhase(message: AssistantMessage): PublicationPhase {
	if (SUCCESS_STOP_REASONS.has(message.stopReason)) return "success";
	return message.stopReason === "pending" ? "partial" : "failure";
}

/** Closed publication shape, with one isolation pass to preserve cross-field aliases and cycles. */
export function projectAssistantMessage(message: AssistantMessage, phase: PublicationPhase): AssistantMessage {
	const content = Array.isArray(message.content) ? message.content : [];
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
	if (message.thinkingLevel !== undefined) projected.thinkingLevel = message.thinkingLevel;
	const diagnostics = projectAssistantMessageDiagnostics(message.diagnostics);
	if (diagnostics !== undefined) projected.diagnostics = diagnostics;
	if (message.deferred !== undefined) projected.deferred = isolated.deferred;
	if (message.errorMessage !== undefined) projected.errorMessage = message.errorMessage;
	if (message.errorHint === "bedrock_data_retention" || message.errorHint === "chatgpt_usage") {
		projected.errorHint = message.errorHint;
	}
	if (message.rawStopReason !== undefined) projected.rawStopReason = closedRawStopReason(message.rawStopReason);
	if (message.endTurn !== undefined) projected.endTurn = message.endTurn;
	if (message.durationMs !== undefined) projected.durationMs = message.durationMs;
	return projected;
}
