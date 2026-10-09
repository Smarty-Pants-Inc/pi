import { OAuthInsecureEndpointError } from "./errors.ts";
import type { AuthorizationServerMetadata } from "./types.ts";

export function loopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** OAuth HTTP is allowed only on loopback; discovery and every advertised endpoint share this rule. */
export function secureEndpoint(value: string | URL): URL {
	const url = new URL(value);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) {
		throw new OAuthInsecureEndpointError(url.href);
	}
	return url;
}

/** Also validate cached/configured metadata before a flow or a direct endpoint operation uses it. */
export function validateOAuthEndpoints(metadata: AuthorizationServerMetadata | undefined): void {
	if (!metadata) return;
	for (const endpoint of [
		metadata.issuer,
		metadata.authorization_endpoint,
		metadata.token_endpoint,
		metadata.registration_endpoint,
		metadata.revocation_endpoint,
	]) {
		if (endpoint !== undefined) secureEndpoint(endpoint);
	}
}
