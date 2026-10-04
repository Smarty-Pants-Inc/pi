import type { OAuthRecoveryDecision } from "../../types.ts";
import {
	isPrematureProviderError,
	isProviderContextOverflow,
	isRetryableProviderError,
} from "../../utils/provider-error-classification.ts";
import type { OAuthAuth } from "../types.ts";

export function isOAuthCancellation(error: unknown): boolean {
	try {
		return error instanceof Error && error.message === "Login cancelled";
	} catch {
		return false;
	}
}

export function withOAuthDiagnostics(auth: OAuthAuth): OAuthAuth {
	return {
		...auth,
		async login(interaction, options) {
			try {
				return await auth.login(interaction, options);
			} catch (error) {
				if (interaction.signal.aborted || isOAuthCancellation(error)) throw new Error("Login cancelled");
				throw safeOAuthError(error);
			}
		},
		async refresh(credential, signal) {
			try {
				return await auth.refresh(credential, signal);
			} catch (error) {
				throw safeOAuthError(error);
			}
		},
		async toAuth(credential) {
			try {
				return await auth.toAuth(credential);
			} catch (error) {
				throw safeOAuthError(error);
			}
		},
	};
}

export const oauthDiagnosticLogger = {
	error: (_message: string, ..._args: unknown[]) => console.error("oauth_sdk_diagnostic (HTTP unknown)"),
	warn: (_message: string, ..._args: unknown[]) => console.warn("oauth_sdk_diagnostic (HTTP unknown)"),
	info: (_message: string, ..._args: unknown[]) => console.info("oauth_sdk_diagnostic (HTTP unknown)"),
	debug: (_message: string, ..._args: unknown[]) => console.debug("oauth_sdk_diagnostic (HTTP unknown)"),
};

const PROVIDER_ERROR_CODES = new Set([
	"access_denied",
	"authorization_denied",
	"authorization_pending",
	"deviceauth_authorization_pending",
	"expired_token",
	"invalid_client",
	"invalid_grant",
	"invalid_request",
	"invalid_scope",
	"unauthorized_client",
	"unsupported_grant_type",
	"unsupported_response_type",
	"server_error",
	"temporarily_unavailable",
	"slow_down",
	"rate_limit_exceeded",
	"insufficient_quota",
	"usage_limit_reached",
	"usage_not_included",
	"subscription_sharing_usage_limit_exceeded",
	"websocket_connection_limit_reached",
	"previous_response_not_found",
	"context_length_exceeded",
	"request_too_large",
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
]);

/** Membership, not just syntax, is the boundary for provider-controlled diagnostic codes. */
export function oauthProviderErrorCode(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) && PROVIDER_ERROR_CODES.has(value)
		? value
		: undefined;
}

export type OAuthDiagnosticCode =
	| "oauth_request_failed"
	| "oauth_invalid_response"
	| "oauth_authorization_failed"
	| "oauth_stream_failed"
	| "oauth_transport_failed";

export type OAuthRecoveryCode = "retryable" | "premature_stream" | "context_length_exceeded";

export class OAuthDiagnosticError extends Error {
	readonly code: OAuthDiagnosticCode;
	readonly status?: number;
	readonly providerCode?: string;
	readonly recovery?: OAuthRecoveryCode;
	readonly retryable?: boolean;
	constructor(
		code: OAuthDiagnosticCode,
		status?: number,
		providerCode?: unknown,
		recovery?: unknown,
		retryable?: unknown,
	) {
		const safeRetryable = typeof retryable === "boolean" ? retryable : undefined;
		const safeRecovery =
			recovery === "retryable" || recovery === "premature_stream" || recovery === "context_length_exceeded"
				? recovery
				: undefined;
		const safeStatus =
			typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
		const safeCode = oauthProviderErrorCode(providerCode);
		const safeOwnCode: OAuthDiagnosticCode = [
			"oauth_request_failed",
			"oauth_invalid_response",
			"oauth_authorization_failed",
			"oauth_stream_failed",
			"oauth_transport_failed",
		].includes(code)
			? code
			: "oauth_request_failed";
		super(`${safeOwnCode} (HTTP ${safeStatus ?? "unknown"})${safeCode ? ` provider_error=${safeCode}` : ""}`);
		this.name = "OAuthDiagnosticError";
		this.code = safeOwnCode;
		this.status = safeStatus;
		this.providerCode = safeCode;
		this.recovery = safeRecovery;
		this.retryable = safeRetryable;
	}
}

