/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to remove Zod/CORS shims and enforce authorization-server issuer validation.
 */

import type { McpFetch } from "../auth-provider.ts";
import { LATEST_PROTOCOL_VERSION } from "../protocol/types.ts";
import { refuseMcpAdmission } from "../security-admission.ts";
import { metadataFetch, secureEndpoint, validateOAuthEndpointOrigins } from "./endpoints.ts";
import {
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
	OAuthRedirectRefusedError,
	OAuthResourceMismatchError,
} from "./errors.ts";
import {
	type AuthorizationServerMetadata,
	type OAuthChallenge,
	type OAuthProtectedResourceMetadata,
	type OAuthServerInfo,
	parseAuthorizationServerMetadata,
	parseProtectedResourceMetadata,
} from "./types.ts";

function discard(response: Response | undefined): void {
	void response?.body?.cancel().catch(() => {});
}

/** 4xx and 502 mean "not here", so discovery tries the next candidate URL. */
function isDiscoveryMiss(status: number): boolean {
	return (status >= 400 && status < 500) || status === 502;
}

/** Path suffix for `/.well-known/<kind><path>`; empty for the root path. */
function pathSuffix(pathname: string): string {
	return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function field(header: string, name: string): string | undefined {
	const match = header.match(new RegExp(String.raw`(?:^|[,\s])${name}=(?:"([^"]*)"|([^\s,]+))`, "i"));
	// An empty value (`scope=""`) carries no information, so it counts as absent.
	return match?.[1] || match?.[2] || undefined;
}

export function parseWwwAuthenticate(header: string | null): OAuthChallenge {
	if (!header) return {};
	const scheme = header.trimStart().split(/\s+/, 1)[0]?.toLowerCase();
	if (scheme !== "bearer" && scheme !== "dpop") return {};
	const resourceMetadata = field(header, "resource_metadata");
	let resourceMetadataUrl: URL | undefined;
	if (resourceMetadata) {
		try {
			resourceMetadataUrl = new URL(resourceMetadata);
		} catch {}
	}
	return {
		resourceMetadataUrl,
		scope: field(header, "scope"),
		error: field(header, "error"),
		errorDescription: field(header, "error_description"),
	};
}

async function fetchMetadata(
	url: URL,
	fetch: McpFetch,
	protocolVersion: string,
	signal: AbortSignal | undefined,
): Promise<Response> {
	return metadataFetch(fetch, url, {
		headers: { Accept: "application/json", "MCP-Protocol-Version": protocolVersion },
		signal,
	});
}

export async function discoverProtectedResourceMetadata(
	serverUrl: string | URL,
	options: {
		resourceMetadataUrl?: string | URL;
		protocolVersion?: string;
		fetch?: McpFetch;
		signal?: AbortSignal;
	} = {},
): Promise<OAuthProtectedResourceMetadata> {
	refuseMcpAdmission();
	const server = new URL(serverUrl);
	const fetch = options.fetch ?? globalThis.fetch;
	const version = options.protocolVersion ?? LATEST_PROTOCOL_VERSION;
	let response = await fetchMetadata(
		options.resourceMetadataUrl
			? new URL(options.resourceMetadataUrl)
			: new URL(`/.well-known/oauth-protected-resource${pathSuffix(server.pathname)}`, server.origin),
		fetch,
		version,
		options.signal,
	);
	if (!options.resourceMetadataUrl && server.pathname !== "/" && isDiscoveryMiss(response.status)) {
		discard(response);
		response = await fetchMetadata(
			new URL("/.well-known/oauth-protected-resource", server.origin),
			fetch,
			version,
			options.signal,
		);
	}
	if (!response.ok) {
		discard(response);
		throw new Error(`HTTP ${response.status} loading OAuth protected resource metadata`);
	}
	const metadata = parseProtectedResourceMetadata(await response.json());
	// RFC 9728 §3.3: metadata naming another resource must not steer this server's authorization.
	selectResource(server, metadata);
	return metadata;
}

export function buildAuthorizationServerDiscoveryUrls(
	authorizationServerUrl: string | URL,
): { url: URL; type: "oauth" | "oidc" }[] {
	const issuer = secureEndpoint(authorizationServerUrl);
	const path = pathSuffix(issuer.pathname);
	const urls: { url: URL; type: "oauth" | "oidc" }[] = [
		{ url: new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin), type: "oauth" },
		{ url: new URL(`/.well-known/openid-configuration${path}`, issuer.origin), type: "oidc" },
	];
	if (path) urls.push({ url: new URL(`${path}/.well-known/openid-configuration`, issuer.origin), type: "oidc" });
	return urls;
}

