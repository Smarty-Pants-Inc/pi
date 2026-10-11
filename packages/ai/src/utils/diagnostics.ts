// Owned assistant-message diagnostics (smarty-dev#5822 N5682). A published diagnostic is rebuilt from a closed
// list of Pi-owned types and a locally generated timestamp. No provider error, name, stack, cause, error code,
// nested details or provider timestamp has an output path, so neither a numeric `.code` nor any nested value
// can carry a credential equivalent into an event, result, callback or session file.

/** Diagnostic types Pi publishes. A type outside this list is dropped. */
export const ASSISTANT_DIAGNOSTIC_TYPES = [
	"provider_limit",
	"provider_stream_observer_error",
	"provider_transport_failure",
	"pi_messages_response_failure",
	"pi_messages_rewrite",
	"anthropic_input_transformations",
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
		if (ownedDiagnostics.has(diagnostic) && typeof timestamp === "number") rebuilt.timestamp = timestamp;
		if (
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
