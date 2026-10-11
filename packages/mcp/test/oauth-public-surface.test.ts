import { describe, expect, it, vi } from "vitest";
import * as oauth from "../src/oauth/index.ts";
import type { AuthorizationServerMetadata } from "../src/oauth/types.ts";

// pi#173: exercise the dormant OAuth implementation without lifting the production MCP admission refusal.
// security-admission.test.ts separately proves the shipping refusal still applies.
vi.mock("../src/security-admission.ts", () => ({ refuseMcpAdmission: () => {} }));

// pi#173 (Astra P1, then CODE P1): the token operations stay public API (documented since 1.0.x), and each one
// binds its endpoints to the issuer origin and allowedEndpointOrigins itself, before any request.
const publicOperations = ["startAuthorization", "registerClient", "exchangeAuthorizationCode", "refreshAuthorization"];

function crossOrigin(field: "authorization_endpoint" | "registration_endpoint" | "token_endpoint") {
	const metadata: AuthorizationServerMetadata = {
		issuer: "https://oauth.test",
		authorization_endpoint: "https://oauth.test/authorize",
		registration_endpoint: "https://oauth.test/register",
		token_endpoint: "https://oauth.test/token",
		response_types_supported: ["code"],
	};
	return { ...metadata, [field]: `https://attacker.test/${field}` };
}
const client = { client_id: "client", client_secret: "secret" };
const operations = {
	startAuthorization: (allowedEndpointOrigins?: string[]) =>
		oauth.startAuthorization("https://oauth.test", {
			metadata: crossOrigin("authorization_endpoint"),
			clientInformation: client,
			redirectUrl: "http://127.0.0.1/callback",
			allowedEndpointOrigins,
		}),
	registerClient: (allowedEndpointOrigins?: string[], fetch?: typeof globalThis.fetch) =>
		oauth.registerClient("https://oauth.test", {
			metadata: crossOrigin("registration_endpoint"),
			clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"] },
			fetch,
			allowedEndpointOrigins,
		}),
	exchangeAuthorizationCode: (allowedEndpointOrigins?: string[], fetch?: typeof globalThis.fetch) =>
		oauth.exchangeAuthorizationCode("https://oauth.test", {
			metadata: crossOrigin("token_endpoint"),
			clientInformation: client,
			code: "code",
			codeVerifier: "verifier",
			redirectUrl: "http://127.0.0.1/callback",
			fetch,
			allowedEndpointOrigins,
		}),
	refreshAuthorization: (allowedEndpointOrigins?: string[], fetch?: typeof globalThis.fetch) =>
		oauth.refreshAuthorization("https://oauth.test", {
			metadata: crossOrigin("token_endpoint"),
			clientInformation: client,
			refreshToken: "refresh",
			fetch,
			allowedEndpointOrigins,
		}),
} as const;

it.each(publicOperations)("%s stays exported from the ./oauth entry", (name) => {
	expect(typeof (oauth as Record<string, unknown>)[name]).toBe("function");
});

