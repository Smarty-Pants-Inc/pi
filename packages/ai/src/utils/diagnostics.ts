import {
	type OAuthDiagnosticCode,
	oauthDiagnosticError,
	oauthRecoveryDecision,
	redactOAuthDiagnostic,
	redactOAuthDiagnosticValue,
	safeOAuthError,
} from "../auth/oauth/credential-response.ts";
import type { AssistantMessage, JsonObject } from "../types.ts";

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

/** Reconstruct owned OAuth text; an arbitrary prefix, suffix or cause is never retained. */
function projectOAuthDiagnosticText(text: string): string {
	const owned =
		/(?:^|: )(oauth_(?:request_failed|invalid_response|authorization_failed|stream_failed|transport_failed)) \(HTTP (unknown|[1-5]\d\d)\)(?: provider_error=([a-z_]+))?$/.exec(
			text,
		);
	if (owned) {
		return oauthDiagnosticError(
			owned[1] as OAuthDiagnosticCode,
			owned[2] === "unknown" ? undefined : Number(owned[2]),
			owned[3],
		).message;
	}
	const status = /(?:^|API error \()([1-5]\d\d)(?:\)|:| )/.exec(text);
	return safeOAuthError({ message: text, status: status ? Number(status[1]) : undefined }, true).message;
}

/** Single publication boundary for diagnostic fields, not generated assistant content or usage. */
export function projectAssistantMessageDiagnostics(
	message: AssistantMessage,
	secrets: readonly string[],
	oauthDiagnostics: boolean,
): void {
	if (message.errorMessage !== undefined) {
		if (oauthDiagnostics && message.oauthRecovery === undefined) {
			message.oauthRecovery = oauthRecoveryDecision(safeOAuthError({ message: message.errorMessage }, true));
		}
		message.errorMessage = oauthDiagnostics
			? projectOAuthDiagnosticText(message.errorMessage)
			: redactOAuthDiagnostic(message.errorMessage, secrets);
	}
	if (message.rawStopReason !== undefined) {
		message.rawStopReason = oauthDiagnostics
			? [
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
				].includes(message.rawStopReason)
				? message.rawStopReason
				: "unknown"
			: redactOAuthDiagnostic(message.rawStopReason, secrets);
	}
	if (message.diagnostics) {
		message.diagnostics = message.diagnostics.map((diagnostic) =>
			oauthDiagnostics
				? {
						type: redactOAuthDiagnostic(diagnostic.type, secrets),
						timestamp: diagnostic.timestamp,
						error: diagnostic.error
							? { name: "OAuthDiagnosticError", message: projectOAuthDiagnosticText(diagnostic.error.message) }
							: undefined,
					}
				: (redactOAuthDiagnosticValue(diagnostic, secrets) as AssistantMessageDiagnostic),
		);
	}
}

export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
