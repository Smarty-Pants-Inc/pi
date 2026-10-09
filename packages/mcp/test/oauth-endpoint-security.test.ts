import { describe, expect, it, vi } from "vitest";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
} from "../src/oauth/discovery.ts";
import { OAuthInsecureEndpointError } from "../src/oauth/errors.ts";
import {
	authorizeMcp,
	exchangeAuthorizationCode,
	type OAuthClientProvider,
	registerClient,
	startAuthorization,
} from "../src/oauth/flow.ts";
import { type AuthorizationServerMetadata, parseAuthorizationServerMetadata } from "../src/oauth/types.ts";

// pi#173: exercise the dormant OAuth implementation without lifting the production MCP admission refusal.
// security-admission.test.ts separately proves the shipping refusal still applies.
vi.mock("../src/security-admission.ts", () => ({ refuseMcpAdmission: () => {} }));

function metadata(origin = "https://oauth.test"): AuthorizationServerMetadata {
	return {
		issuer: origin,
		authorization_endpoint: `${origin}/authorize`,
		registration_endpoint: `${origin}/register`,
		token_endpoint: `${origin}/token`,
		revocation_endpoint: `${origin}/revoke`,
		response_types_supported: ["code"],
	};
}
const clientMetadata = { redirect_uris: ["http://127.0.0.1/callback"] };
const clientInformation = { client_id: "synthetic-client" };

describe("OAuth endpoint transport security (pi#173)", () => {
	it("refuses non-loopback HTTP discovery before making a request", async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(metadata()));
		await expect(discoverAuthorizationServerMetadata("http://oauth.test", { fetch })).rejects.toBeInstanceOf(
			OAuthInsecureEndpointError,
		);
		await expect(discoverProtectedResourceMetadata("http://resource.test/mcp", { fetch })).rejects.toBeInstanceOf(
			OAuthInsecureEndpointError,
		);
		await expect(
			discoverOAuthServerInfo("https://resource.test/mcp", {
				resourceMetadataUrl: new URL("http://resource.test/metadata"),
				fetch,
			}),
		).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
		await expect(
			discoverOAuthServerInfo("https://resource.test/mcp", {
				authorizationServerMetadataUrl: new URL("http://oauth.test/metadata"),
				fetch: async (url, init) =>
					String(url).includes("oauth.test") ? fetch(url, init) : new Response(null, { status: 404 }),
			}),
		).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		"authorization_endpoint",
		"registration_endpoint",
		"token_endpoint",
		"revocation_endpoint",
		"issuer",
	] as const)("refuses advertised HTTP %s during discovery and before direct operations", async (field) => {
		const insecure = { ...metadata(), [field]: "http://attacker.test/endpoint" };
		expect(() => parseAuthorizationServerMetadata(insecure)).toThrow(OAuthInsecureEndpointError);
		await expect(
			discoverAuthorizationServerMetadata("https://oauth.test", { fetch: async () => Response.json(insecure) }),
		).rejects.toThrow("non-HTTPS endpoint");
		const fetch = vi.fn(async () => Response.json({ client_id: "synthetic-client" }));
		await expect(
			startAuthorization("https://oauth.test", {
				metadata: insecure,
				clientInformation,
				redirectUrl: clientMetadata.redirect_uris[0]!,
			}),
		).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
		await expect(
			registerClient("https://oauth.test", { metadata: insecure, clientMetadata, fetch }),
		).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
		await expect(
			exchangeAuthorizationCode("https://oauth.test", {
				metadata: insecure,
				clientInformation,
				code: "synthetic",
				codeVerifier: "synthetic",
				redirectUrl: clientMetadata.redirect_uris[0]!,
				fetch,
			}),
		).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not swallow an insecure advertised authorization server as a discovery miss", async () => {
		const fetch = vi.fn(async () =>
			Response.json({ resource: "https://resource.test/mcp", authorization_servers: ["http://attacker.test"] }),
		);
		await expect(discoverOAuthServerInfo("https://resource.test/mcp", { fetch })).rejects.toBeInstanceOf(
			OAuthInsecureEndpointError,
		);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("validates cached metadata before saving or redirecting", async () => {
		const redirectToAuthorization = vi.fn();
		const saveDiscoveryState = vi.fn();
		const provider: OAuthClientProvider = {
			redirectUrl: clientMetadata.redirect_uris[0]!,
			clientMetadata,
			clientInformation: () => clientInformation,
			tokens: () => undefined,
			saveTokens: () => {},
			saveCodeVerifier: () => {},
			codeVerifier: () => "synthetic",
			redirectToAuthorization,
			saveDiscoveryState,
			discoveryState: () => ({
				authorizationServerUrl: "https://oauth.test",
				authorizationServerMetadata: { ...metadata(), revocation_endpoint: "http://attacker.test/revoke" },
			}),
		};
		await expect(authorizeMcp(provider, { serverUrl: "https://resource.test/mcp" })).rejects.toBeInstanceOf(
			OAuthInsecureEndpointError,
		);
		expect(redirectToAuthorization).not.toHaveBeenCalled();
		expect(saveDiscoveryState).not.toHaveBeenCalled();
	});

	it.each(["http://127.0.0.1", "http://localhost", "http://[::1]", "https://oauth.test"])(
		"allows discovery and OAuth endpoints at %s",
		async (origin) => {
			const configured = metadata(origin);
			const fetch = vi.fn(async (url: string | URL | Request) => {
				const pathname = new URL(String(url)).pathname;
				if (pathname.endsWith("/register")) return Response.json({ ...clientMetadata, ...clientInformation });
				if (pathname.endsWith("/token"))
					return Response.json({ access_token: "synthetic-token", token_type: "Bearer" });
				return Response.json(configured);
			});
			expect(await discoverAuthorizationServerMetadata(origin, { fetch })).toEqual(configured);
			const { authorizationUrl } = await startAuthorization(origin, {
				metadata: configured,
				clientInformation,
				redirectUrl: clientMetadata.redirect_uris[0]!,
			});
			expect(authorizationUrl.origin).toBe(origin);
			expect((await registerClient(origin, { metadata: configured, clientMetadata, fetch })).client_id).toBe(
				"synthetic-client",
			);
			expect(
				(
					await exchangeAuthorizationCode(origin, {
						metadata: configured,
						clientInformation,
						code: "synthetic",
						codeVerifier: "synthetic",
						redirectUrl: clientMetadata.redirect_uris[0]!,
						fetch,
					})
				).access_token,
			).toBe("synthetic-token");
		},
	);

	it.each(["http://localhost.attacker.test", "ftp://localhost"])(
		"refuses non-HTTP loopback exceptions and lookalike hosts: %s",
		async (origin) => {
			await expect(
				startAuthorization(origin, { clientInformation, redirectUrl: clientMetadata.redirect_uris[0]! }),
			).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
		},
	);
});