describe("each exported operation binds its endpoint to the issuer origin itself", () => {
	it.each(Object.keys(operations) as (keyof typeof operations)[])(
		"%s refuses an endpoint on another origin, with no request",
		async (name) => {
			const fetch = vi.fn(async () => Response.json({ client_id: "x", access_token: "t", token_type: "bearer" }));
			await expect(operations[name](undefined, fetch)).rejects.toBeInstanceOf(oauth.OAuthEndpointOriginError);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each(Object.keys(operations) as (keyof typeof operations)[])(
		"%s accepts that origin when allowlisted",
		async (name) => {
			const fetch = vi.fn(async () =>
				Response.json({ client_id: "x", redirect_uris: [], access_token: "t", token_type: "bearer" }),
			);
			await expect(operations[name](["https://attacker.test"], fetch)).resolves.toBeDefined();
		},
	);
});

// smarty-dev#7638 (pi#173 r7 P1): metadata whose issuer AND endpoints are on another origin than the authorization
// server the caller names must not pass just because the endpoints match their own issuer.
function foreignIssuer(): AuthorizationServerMetadata {
	return {
		issuer: "https://attacker.test",
		authorization_endpoint: "https://attacker.test/authorize",
		registration_endpoint: "https://attacker.test/register",
		token_endpoint: "https://attacker.test/token",
		response_types_supported: ["code"],
	};
}
const foreign = {
	startAuthorization: (allowedEndpointOrigins?: string[]) =>
		oauth.startAuthorization("https://oauth.test", {
			metadata: foreignIssuer(),
			clientInformation: client,
			redirectUrl: "http://127.0.0.1/callback",
			allowedEndpointOrigins,
		}),
	registerClient: (allowedEndpointOrigins?: string[], fetch?: typeof globalThis.fetch) =>
		oauth.registerClient("https://oauth.test", {
			metadata: foreignIssuer(),
			clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"] },
			fetch,
			allowedEndpointOrigins,
		}),
	exchangeAuthorizationCode: (allowedEndpointOrigins?: string[], fetch?: typeof globalThis.fetch) =>
		oauth.exchangeAuthorizationCode("https://oauth.test", {
			metadata: foreignIssuer(),
			clientInformation: client,
			code: "code",
			codeVerifier: "verifier",
			redirectUrl: "http://127.0.0.1/callback",
			fetch,
			allowedEndpointOrigins,
		}),
	refreshAuthorization: (allowedEndpointOrigins?: string[], fetch?: typeof globalThis.fetch) =>
		oauth.refreshAuthorization("https://oauth.test", {
			metadata: foreignIssuer(),
			clientInformation: client,
			refreshToken: "refresh",
			fetch,
			allowedEndpointOrigins,
		}),
} as const;

describe("each exported operation binds the metadata issuer to the authorization server it is given", () => {
	it.each(Object.keys(foreign) as (keyof typeof foreign)[])(
		"%s refuses an issuer and endpoints on another origin, with no request",
		async (name) => {
			const fetch = vi.fn(async () => Response.json({ client_id: "x", access_token: "t", token_type: "bearer" }));
			await expect(foreign[name](undefined, fetch)).rejects.toBeInstanceOf(oauth.OAuthIssuerMismatchError);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each(Object.keys(foreign) as (keyof typeof foreign)[])(
		"%s refuses that issuer even when its origin is allowlisted, with no request",
		async (name) => {
			const fetch = vi.fn(async () => Response.json({ client_id: "x", access_token: "t", token_type: "bearer" }));
			await expect(foreign[name](["https://attacker.test"], fetch)).rejects.toBeInstanceOf(
				oauth.OAuthIssuerMismatchError,
			);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("refuses another issuer on the same origin (another tenant), with no request", async () => {
		const fetch = vi.fn(async () => Response.json({ access_token: "t", token_type: "bearer" }));
		const tenant = (path: string): AuthorizationServerMetadata => ({
			issuer: `https://oauth.test/${path}`,
			authorization_endpoint: `https://oauth.test/${path}/authorize`,
			token_endpoint: `https://oauth.test/${path}/token`,
			response_types_supported: ["code"],
		});
		await expect(
			oauth.refreshAuthorization("https://oauth.test/tenant-a", {
				metadata: tenant("tenant-b"),
				clientInformation: client,
				refreshToken: "refresh",
				fetch,
			}),
		).rejects.toBeInstanceOf(oauth.OAuthIssuerMismatchError);
		expect(fetch).not.toHaveBeenCalled();
		await expect(
			oauth.refreshAuthorization("https://oauth.test/tenant-a", {
				metadata: tenant("tenant-a"),
				clientInformation: client,
				refreshToken: "refresh",
				fetch,
			}),
		).resolves.toBeDefined();
	});
});

describe("authorizeMcp with skipIssuerValidation", () => {
	it("still refuses to use metadata whose issuer differs: no registration, token request or redirect", async () => {
		const requests: string[] = [];
		const fetch = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			requests.push(`${url.host}${url.pathname}`);
			if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
				return Response.json({
					resource: "https://resource.test/mcp",
					authorization_servers: ["https://oauth.test"],
				});
			if (url.pathname.startsWith("/.well-known/"))
				return Response.json({ ...foreignIssuer(), code_challenge_methods_supported: ["S256"] });
			return Response.json({ client_id: "x", access_token: "t", token_type: "bearer" });
		});
		const provider = {
			redirectUrl: "http://127.0.0.1/callback",
			clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"] },
			clientInformation: async () => undefined,
			saveClientInformation: vi.fn(async () => {}),
			tokens: async () => undefined,
			saveTokens: vi.fn(async () => {}),
			redirectToAuthorization: vi.fn(async () => {}),
			saveCodeVerifier: async () => {},
			codeVerifier: async () => "verifier",
		};
		await expect(
			oauth.authorizeMcp(provider as never, {
				serverUrl: "https://resource.test/mcp",
				fetch: fetch as never,
				skipIssuerValidation: true,
			}),
		).rejects.toBeInstanceOf(oauth.OAuthIssuerMismatchError);
		expect(requests.filter((r) => r.startsWith("attacker.test"))).toEqual([]);
		expect(provider.saveClientInformation).not.toHaveBeenCalled();
		expect(provider.redirectToAuthorization).not.toHaveBeenCalled();
	});
});
