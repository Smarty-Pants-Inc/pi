/** Credential response bodies and parser/stream errors must never become login diagnostics. */
export async function readOAuthCredentialResponse(response: Response, operation: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new Error(`${operation} response is invalid JSON`);
	}
}

// One label set for header names, field labels and object keys. A label is a credential label when one
// of its words (split at "-", "_" and camelCase) ends in a credential word: X-Client-Credential,
// X-Amz-Signature, x-csrftoken, sessionId. Whole words only, so "Unauthorized:", "credit:" and
// "max_tokens:" stay readable. ponytail: name-based, a custom header needs no registration; a false
// match only masks a value.
const CREDENTIAL_WORD =
	/(?:key|token|secret|auth|authorization|authentication|cookie|session(?:id)?|password|passwd|credentials?|creds?|signature|jwt|bearer|private)$/;
function isCredentialLabel(label: string): boolean {
	if (/account[_-]?id/i.test(label)) return true;
	return label
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.some((word) => CREDENTIAL_WORD.test(word));
}
// Labels whose value is a credential by definition: a bare label without a value ends the diagnostic (fail-closed).
// API-key labels include prefixed header names such as x-api-key and x-goog-api-key.
const FAIL_CLOSED_FIELD =
	/^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|account[_-]?id|chatgpt[_-]account[_-]id|authorization|(?:[a-z0-9]+[_-])*api[_-]?key)$/i;
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
		if (!isCredentialLabel(key)) continue;
		secrets.push(value);
		// "Bearer x", "Basic x", "Token x": the credential part can be echoed alone.
		const separator = value.search(/\s/);
		if (separator >= 0) secrets.push(value.slice(separator).trim());
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

/**
 * Live credential values of one provider request: the API key, auth headers of
 * the model and request, and values the caller or auth resolution supplied.
 */
export function getRequestDiagnosticSecrets(
	model: { headers?: Record<string, string> } | undefined,
	options:
		| {
				apiKey?: string;
				headers?: Record<string, string | null>;
				diagnosticSecrets?: readonly string[];
		  }
		| undefined,
): string[] {
	return getOAuthDiagnosticSecrets(
		options?.apiKey,
		{ ...model?.headers, ...options?.headers },
		options?.diagnosticSecrets ?? [],
	);
}

