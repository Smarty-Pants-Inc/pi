import {
	type OAuthDiagnosticCode,
	oauthDiagnosticError,
	oauthRecoveryDecision,
	SETUP_MESSAGES,
	safeOAuthError,
	transferAssistantMessagePrivateDecisions,
} from "../auth/oauth/credential-response.ts";
import type { AssistantMessage, JsonObject, ThinkingLevelMap, Usage } from "../types.ts";
import { isProviderContextOverflow } from "./provider-error-classification.ts";

export interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string;
}

export interface AssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: JsonObject;
}

export function formatThrownValue(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

export function extractDiagnosticError(
	error: unknown,
	_secrets: readonly string[] = [],
	oauthDiagnostics = false,
): DiagnosticErrorInfo {
	const safe = safeOAuthError(error);
	if (oauthDiagnostics) return { name: safe.name, message: safe.message, code: safe.code };
	const codes: Record<OAuthDiagnosticCode, string> = {
		oauth_request_failed: "provider_request_failed",
		oauth_invalid_response: "provider_invalid_response",
		oauth_authorization_failed: "provider_authorization_failed",
		oauth_stream_failed: "provider_stream_failed",
		oauth_transport_failed: "provider_transport_failed",
		oauth_retry_delay_exceeded: "provider_retry_delay_exceeded",
	};
	const code = codes[safe.code];
	return { name: "ProviderDiagnosticError", message: safe.message.replace(safe.code, code), code };
}

export function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	_details?: JsonObject,
	secrets: readonly string[] = [],
	oauthDiagnostics = false,
): AssistantMessageDiagnostic {
	return {
		type,
		timestamp: Date.now(),
		error: extractDiagnosticError(error, secrets, oauthDiagnostics),
	};
}

const OWNED_DIAGNOSTIC_TYPES = new Set([
	"provider_limit",
	"provider_stream_observer_error",
	"pi_messages_response_failure",
	"bedrock_response_failure",
	"pi_messages_rewrite",
	"anthropic_input_transformations",
	"provider_transport_fallback",
	"provider_stream_recovery",
]);
const OWNED_STOP_REASONS = new Set([
	"stop",
	"length",
	"tool_calls",
	"end_turn",
	"max_tokens",
	"tool_use",
	"refusal",
	"pause_turn",
	"stop_sequence",
	"sensitive",
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"in_progress",
	"queued",
	"incomplete.max_output_tokens",
	"incomplete.content_filter",
	"end",
	"function_call",
	"content_filter",
	"network_error",
	"STOP",
	"MAX_TOKENS",
	"SAFETY",
	"RECITATION",
	"OTHER",
	"BLOCKLIST",
	"PROHIBITED_CONTENT",
	"SPII",
	"MALFORMED_FUNCTION_CALL",
]);

/** Rebuild owned text. A provider prefix or suffix never becomes authority. */
function projectDiagnosticText(text: string, oauth: boolean): string {
	if (Object.values(SETUP_MESSAGES).some((value) => value === text)) return text;
	const owned =
		/(?:^|: )((?:oauth|provider)_(?:request_failed|invalid_response|authorization_failed|stream_failed|transport_failed|retry_delay_exceeded)) \(HTTP (unknown|[1-5]\d\d)\)(?: provider_error=([a-z_]+))?$/.exec(
			text,
		);
	const status = owned
		? owned[2] === "unknown"
			? undefined
			: Number(owned[2])
		: /(?:^|API error \()([1-5]\d\d)(?:\)|:| )/.exec(text)?.[1];
	const safe = owned
		? oauthDiagnosticError(
				owned[1].replace(/^provider_/, "oauth_") as OAuthDiagnosticCode,
				typeof status === "number" ? status : undefined,
				owned[3],
			)
		: safeOAuthError({ status: typeof status === "string" ? Number(status) : undefined });
	return extractDiagnosticError(safe, [], owned ? owned[1].startsWith("oauth_") : oauth).message;
}

export const MAX_USAGE_TOKENS = 1_000_000_000;
export const MAX_USAGE_COST = 1_000_000;

/** Closed accounting shape shared by provider publication and accepted tool accounting. */
export function projectUsage(usage: Usage): Usage {
	const count = (value: unknown): number =>
		typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, MAX_USAGE_TOKENS) : 0;
	const cost = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_USAGE_COST) : 0;
	const input = cost(usage?.cost?.input),
		output = cost(usage?.cost?.output),
		cacheRead = cost(usage?.cost?.cacheRead),
		cacheWrite = cost(usage?.cost?.cacheWrite);
	return {
		input: count(usage?.input),
		output: count(usage?.output),
		cacheRead: count(usage?.cacheRead),
		cacheWrite: count(usage?.cacheWrite),
		totalTokens: count(usage?.totalTokens),
		...(typeof usage?.cacheWrite1h === "number" && Number.isInteger(usage.cacheWrite1h) && usage.cacheWrite1h >= 0
			? { cacheWrite1h: count(usage.cacheWrite1h) }
			: {}),
		...(typeof usage?.reasoning === "number" && Number.isInteger(usage.reasoning) && usage.reasoning >= 0
			? { reasoning: count(usage.reasoning) }
			: {}),
		cost: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
	};
}

/** One unconditional, copy-returning boundary. Credentials are never needed to project diagnostics. */
export function projectAssistantMessageDiagnostics(
	message: AssistantMessage,
	_secrets: readonly string[] = [],
	oauthDiagnostics = false,
	partial = false,
	model?: { thinkingLevelMap?: ThinkingLevelMap },
): AssistantMessage {
	const projected: AssistantMessage = {
		...message,
		content: structuredClone(message.content),
		usage: projectUsage(message.usage),
	};
	delete projected.responseId;
	if (
		message.providerThinkingLevel !== undefined &&
		!["low", "medium", "high", "xhigh", "max"].includes(message.providerThinkingLevel) &&
		!Object.values(model?.thinkingLevelMap ?? {}).includes(message.providerThinkingLevel)
	) {
		delete projected.providerThinkingLevel;
	}
	if (message.errorMessage !== undefined) {
		const decision = oauthRecoveryDecision(safeOAuthError({ message: message.errorMessage }, true));
		if (isProviderContextOverflow(message.errorMessage, message.provider))
			decision.recovery = "context_length_exceeded";
		projected.oauthRecovery = message.oauthRecovery ? { ...message.oauthRecovery } : decision;
		projected.errorMessage = projectDiagnosticText(message.errorMessage, oauthDiagnostics);
	}
	if (message.rawStopReason !== undefined)
		projected.rawStopReason = OWNED_STOP_REASONS.has(message.rawStopReason) ? message.rawStopReason : "unknown";
	if (message.diagnostics) {
		projected.diagnostics = message.diagnostics
			.filter((diagnostic) => OWNED_DIAGNOSTIC_TYPES.has(diagnostic.type))
			.map((diagnostic) => ({
				type: diagnostic.type,
				timestamp: Date.now(),
				...(diagnostic.error
					? {
							error: {
								name: oauthDiagnostics ? "OAuthDiagnosticError" : "ProviderDiagnosticError",
								message: projectDiagnosticText(diagnostic.error.message, oauthDiagnostics),
							},
						}
					: {}),
			}));
	}
	if (
		partial ||
		message.stopReason === "pending" ||
		message.stopReason === "error" ||
		message.stopReason === "aborted"
	) {
		delete projected.responseId;
		delete projected.responseModel;
		delete projected.providerThinkingLevel;
	}
	transferAssistantMessagePrivateDecisions(message, projected);
	return projected;
}

export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
