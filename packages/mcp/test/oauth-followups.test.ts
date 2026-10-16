import { describe, expect, it, vi } from "vitest";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
	selectResource,
} from "../src/oauth/discovery.ts";
import { OAuthIssuerMismatchError, OAuthResourceMismatchError } from "../src/oauth/errors.ts";
import { authorizeMcp, type OAuthClientProvider, refreshAuthorization } from "../src/oauth/flow.ts";
import type { AuthorizationServerMetadata } from "../src/oauth/types.ts";

// Exercise dormant OAuth without changing the production admission refusal.
vi.mock("../src/security-admission.ts", () => ({ refuseMcpAdmission: () => {} }));

const issuer = "https://oauth.test/tenant";
const metadata: AuthorizationServerMetadata = {
	issuer,
	authorization_endpoint: "https://oauth.test/authorize",
	token_endpoint: "https://oauth.test/token",
	response_types_supported: ["code"],
};

function provider(cached: AuthorizationServerMetadata) {
	return {
		redirectUrl: "http://127.0.0.1/callback",
		clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"] },
		clientInformation: vi.fn(() => ({ client_id: "synthetic-client" })),
		tokens: () => ({ access_token: "old", token_type: "Bearer", refresh_token: "synthetic-refresh" }),
		saveTokens: vi.fn(),
		saveCodeVerifier: vi.fn(),
		codeVerifier: () => "synthetic-verifier",
		redirectToAuthorization: vi.fn(),
		saveDiscoveryState: vi.fn(),
		discoveryState: () => ({ authorizationServerUrl: issuer, authorizationServerMetadata: cached }),
	} satisfies OAuthClientProvider;
}