export function oauthDiagnosticError(
	code: OAuthDiagnosticCode,
	status?: number,
	providerCode?: unknown,
	recovery?: unknown,
	retryable?: unknown,
): OAuthDiagnosticError {
	return new OAuthDiagnosticError(code, status, providerCode, recovery, retryable);
}

/** Never retain the original Error, cause, stack, SDK message, or response payload. */
export function safeOAuthError(
	error: unknown,
	classifyRecovery = false,
	fallbackCode: OAuthDiagnosticCode = "oauth_request_failed",
): OAuthDiagnosticError {
	try {
		if (error instanceof OAuthDiagnosticError)
			return oauthDiagnosticError(error.code, error.status, error.providerCode, error.recovery, error.retryable);
		const shape = error as { status?: number; code?: unknown; message?: unknown; error?: unknown } | null;
		const body = shape?.error as { code?: unknown } | null;
		if (!classifyRecovery) return oauthDiagnosticError(fallbackCode, shape?.status, body?.code ?? shape?.code);
		// Consume provider text only to classify recovery. Never retain it on the returned error.
		const text = `${typeof shape?.message === "string" ? shape.message : ""} ${JSON.stringify(shape?.error) ?? ""} ${typeof shape?.code === "string" ? shape.code : ""} ${typeof shape?.status === "number" ? shape.status : ""}`;
		const retryable = isRetryableProviderError(text);
		const recovery: OAuthRecoveryCode | undefined = isProviderContextOverflow(text)
			? "context_length_exceeded"
			: retryable
				? isPrematureProviderError(text)
					? "premature_stream"
					: "retryable"
				: undefined;
		return oauthDiagnosticError(fallbackCode, shape?.status, body?.code ?? shape?.code, recovery, retryable);
	} catch {
		return oauthDiagnosticError("oauth_request_failed");
	}
}

/** Copy only validated owned decisions; never copy arbitrary provider error fields. */
export function oauthRecoveryDecision(error: OAuthDiagnosticError): OAuthRecoveryDecision {
	const safe = safeOAuthError(error);
	return { recovery: safe.recovery, retryable: safe.retryable };
}

export async function fetchOAuth(input: string | URL, init?: RequestInit): Promise<Response> {
	try {
		return await fetch(input, init);
	} catch {
		throw oauthDiagnosticError("oauth_request_failed");
	}
}

export async function oauthResponseError(response: Response, classifyRecovery = false): Promise<OAuthDiagnosticError> {
	try {
		const text = await response.text();
		let error: unknown;
		try {
			const json = JSON.parse(text) as { error?: unknown } | null;
			error = json?.error;
		} catch {
			/* Plain HTTP bodies can still carry a recovery signal, but never diagnostics. */
		}
		return safeOAuthError(
			{
				status: response.status,
				message: classifyRecovery ? text : undefined,
				error: typeof error === "string" ? { code: error } : error,
			},
			classifyRecovery,
		);
	} catch {
		/* Body/parser failures are untrusted too. */
	}
	return oauthDiagnosticError("oauth_request_failed", response.status);
}

/** Credential response bodies and parser/stream errors must never become login diagnostics. */
export async function readOAuthCredentialResponse(response: Response, _operation: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw oauthDiagnosticError("oauth_invalid_response", response.status);
	}
}

export function oauthStopReason(status: unknown, reason?: unknown): string {
	const safeStatus =
		typeof status === "string" &&
		["completed", "incomplete", "failed", "cancelled", "in_progress", "queued"].includes(status)
			? status
			: "unknown";
	const safeReason =
		reason === "max_output_tokens" || reason === "content_filter" || oauthProviderErrorCode(reason) !== undefined
			? String(reason)
			: reason === undefined
				? undefined
				: "unknown";
	return safeReason ? `${safeStatus}.${safeReason}` : safeStatus;
}

const CREDENTIAL_FIELD =
	/^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|account[_-]?id|chatgpt[_-]account[_-]id|authorization)$/i;
