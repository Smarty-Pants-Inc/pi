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
	code?: string | number;
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
	secrets: readonly string[] = [],
	oauthDiagnostics = false,
): DiagnosticErrorInfo {
	if (oauthDiagnostics) {
		const safe = safeOAuthError(error);
		return { name: safe.name, message: redactOAuthDiagnostic(safe.message, secrets), code: safe.code };
	}
	if (!(error instanceof Error))
		return { name: "ThrownValue", message: redactOAuthDiagnostic(formatThrownValue(error), secrets) };
	const code = (error as Error & { code?: unknown }).code;
	return {
		name: error.name ? redactOAuthDiagnostic(error.name, secrets) : undefined,
		message: redactOAuthDiagnostic(error.message || error.name, secrets),
		stack: error.stack === undefined ? undefined : redactOAuthDiagnostic(error.stack, secrets),
		code:
			typeof code === "string" ? redactOAuthDiagnostic(code, secrets) : typeof code === "number" ? code : undefined,
	};
}

export function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	details?: JsonObject,
	secrets: readonly string[] = [],
	oauthDiagnostics = false,
): AssistantMessageDiagnostic {
	return {
		type,
		timestamp: Date.now(),
		error: extractDiagnosticError(error, secrets, oauthDiagnostics),
		details: oauthDiagnostics ? undefined : (redactOAuthDiagnosticValue(details, secrets) as JsonObject | undefined),
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