// Short live values must not replace common words or single letters in diagnostics.
// Credential-labeled fields and Bearer values are still masked at any length.
const MIN_DIAGNOSTIC_SECRET_LENGTH = 8;
const MAX_DIAGNOSTIC_DECODE_PASSES = 16;
const MAX_DIAGNOSTIC_DECODE_WORK = 256 * 1024;
const JSON_ESCAPES: Readonly<Record<string, string>> = {
	'"': '"',
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

function percentDecode(run: string): string {
	try {
		return decodeURIComponent(run);
	} catch {
		// Malformed UTF-8: decode byte by byte; matching still sees every ASCII credential character.
		return run.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
	}
}

/**
 * Decode one JSON-string layer and one percent-encoding layer. Slash runs are
 * consumed once, so each pass is linear; composition order does not matter
 * because the caller repeats passes and masks after each one.
 */
function decodeDiagnosticLayer(text: string): string {
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
	return parts.join("").replace(/(?:%[0-9a-f]{2})+/gi, percentDecode);
}

function base64Variants(secret: string): string[] {
	const base64 = btoa(Array.from(new TextEncoder().encode(secret), (byte) => String.fromCharCode(byte)).join(""));
	const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_");
	return [base64, base64.replace(/=+$/, ""), base64url, base64url.replace(/=+$/, "")];
}

function maskAll(text: string, values: readonly string[]): { text: string; matched: boolean } {
	let matched = false;
	for (const value of values) {
		if (!text.includes(value)) continue;
		matched = true;
		text = text.split(value).join("***");
	}
	return { text, matched };
}

/**
 * Mask only the live values in `secrets` (raw, JSON/URI-escaped, form or base64 encoded).
 * No label heuristics, so an opaque provider token without a live value stays byte for byte.
 */
export function redactValues(text: string, secrets: readonly string[]): string {
	const variants = new Set<string>();
	for (const secret of secrets) {
		if (typeof secret !== "string" || secret.length < MIN_DIAGNOSTIC_SECRET_LENGTH) continue;
		variants.add(secret);
		for (const value of base64Variants(secret)) variants.add(value);
		// Form encoding turns spaces into "+", which percent decoding does not reverse.
		variants.add(new URLSearchParams({ v: secret }).toString().slice(2));
	}
	if (!variants.size) return text;
	// Mask complete headers/tokens before a shorter overlapping secret changes them.
	const values = [...variants].sort((a, b) => b.length - a.length);
	const first = maskAll(text, values);
	const original = first.text;
	text = first.text;
	let encodedMatch = false;
	let work = 0;
	// Serializers compose (JSON inside URL inside JSON, ...). Decode to a fixed
	// point, masking at every layer. Never publish a field that was not fully
	// examined: hitting either bound withholds it.
	for (let pass = 0; text.includes("\\") || /%[0-9a-f]{2}/i.test(text); pass++) {
		work += text.length;
		if (pass === MAX_DIAGNOSTIC_DECODE_PASSES || work > MAX_DIAGNOSTIC_DECODE_WORK) return "***";
		const decoded = decodeDiagnosticLayer(text);
		if (decoded === text) break;
		const masked = maskAll(decoded, values);
		encodedMatch ||= masked.matched;
		text = masked.text;
	}
	// Untouched diagnostics stay byte-for-byte; an encoded match publishes the safe decoded form.
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
		const bearer = key.toLowerCase() === "bearer";
		if (!bearer && !isCredentialLabel(key)) {
			if (i === start) i++;
			continue;
		}
		const keyEnd = i;
		while (text[i] === "\\") i++;
		if (text[i] === '"' || text[i] === "'") i++;
		while (i < text.length && /\s/.test(text[i])) i++;
		if (!bearer) {
			if (text[i] !== ":" && text[i] !== "=") {
				// Prose such as "session expired" or "invalid X-Client-Credential header" carries no value here.
				if (!FAIL_CLOSED_FIELD.test(key)) {
					i = keyEnd;
					continue;
				}
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
		parts.push(text.slice(copied, keyEnd), bearer ? " ***" : ': "***"');
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
				isCredentialLabel(key) ? redactValues(key, secrets) : redactOAuthDiagnostic(key, secrets),
				isCredentialLabel(key) ? "***" : redactOAuthDiagnosticValue(item, secrets, seen),
			]),
		);
	} finally {
		seen.delete(value);
	}
}

type SdkLogFunction = (message: string, ...args: unknown[]) => void;

/**
 * SDK logger that masks every argument. Never hand the original Error, its
 * cause or custom inspect hooks to the console: they can carry the request key.
 */
export function createRedactingSdkLogger(secrets: readonly string[]): {
	error: SdkLogFunction;
	warn: SdkLogFunction;
	info: SdkLogFunction;
	debug: SdkLogFunction;
} {
	const safe = (message: string, args: unknown[]) =>
		[message, ...args].map((arg) => redactOAuthDiagnosticValue(arg, secrets));
	return {
		error: (message, ...args) => console.error(...safe(message, args)),
		warn: (message, ...args) => console.warn(...safe(message, args)),
		info: (message, ...args) => console.info(...safe(message, args)),
		debug: (message, ...args) => console.debug(...safe(message, args)),
	};
}

/** OAuth errors are untrusted text. Keep only protocol codes; never echo error_description. */
export function oauthAuthorizationError(code: string): string {
	switch (code) {
		case "access_denied":
		case "invalid_request":
		case "unauthorized_client":
		case "unsupported_response_type":
		case "invalid_scope":
		case "server_error":
		case "temporarily_unavailable":
		// Token endpoint (RFC 6749 5.2) and device flow (RFC 8628 3.5) codes.
		case "invalid_client":
		case "invalid_grant":
		case "unsupported_grant_type":
		case "authorization_pending":
		case "slow_down":
		case "expired_token":
			return code;
		default:
			return "authorization_error";
	}
}