/** Include the active JWT account claim even when a native error echoes it without a field label. */
export function getOAuthDiagnosticSecrets(
	token: string | undefined,
	headers: Record<string, string | null> = {},
	additional: readonly string[] = [],
): string[] {
	const secrets = [...additional];
	if (token) secrets.push(token, `Bearer ${token}`);
	for (const [key, value] of Object.entries(headers)) {
		if (!value) continue;
		const name = key.toLowerCase();
		if (["authorization", "chatgpt-account-id", "account-id"].includes(name)) secrets.push(value);
		if (name === "authorization") {
			// Keep the whole header and the credential: errors may echo either, under any label.
			const authorization = value.trim();
			const schemeEnd = authorization.search(/\s/);
			if (schemeEnd !== -1) {
				const credential = authorization.slice(schemeEnd).trim();
				if (credential) secrets.push(credential);
			}
		}
	}
	if (!token) return secrets;
	try {
		const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as {
			"https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
		};
		const account = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof account === "string" && account) secrets.push(account);
	} catch {
		// An opaque or malformed access token still needs literal redaction.
	}
	return secrets;
}

// Short live values must not replace common words or individual letters in diagnostics.
// Credential-labeled fields and Bearer values are still masked regardless of length.
const MIN_DIAGNOSTIC_SECRET_LENGTH = 8;
const MAX_DIAGNOSTIC_UNESCAPE_PASSES = 16;
const MAX_DIAGNOSTIC_UNESCAPE_WORK = 256 * 1024;
const JSON_ESCAPES: Readonly<Record<string, string>> = {
	'"': '"',
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

/** Decode one layer, including fragments; consume slash runs once, without recursive parsing. */
function unescapeDiagnostic(text: string): string {
	const parts: string[] = [];
	let copied = 0;
	let i = text.indexOf("\\");
	while (i !== -1) {
		parts.push(text.slice(copied, i));
		let end = i;
		while (text[end] === "\\") end++;
		const count = end - i;
		parts.push("\\".repeat(Math.floor(count / 2)));
		if (count % 2) {
			const hex = text.slice(end + 1, end + 5);
			if (text[end] === "u" && /^[0-9a-f]{4}$/i.test(hex)) {
				parts.push(String.fromCharCode(Number.parseInt(hex, 16)));
				end += 5;
			} else if (Object.hasOwn(JSON_ESCAPES, text[end])) {
				parts.push(JSON_ESCAPES[text[end++]]);
			} else parts.push("\\");
		}
		copied = end;
		i = text.indexOf("\\", end);
	}
	parts.push(text.slice(copied));
	return parts.join("");
}

function redactValues(text: string, secrets: readonly string[]): string {
	const variants = new Set<string>();
	for (const secret of secrets) {
		if (secret.length < MIN_DIAGNOSTIC_SECRET_LENGTH || secret.length > text.length) continue;
		variants.add(secret);
		// Browser-safe UTF-8 encoding: standard and URL-safe, padded and unpadded.
		const base64 = btoa(Array.from(new TextEncoder().encode(secret), (byte) => String.fromCharCode(byte)).join(""));
		variants.add(base64);
		variants.add(base64.replace(/=+$/, ""));
		const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_");
		variants.add(base64url);
		variants.add(base64url.replace(/=+$/, ""));
		try {
			variants.add(encodeURIComponent(secret));
		} catch {
			// Invalid Unicode must not turn masking into another diagnostic failure.
		}
	}
	if (!variants.size) return text;
	// Mask complete headers/tokens before a shorter overlapping secret changes them.
	const values = [...variants].sort((a, b) => b.length - a.length);
	for (const value of values) text = text.split(value).join("***");
	const original = text;
	let encodedMatch = false;
	let work = 0;
	// Provider strings have no nesting limit. Decode to a fixed point, masking at
	// every layer so literal backslashes in a secret cannot be decoded past it.
	// Never publish an incompletely examined field when either work bound is hit.
	for (let pass = 0; text.includes("\\"); pass++) {
		work += text.length;
		if (pass === MAX_DIAGNOSTIC_UNESCAPE_PASSES || work > MAX_DIAGNOSTIC_UNESCAPE_WORK) return "***";
		const decoded = unescapeDiagnostic(text);
		if (decoded === text) break;
		text = decoded;
		for (const value of values) {
			if (!text.includes(value)) continue;
			encodedMatch = true;
			text = text.split(value).join("***");
		}
	}
	// Keep untouched diagnostics byte-for-byte. Encoded matches use the safe
	// decoded form, preserving useful context without reconstructing unsafe layers.
	return encodedMatch ? text : original;
}

/** Redact live values first, independently of labels or serialization syntax. */
export function redactOAuthDiagnostic(text: string, secrets: readonly string[] = []): string {
	text = redactValues(text, secrets);

	// Second layer for unknown values. Each character is visited a bounded number
	// of times; slash runs and quoted values are consumed, never searched again.
	const parts: string[] = [];
	let copied = 0;
	let i = 0;
	while (i < text.length) {
		const start = i;
		let key = "";
		while (i < text.length) {
			if (/[a-z0-9_-]/i.test(text[i])) {
				key += text[i++];
			} else if (text[i] === "\\") {
				let end = i;
				while (text[end] === "\\") end++;
				const hex = text.slice(end + 1, end + 5);
				if (text[end] === "u" && /^[0-9a-f]{4}$/i.test(hex)) {
					key += String.fromCharCode(Number.parseInt(hex, 16));
					i = end + 5;
				} else {
					// Leave a field's escaped closing quote for the delimiter scan.
					if (!key) i = end;
					break;
				}
			} else break;
		}
		if (!CREDENTIAL_FIELD.test(key) && key.toLowerCase() !== "bearer") {
			if (i === start) i++;
			continue;
		}
		const keyEnd = i;
		while (text[i] === "\\") i++;
		if (text[i] === '"' || text[i] === "'") i++;
		while (i < text.length && /\s/.test(text[i])) i++;
		if (key.toLowerCase() !== "bearer") {
			if (text[i] !== ":" && text[i] !== "=") {
				parts.push(text.slice(copied, keyEnd), ': "***"');
				copied = text.length;
				break; // Uncertain credential-bearing fragment: discard its remainder.
			}
			i++;
			while (i < text.length && /\s/.test(text[i])) i++;
		}
		const delimiterStart = i;
		while (text[i] === "\\") i++;
		const depth = i - delimiterStart;
		const quote = text[i];
		if (quote === '"' || quote === "'") {
			i++;
			while (i < text.length) {
				let slashes = 0;
				while (text[i] === "\\") {
					slashes++;
					i++;
				}
				if (text[i] === quote && slashes <= depth) {
					i++;
					break;
				}
				i++;
			}
		} else {
			if (text.slice(i, i + 7).toLowerCase() === "bearer ") i += 7;
			while (i < text.length && !/[\s"',;}&]/.test(text[i])) i++;
		}
		parts.push(text.slice(copied, keyEnd), key.toLowerCase() === "bearer" ? " ***" : ': "***"');
		copied = i;
	}
	parts.push(text.slice(copied));
	return parts.join("");
}

/** Clone log arguments into safe data; never hand the original Error/cause or custom inspect hooks to console. */
export function redactOAuthDiagnosticValue(
	value: unknown,
	secrets: readonly string[] = [],
	seen = new Set<unknown>(),
): unknown {
	if (typeof value === "string") return redactOAuthDiagnostic(value, secrets);
	if (value === null || typeof value !== "object") return typeof value === "function" ? "[Function]" : value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => redactOAuthDiagnosticValue(item, secrets, seen));
		const entries =
			value instanceof Error ? { ...value, name: value.name, message: value.message, stack: value.stack } : value;
		return Object.fromEntries(
			Object.entries(entries).map(([key, item]) => [
				CREDENTIAL_FIELD.test(key) ? redactValues(key, secrets) : redactOAuthDiagnostic(key, secrets),
				CREDENTIAL_FIELD.test(key) ? "***" : redactOAuthDiagnosticValue(item, secrets, seen),
			]),
		);
	} finally {
		seen.delete(value);
	}
}

/** Authorization errors are untrusted text. Keep only protocol codes; never echo error_description. */
export function oauthAuthorizationError(code: string): string {
	switch (code) {
		case "access_denied":
		case "invalid_request":
		case "unauthorized_client":
		case "unsupported_response_type":
		case "invalid_scope":
		case "server_error":
		case "temporarily_unavailable":
			return code;
		default:
			return "authorization_error";
	}
}
