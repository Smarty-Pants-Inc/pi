import {
	ORDINARY_CREDENTIAL_PLACEHOLDER,
	type PreparedCredentialScope,
	parsePreparedCredential,
} from "./ordinary-credential-delivery.ts";
import { ownershipOf, type SessionOwnership } from "./session-ownership.ts";

/** Called only by protected bootstrap. No setter, credential resolver, public
 * option, or copied receipt can install this result into an ordinary context. */
export function receivePreparedCredential(
	owner: SessionOwnership,
	scope: PreparedCredentialScope,
	endpoint: string,
	countEndpoint?: string,
) {
	const manager = owner.manager;
	if (ownershipOf(manager) !== owner) throw new Error("OWNER_CREDENTIAL_OWNER");
	owner.assertActive();
	const grant = owner.grant;
	const sessionId = manager.getSessionId();
	let key: string | undefined;
	const assertCurrent = () => {
		try {
			if (
				!key ||
				ownershipOf(manager) !== owner ||
				owner.manager !== manager ||
				owner.grant !== grant ||
				manager.getSessionId() !== sessionId
			) {
				throw new Error("OWNER_CREDENTIAL_REVOKED");
			}
			owner.assertActive();
			// Native checks A's held/named inode, readonly mount and original
			// allocation lifetime. An ambient replacement B cannot authorize A.
			owner.checkCredential();
		} catch (error) {
			key = undefined;
			throw error;
		}
	};
	const bytes = owner.receiveCredential();
	try {
		key = parsePreparedCredential(bytes, scope);
		assertCurrent();
	} finally {
		bytes.fill(0);
	}
	return Object.freeze({
		assertCurrent,
		authorize(request: Request): Request {
			assertCurrent();
			if (
				(request.url !== endpoint && request.url !== countEndpoint) ||
				request.method !== "POST" ||
				request.headers.get("authorization") !== `Bearer ${ORDINARY_CREDENTIAL_PLACEHOLDER}` ||
				["api-key", "x-api-key", "cookie", "proxy-authorization", "openai-organization", "openai-project"].some(
					(name) => request.headers.has(name),
				)
			) {
				throw new Error("OWNER_CREDENTIAL_REQUEST_SCOPE");
			}
			const headers = new Headers(request.headers);
			headers.set("authorization", `Bearer ${key}`);
			request.signal.throwIfAborted();
			return new Request(request, { headers, redirect: "error" });
		},
		// Fence before any cleanup await. JS strings are not guaranteed zeroizable.
		revoke(): void {
			key = undefined;
		},
	});
}
