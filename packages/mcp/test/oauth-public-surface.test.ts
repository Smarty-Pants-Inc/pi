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
