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
