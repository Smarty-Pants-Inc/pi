import type { McpFetch } from "../auth-provider.ts";
import {
	OAuthEndpointOriginError,
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
	OAuthRedirectRefusedError,
} from "./errors.ts";
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

/** Discovery GETs follow at most this many redirects, validating each target. */
const MAX_DISCOVERY_REDIRECTS = 3;

function isRedirect(response: Response): boolean {
	// `opaqueredirect` is what browsers return for `redirect: "manual"`; Node exposes the 3xx status itself.
	return response.type === "opaqueredirect" || [301, 302, 303, 307, 308].includes(response.status);
}

function discard(response: Response): void {
	void response.body?.cancel().catch(() => {});
}

/**
 * Send a credential-bearing request (token, registration, revocation). fetch follows redirects by default and
 * would resend the body (codes, refresh tokens, client secrets) to the new target, possibly over plain HTTP.
 * These requests never follow a redirect, whatever its target.
 */
export async function credentialFetch(fetch: McpFetch, url: URL, init: RequestInit): Promise<Response> {
	const response = await fetch(secureEndpoint(url), { ...init, redirect: "manual" });
	if (isRedirect(response)) {
		discard(response);
		throw new OAuthRedirectRefusedError(url.href, response.status, "credential requests never follow redirects");
	}
	return response;
}

/**
 * GET a discovery or metadata document. Redirects are followed manually, at most MAX_DISCOVERY_REDIRECTS times.
 * Each Location must pass the same HTTPS/loopback rule as the initial URL and stay on its origin (scheme, host,
 * port): a cross-origin target could serve metadata that claims the original issuer while advertising its own
 * authorization and token endpoints.
 */
export async function metadataFetch(fetch: McpFetch, url: URL, init: RequestInit): Promise<Response> {
	let current = secureEndpoint(url);
	for (let redirects = 0; ; redirects++) {
		const response = await fetch(current, { ...init, method: "GET", redirect: "manual" });
		if (!isRedirect(response)) return response;
		discard(response);
		const location = response.headers.get("location");
		if (response.type === "opaqueredirect" || !location) {
			throw new OAuthRedirectRefusedError(current.href, response.status, "redirect target is not visible");
		}
		if (redirects >= MAX_DISCOVERY_REDIRECTS) {
			throw new OAuthRedirectRefusedError(current.href, response.status, "too many redirects");
		}
		const next = secureEndpoint(new URL(location, current));
		if (next.origin !== current.origin) {
			throw new OAuthRedirectRefusedError(current.href, response.status, `cross-origin redirect to ${next.origin}`);
		}
		current = next;
	}
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

/**
 * Bind the advertised endpoints to the issuer, after the issuer itself was validated. Metadata that names the right
 * issuer but sends codes, refresh tokens, or client secrets to another origin is refused unless that origin is in
 * `allowedEndpointOrigins`. The HTTPS/loopback rule of `validateOAuthEndpoints` applies as well, allowlisted or not.
 */
export function validateOAuthEndpointOrigins(
	metadata: AuthorizationServerMetadata | undefined,
	allowedEndpointOrigins: readonly string[] = [],
): void {
	const allowed = new Set(
		allowedEndpointOrigins.map((value) => {
			// Check the input before URL normalization can erase userinfo, paths, or empty query/fragment markers.
			if (value !== value.trim() || !/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(value) || !URL.canParse(value)) {
				throw new TypeError(`Invalid allowedEndpointOrigins entry ${JSON.stringify(value)}`);
			}
			return secureEndpoint(value).origin;
		}),
	);
	if (!metadata) return;
	validateOAuthEndpoints(metadata);
	const issuer = new URL(metadata.issuer).origin;
	for (const field of [
		"authorization_endpoint",
		"token_endpoint",
		"registration_endpoint",
		"revocation_endpoint",
	] as const) {
		const endpoint = metadata[field];
		if (endpoint === undefined) continue;
		const origin = new URL(endpoint).origin;
		if (origin !== issuer && !allowed.has(origin))
			throw new OAuthEndpointOriginError(field, endpoint, metadata.issuer);
	}
}

/**
 * For the exported token operations, which take metadata from their caller: besides the endpoint origins, bind the
 * metadata to the authorization server the caller names (smarty-dev#7638). As in discovery (RFC 8414 §3.3), the issuer
 * must be identical to that identifier: the same origin is not enough (tenants share origins), and neither
 * `allowedEndpointOrigins` nor any other option waives it. A server whose metadata names another issuer is configured
 * with `authorizationServerMetadataUrl`, whose issuer is then the identifier.
 */
export function validateOAuthServerMetadata(
	authorizationServerUrl: string | URL,
	metadata: AuthorizationServerMetadata | undefined,
	allowedEndpointOrigins: readonly string[] = [],
): void {
	validateOAuthEndpointOrigins(metadata, allowedEndpointOrigins);
	if (!metadata) return;
	secureEndpoint(authorizationServerUrl);
	const expected = String(authorizationServerUrl);
	if (metadata.issuer !== expected) throw new OAuthIssuerMismatchError(expected, metadata.issuer);
}
