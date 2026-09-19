/** Nonsecret SDK placeholder. Only the original owner's final transport replaces
 * it; this value is neither a credential nor permission to send a request. */
export const ORDINARY_CREDENTIAL_PLACEHOLDER = "smarty-ordinary-protected-delivery";

export interface PreparedCredentialScope {
	readonly deliveryId: string;
	readonly decisionDigest: string;
	readonly allocationId: string;
	readonly provider: string;
	readonly purpose: string;
	readonly account: string;
	/** SHA256 of the selected op:// reference bytes, never the resolved secret. */
	readonly referenceSha256: string;
	readonly notBeforeMs: number;
	readonly expiresMs: number;
}

/** Parse the private platform envelope. This pure check issues no owner, custody
 * or attestation. Call only after native descriptor receiving; never persist its
 * return, input, or parser errors. Unknown upstream metadata is not POC policy. */
export function parsePreparedCredential(bytes: Uint8Array, expected: PreparedCredentialScope): string {
	try {
		if (!bytes.length || bytes.length > 65_536) throw new Error();
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value) || `${JSON.stringify(value)}\n` !== text)
			throw new Error();
		const envelope = value as Record<string, unknown>;
		const names = [
			"deliveryId",
			"decisionDigest",
			"allocationId",
			"provider",
			"purpose",
			"account",
			"referenceSha256",
			"notBeforeMs",
			"expiresMs",
		] as const;
		if (
			Object.keys(envelope).length !== names.length + 2 ||
			envelope.version !== 1 ||
			!Object.hasOwn(envelope, "credential")
		)
			throw new Error();
		for (const name of names)
			if (!Object.hasOwn(envelope, name) || envelope[name] !== expected[name]) throw new Error();
		if (
			!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(expected.deliveryId) ||
			!/^[a-f0-9]{64}$/.test(expected.decisionDigest) ||
			!/^[a-f0-9]{64}$/.test(expected.referenceSha256) ||
			!Number.isSafeInteger(expected.notBeforeMs) ||
			expected.notBeforeMs <= 0 ||
			!Number.isSafeInteger(expected.expiresMs) ||
			expected.expiresMs <= expected.notBeforeMs
		)
			throw new Error();
		const credential = envelope.credential;
		if (!credential || typeof credential !== "object" || Array.isArray(credential)) throw new Error();
		const fields = credential as Record<string, unknown>;
		if (
			Object.keys(fields).length !== 2 ||
			!Object.hasOwn(fields, "type") ||
			!Object.hasOwn(fields, "key") ||
			fields.type !== "api_key" ||
			typeof fields.key !== "string" ||
			!/^[\x21-\x7e]{1,8192}$/.test(fields.key)
		)
			throw new Error();
		return fields.key;
	} catch {
		// JSON errors can quote secret-bearing input. Deliberately omit their cause.
		throw new Error("OWNER_CREDENTIAL_ENVELOPE");
	}
}
