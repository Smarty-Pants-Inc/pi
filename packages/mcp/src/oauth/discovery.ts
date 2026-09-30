/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to remove Zod/CORS shims and enforce authorization-server issuer validation.
 */

import { LATEST_PROTOCOL_VERSION } from "../protocol/types.ts";
import { isOAuthNetworkBoundaryError, OAuthInsecureEndpointError, OAuthIssuerMismatchError } from "./errors.ts";
import { type OAuthNetworkOperation, type OAuthNetworkOptions, withOAuthNetwork } from "./response.ts";
import {
	type AuthorizationServerMetadata,
	type OAuthChallenge,
	type OAuthProtectedResourceMetadata,
	type OAuthServerInfo,
	parseAuthorizationServerMetadata,
	parseProtectedResourceMetadata,
	validateOAuthUrl,
} from "./types.ts";

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
	return match?.[1] ?? match?.[2];
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

async function fetchMetadata(url: URL, operation: OAuthNetworkOperation, protocolVersion: string): Promise<Response> {
	return operation.fetch(validateOAuthUrl(url), {
		headers: { Accept: "application/json", "MCP-Protocol-Version": protocolVersion },
	});
}

export async function discoverProtectedResourceMetadata(
	serverUrl: string | URL,
	options: OAuthNetworkOptions & { resourceMetadataUrl?: string | URL; protocolVersion?: string } = {},
): Promise<OAuthProtectedResourceMetadata> {
	return withOAuthNetwork(options, (operation) => protectedResourceMetadata(serverUrl, options, operation));
}

async function protectedResourceMetadata(
	serverUrl: string | URL,
	options: { resourceMetadataUrl?: string | URL; protocolVersion?: string },
	operation: OAuthNetworkOperation,
): Promise<OAuthProtectedResourceMetadata> {
	const server = new URL(serverUrl);
	const version = options.protocolVersion ?? LATEST_PROTOCOL_VERSION;
	let response = await fetchMetadata(
		options.resourceMetadataUrl
			? new URL(options.resourceMetadataUrl)
			: new URL(`/.well-known/oauth-protected-resource${pathSuffix(server.pathname)}`, server.origin),
		operation,
		version,
	);
	if (!options.resourceMetadataUrl && server.pathname !== "/" && isDiscoveryMiss(response.status)) {
		operation.discard(response);
		response = await fetchMetadata(
			new URL("/.well-known/oauth-protected-resource", server.origin),
			operation,
			version,
		);
	}
	if (!response.ok) {
		operation.discard(response);
		throw new Error(`HTTP ${response.status} loading OAuth protected resource metadata`);
	}
	return parseProtectedResourceMetadata(JSON.parse(await operation.text(response)));
}

export function buildAuthorizationServerDiscoveryUrls(
	authorizationServerUrl: string | URL,
): { url: URL; type: "oauth" | "oidc" }[] {
	const issuer = validateOAuthUrl(authorizationServerUrl);
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
	options: OAuthNetworkOptions & { protocolVersion?: string; skipIssuerValidation?: boolean } = {},
): Promise<AuthorizationServerMetadata | undefined> {
	return withOAuthNetwork(options, (operation) =>
		authorizationServerMetadata(authorizationServerUrl, options, operation),
	);
}

async function authorizationServerMetadata(
	authorizationServerUrl: string | URL,
	options: { protocolVersion?: string; skipIssuerValidation?: boolean },
	operation: OAuthNetworkOperation,
): Promise<AuthorizationServerMetadata | undefined> {
	for (const { url } of buildAuthorizationServerDiscoveryUrls(authorizationServerUrl)) {
		const response = await fetchMetadata(url, operation, options.protocolVersion ?? LATEST_PROTOCOL_VERSION);
		if (!response.ok) {
			operation.discard(response);
			if (isDiscoveryMiss(response.status)) continue;
			throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
		}
		const metadata = parseAuthorizationServerMetadata(JSON.parse(await operation.text(response)));
		if (!options.skipIssuerValidation) {
			const expected = String(authorizationServerUrl);
			// URL parsing adds a trailing slash to bare origins, so compare without one on either side.
			const trim = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value);
			if (trim(metadata.issuer) !== trim(expected)) throw new OAuthIssuerMismatchError(expected, metadata.issuer);
		}
		return metadata;
	}
	return undefined;
}

export async function discoverOAuthServerInfo(
	serverUrl: string | URL,
	options: OAuthNetworkOptions & {
		resourceMetadataUrl?: URL;
		skipIssuerValidation?: boolean;
	} = {},
): Promise<OAuthServerInfo> {
	return withOAuthNetwork(options, async (operation) => {
		let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
		try {
			resourceMetadata = await protectedResourceMetadata(serverUrl, options, operation);
		} catch (error) {
			if (
				error instanceof TypeError ||
				error instanceof OAuthInsecureEndpointError ||
				isOAuthNetworkBoundaryError(error)
			)
				throw error;
		}
		const authorizationServerUrl = resourceMetadata?.authorization_servers?.[0] ?? String(new URL("/", serverUrl));
		return {
			authorizationServerUrl,
			authorizationServerMetadata: await authorizationServerMetadata(authorizationServerUrl, options, operation),
			resourceMetadata,
		};
	});
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
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	}
	const requestedPath = requested.pathname.endsWith("/") ? requested.pathname : `${requested.pathname}/`;
	const configuredPath = configured.pathname.endsWith("/") ? configured.pathname : `${configured.pathname}/`;
	if (!requestedPath.startsWith(configuredPath)) {
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	}
	return metadata.resource;
}