export async function discoverAuthorizationServerMetadata(
	authorizationServerUrl: string | URL,
	options: {
		fetch?: McpFetch;
		protocolVersion?: string;
		skipIssuerValidation?: boolean;
		/** See `OAuthFlowOptions.allowedEndpointOrigins`. */
		allowedEndpointOrigins?: readonly string[];
		signal?: AbortSignal;
	} = {},
): Promise<AuthorizationServerMetadata | undefined> {
	refuseMcpAdmission();
	const fetch = options.fetch ?? globalThis.fetch;
	for (const { url } of buildAuthorizationServerDiscoveryUrls(authorizationServerUrl)) {
		const response = await fetchMetadata(
			url,
			fetch,
			options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
			options.signal,
		);
		if (!response.ok) {
			discard(response);
			if (isDiscoveryMiss(response.status)) continue;
			throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
		}
		const metadata = parseAuthorizationServerMetadata(await response.json());
		// RFC 8414 §3.3: the issuer must be identical to the identifier the discovery URL was built from.
		const expected = String(authorizationServerUrl);
		if (!options.skipIssuerValidation && metadata.issuer !== expected) {
			throw new OAuthIssuerMismatchError(expected, metadata.issuer);
		}
		// The endpoints must then live on the issuer's origin, so the issuer check also covers where credentials go.
		validateOAuthEndpointOrigins(metadata, options.allowedEndpointOrigins);
		return metadata;
	}
	return undefined;
}

export async function discoverOAuthServerInfo(
	serverUrl: string | URL,
	options: {
		resourceMetadataUrl?: URL;
		/**
		 * Metadata document to use instead of discovery. It is trusted as configured, so its issuer is not checked,
		 * but its endpoints must still share the origin of the issuer it names (see `allowedEndpointOrigins`).
		 */
		authorizationServerMetadataUrl?: URL;
		fetch?: McpFetch;
		skipIssuerValidation?: boolean;
		/** See `OAuthFlowOptions.allowedEndpointOrigins`. */
		allowedEndpointOrigins?: readonly string[];
		signal?: AbortSignal;
	} = {},
): Promise<OAuthServerInfo> {
	refuseMcpAdmission();
	let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
	try {
		resourceMetadata = await discoverProtectedResourceMetadata(serverUrl, {
			resourceMetadataUrl: options.resourceMetadataUrl,
			fetch: options.fetch,
			signal: options.signal,
		});
	} catch (error) {
		if (
			error instanceof TypeError ||
			error instanceof OAuthInsecureEndpointError ||
			error instanceof OAuthRedirectRefusedError ||
			error instanceof OAuthResourceMismatchError
		)
			throw error;
	}
	if (options.authorizationServerMetadataUrl) {
		const url = options.authorizationServerMetadataUrl;
		const response = await fetchMetadata(
			url,
			options.fetch ?? globalThis.fetch,
			LATEST_PROTOCOL_VERSION,
			options.signal,
		);
		if (!response.ok) {
			discard(response);
			throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
		}
		const metadata = parseAuthorizationServerMetadata(await response.json());
		validateOAuthEndpointOrigins(metadata, options.allowedEndpointOrigins);
		return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata, resourceMetadata };
	}
	// Without resource metadata the issuer is the server origin, which has no trailing slash.
	const authorizationServerUrl = resourceMetadata?.authorization_servers?.[0] ?? new URL(serverUrl).origin;
	return {
		authorizationServerUrl,
		authorizationServerMetadata: await discoverAuthorizationServerMetadata(authorizationServerUrl, {
			fetch: options.fetch,
			skipIssuerValidation: options.skipIssuerValidation,
			allowedEndpointOrigins: options.allowedEndpointOrigins,
			signal: options.signal,
		}),
		resourceMetadata,
	};
}

export function resourceUrlFromServerUrl(value: string | URL): URL {
	const url = new URL(value);
	url.hash = "";
	return url;
}

export function selectResource(serverUrl: string | URL, metadata?: OAuthProtectedResourceMetadata): string | undefined {
	if (!metadata) return undefined;
	const requested = resourceUrlFromServerUrl(serverUrl);
	const configured = new URL(metadata.resource);
	if (requested.origin !== configured.origin) {
		throw new OAuthResourceMismatchError(requested.href, metadata.resource);
	}
	const requestedPath = requested.pathname.endsWith("/") ? requested.pathname : `${requested.pathname}/`;
	const configuredPath = configured.pathname.endsWith("/") ? configured.pathname : `${configured.pathname}/`;
	if (!requestedPath.startsWith(configuredPath)) {
		throw new OAuthResourceMismatchError(requested.href, metadata.resource);
	}
	return metadata.resource;
}
