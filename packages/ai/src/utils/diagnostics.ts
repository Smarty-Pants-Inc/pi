// Published diagnostics are rebuilt from Pi-owned fields; provider text stays private.
// Refusal stop_details are a separate bounded, untrusted record-only exception in event-stream.ts,
// never an owned diagnostic or a recovery input.

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
