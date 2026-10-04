import {
	redactOAuthDiagnostic,
	redactOAuthDiagnosticValue,
	safeOAuthError,
} from "../auth/oauth/credential-response.ts";
import type { JsonObject } from "../types.ts";

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

export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