describe("OAuth follow-ups (smarty-dev#7586)", () => {
	// smarty-dev#7586 P3: no option waives the exact issuer identity required by pi#178.
	it.each(["https://attacker.test", "https://oauth.test/other-tenant", `${issuer}/`])(
		"skipIssuerValidation cannot return discovered metadata for %s",
		async (foreignIssuer) => {
			const foreign = {
				...metadata,
				issuer: foreignIssuer,
				authorization_endpoint: `${new URL(foreignIssuer).origin}/authorize`,
				token_endpoint: `${new URL(foreignIssuer).origin}/token`,
			};
			const fetch = vi.fn(async () => Response.json(foreign));
			await expect(
				discoverAuthorizationServerMetadata(issuer, {
					fetch,
					skipIssuerValidation: true,
					allowedEndpointOrigins: [new URL(foreignIssuer).origin],
				}),
			).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
			expect(fetch).toHaveBeenCalledOnce();
			await expect(
				discoverAuthorizationServerMetadata(issuer, {
					fetch: async () => Response.json(metadata),
					skipIssuerValidation: true,
				}),
			).resolves.toEqual(metadata);
		},
	);

	// smarty-dev#7586 P3: cached foreign metadata must not be saved or handed to provider callbacks.
	it("rejects a cached issuer mismatch before caching or using credentials", async () => {
		const cached = provider({ ...metadata, issuer: "https://oauth.test/other-tenant" });
		const fetch = vi.fn(async () => Response.json({ access_token: "new", token_type: "Bearer" }));
		await expect(
			authorizeMcp(cached, { serverUrl: "https://resource.test/mcp", fetch, skipIssuerValidation: true }),
		).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
		expect(cached.saveDiscoveryState).not.toHaveBeenCalled();
		expect(cached.clientInformation).not.toHaveBeenCalled();
		expect(cached.saveTokens).not.toHaveBeenCalled();
		expect(cached.redirectToAuthorization).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();

		const matching = provider(metadata);
		await expect(
			authorizeMcp(matching, { serverUrl: "https://resource.test/mcp", fetch, skipIssuerValidation: true }),
		).resolves.toBe("AUTHORIZED");
		expect(matching.saveDiscoveryState).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("keeps explicitly configured metadata independent of its document origin", async () => {
		const fetch = vi.fn(async (input: string | URL) =>
			String(input).includes("config.test") ? Response.json(metadata) : new Response(null, { status: 404 }),
		);
		await expect(
			discoverOAuthServerInfo("https://resource.test/mcp", {
				authorizationServerMetadataUrl: new URL("https://config.test/document.json"),
				fetch,
			}),
		).resolves.toMatchObject({ authorizationServerUrl: issuer, authorizationServerMetadata: metadata });
	});

	// smarty-dev#7586 P3: allowlist entries are origins, not URLs silently widened to origins.
	it.each([
		"https://trusted.example@attacker.test",
		"https://user:password@tokens.test",
		"https://@tokens.test",
		"https://tokens.test/token",
		"https://tokens.test/?query=1",
		"https://tokens.test/?",
		"https://tokens.test/#fragment",
		"https://tokens.test/#",
		"ftp://tokens.test",
		"data:text/plain,https://tokens.test",
		"blob:https://tokens.test/id",
		"tokens.test",
		"http://tokens.test",
	])("rejects invalid allowedEndpointOrigins entry %s before a token request", async (entry) => {
		const fetch = vi.fn(async () => Response.json({ access_token: "new", token_type: "Bearer" }));
		await expect(
			refreshAuthorization(issuer, {
				metadata,
				clientInformation: { client_id: "synthetic-client" },
				refreshToken: "synthetic-refresh",
				allowedEndpointOrigins: [entry],
				fetch,
			}),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});

	// smarty-dev#7586: a missing metadata document does not excuse a malformed allowlist.
	it("validates allowlist entries for fallback endpoints without metadata", async () => {
		const fetch = vi.fn(async () => Response.json({ access_token: "new", token_type: "Bearer" }));
		await expect(
			refreshAuthorization(issuer, {
				clientInformation: { client_id: "synthetic-client" },
				refreshToken: "synthetic-refresh",
				allowedEndpointOrigins: ["https://tokens.test/token"],
				fetch,
			}),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		["https://tokens.test", ["https://TOKENS.test:443/", "https://tokens.test", "https://tokens.test/"]],
		["http://localhost:8123", ["http://LOCALHOST:8123/", "http://localhost:8123"]],
		["http://127.0.0.1:8123", ["http://127.0.0.1:8123/", "http://127.0.0.1:8123"]],
		["http://[::1]:8123", ["http://[::1]:8123/", "http://[::1]:8123"]],
	] as const)("accepts normalized and duplicate origins for %s", async (origin, allowedEndpointOrigins) => {
		const fetch = vi.fn(async (_input: string | URL) => Response.json({ access_token: "new", token_type: "Bearer" }));
		await expect(
			refreshAuthorization(issuer, {
				metadata: { ...metadata, token_endpoint: `${origin}/token` },
				clientInformation: { client_id: "synthetic-client" },
				refreshToken: "synthetic-refresh",
				allowedEndpointOrigins,
				fetch,
			}),
		).resolves.toMatchObject({ access_token: "new" });
		expect(fetch).toHaveBeenCalledOnce();
		expect(String(fetch.mock.calls[0]?.[0])).toBe(`${origin}/token`);
	});

	// smarty-dev#7586: /mcpevil is a sibling, not a child of /mcp.
	it("refuses sibling resource /mcpevil for /mcp while accepting /mcp and its children", async () => {
		await expect(
			discoverProtectedResourceMetadata("https://resource.test/mcp", {
				fetch: async () => Response.json({ resource: "https://resource.test/mcpevil" }),
			}),
		).rejects.toBeInstanceOf(OAuthResourceMismatchError);
		const resource = { resource: "https://resource.test/mcp" };
		expect(() => selectResource("https://resource.test/mcpevil", resource)).toThrow(OAuthResourceMismatchError);
		expect(selectResource("https://resource.test/mcp", resource)).toBe(resource.resource);
		expect(selectResource("https://resource.test/mcp/child", resource)).toBe(resource.resource);
	});
});
