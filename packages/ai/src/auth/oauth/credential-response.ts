/** Credential response bodies and parser/stream errors must never become login diagnostics. */
export async function readOAuthCredentialResponse(response: Response, operation: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new Error(`${operation} response is invalid JSON`);
	}
}

const CREDENTIAL_FIELD =
	/^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|account[_-]?id|chatgpt[_-]account[_-]id|authorization)$/i;
// Quote delimiters may have any number of JSON-serialization backslashes. If a field's
// separator/value is missing or a quoted value is unfinished, discard the rest of the fragment.
const CREDENTIAL_TEXT =
	/((?:\\*["'])?\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|account[_-]?id|chatgpt[_-]account[_-]id|authorization)\b(?:\\*["'])?)(?:\s*[:=]\s*(?:\\*"[^"]*(?:"|$)|\\*'[^']*(?:'|$)|Bearer\s+[^\s"',;}&]+|[^\s"',;}&]+|[\s\S]*)|[\s\S]*)/gi;

/** Include the active JWT account claim even when a native error echoes it without a field label. */
export function getOAuthDiagnosticSecrets(token: string | undefined): string[] {
	if (!token) return [];
	const secrets = [token];
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

/** Redact before truncating/serializing diagnostics, not the intentional credential APIs or model output. */
export function redactOAuthDiagnostic(text: string, secrets: readonly string[] = []): string {
	// Native header errors and SDK messages may quote or URL-encode the active bearer/account value.
	for (const secret of secrets) {
		if (!secret) continue;
		const variants = new Set([secret, JSON.stringify(secret).slice(1, -1)]);
		try {
			variants.add(encodeURIComponent(secret));
		} catch {
			// Invalid Unicode can itself trigger a native header error; redaction must not throw.
		}
		for (const encoded of variants) {
			text = text.split(encoded).join("[REDACTED]");
		}
	}
	// Parse actual JSON (including an SDK status prefix) so escaped field names have their semantic spelling.
	for (const start of new Set([0, text.indexOf("{")])) {
		if (start < 0) continue;
		try {
			const value: unknown = JSON.parse(text.slice(start));
			if (value !== null && typeof value === "object") {
				const redacted = JSON.stringify(redactOAuthDiagnosticValue(value, secrets));
				if (redacted !== JSON.stringify(value)) return text.slice(0, start) + redacted;
			}
		} catch {
			// Plain text, partial JSON and native errors still go through field/literal redaction below.
		}
	}
	text = text.replace(CREDENTIAL_TEXT, '$1: "[REDACTED]"').replace(/\bBearer\s+[^\s"',;}]+/gi, "Bearer [REDACTED]");
	// SDK error messages can contain JSON whose message is itself serialized credential-bearing JSON.
	text = text.replace(/"(?:\\.|[^"\\])*"/g, (quoted, offset: number) => {
		try {
			const value: unknown = JSON.parse(quoted);
			if (typeof value !== "string") return quoted;
			if (
				CREDENTIAL_FIELD.test(value) &&
				text
					.slice(offset + quoted.length)
					.trimStart()
					.startsWith(":")
			)
				return JSON.stringify(value);
			const redacted = redactOAuthDiagnostic(value, secrets);
			return redacted === value ? quoted : JSON.stringify(redacted);
		} catch {
			return quoted;
		}
	});
	return text.replace(CREDENTIAL_TEXT, '$1: "[REDACTED]"');
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
				CREDENTIAL_FIELD.test(key) ? key : redactOAuthDiagnostic(key, secrets),
				CREDENTIAL_FIELD.test(key)
					? item === "***"
						? "***"
						: "[REDACTED]"
					: redactOAuthDiagnosticValue(item, secrets, seen),
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
