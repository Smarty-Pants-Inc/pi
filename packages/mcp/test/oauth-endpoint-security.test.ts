import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
} from "../src/oauth/discovery.ts";
import { OAuthInsecureEndpointError, OAuthRedirectRefusedError } from "../src/oauth/errors.ts";
import {
	authorizeMcp,
	exchangeAuthorizationCode,
	type OAuthClientProvider,
	refreshAuthorization,
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

	describe("redirects (pi#173 review)", () => {
		function redirect(status: number, location: string): Response {
			return new Response(null, { status, headers: { location } });
		}

		it.each([
			[307, "http://attacker.test/token"],
			[308, "https://other.test/token"],
			[302, "https://oauth.test/token2"],
		])("token endpoint %i -> %s is refused without a second request", async (status, location) => {
			const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => redirect(status, location));
			const request = refreshAuthorization("https://oauth.test", {
				metadata: metadata(),
				clientInformation,
				refreshToken: "synthetic-refresh",
				fetch,
			});
			await expect(request).rejects.toBeInstanceOf(OAuthRedirectRefusedError);
			expect(fetch).toHaveBeenCalledOnce();
			expect(fetch.mock.calls[0]![1]?.redirect).toBe("manual");
		});

		it("authorization code exchange and registration never follow a redirect", async () => {
			const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
				redirect(308, "https://oauth.test/elsewhere"),
			);
			await expect(
				exchangeAuthorizationCode("https://oauth.test", {
					metadata: metadata(),
					clientInformation,
					code: "synthetic",
					codeVerifier: "synthetic",
					redirectUrl: clientMetadata.redirect_uris[0]!,
					fetch,
				}),
			).rejects.toBeInstanceOf(OAuthRedirectRefusedError);
			await expect(
				registerClient("https://oauth.test", { metadata: metadata(), clientMetadata, fetch }),
			).rejects.toBeInstanceOf(OAuthRedirectRefusedError);
			expect(fetch).toHaveBeenCalledTimes(2);
			for (const [, init] of fetch.mock.calls) expect(init?.redirect).toBe("manual");
		});

		it("refuses an opaque redirect from a credential request", async () => {
			const opaque = new Response(null, { status: 200 });
			Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
			const fetch = vi.fn(async () => opaque);
			await expect(
				refreshAuthorization("https://oauth.test", {
					metadata: metadata(),
					clientInformation,
					refreshToken: "synthetic-refresh",
					fetch,
				}),
			).rejects.toBeInstanceOf(OAuthRedirectRefusedError);
		});

		it("refresh does not fall back to a new authorization after a refused redirect", async () => {
			const redirectToAuthorization = vi.fn();
			const provider: OAuthClientProvider = {
				redirectUrl: clientMetadata.redirect_uris[0]!,
				clientMetadata,
				clientInformation: () => clientInformation,
				tokens: () => ({ access_token: "old", token_type: "Bearer", refresh_token: "synthetic-refresh" }),
				saveTokens: () => {},
				saveCodeVerifier: () => {},
				codeVerifier: () => "synthetic",
				redirectToAuthorization,
				discoveryState: () => ({
					authorizationServerUrl: "https://oauth.test",
					authorizationServerMetadata: metadata(),
				}),
			};
			const fetch = vi.fn(async () => redirect(307, "http://attacker.test/token"));
			await expect(authorizeMcp(provider, { serverUrl: "https://resource.test/mcp", fetch })).rejects.toBeInstanceOf(
				OAuthRedirectRefusedError,
			);
			expect(redirectToAuthorization).not.toHaveBeenCalled();
		});

		it("discovery 302 -> https is followed after validation", async () => {
			const configured = metadata();
			const fetch = vi.fn(async (url: string | URL, _init?: RequestInit) =>
				new URL(String(url)).hostname === "oauth.test"
					? redirect(302, "https://cdn.oauth.test/metadata.json")
					: Response.json(configured),
			);
			expect(await discoverAuthorizationServerMetadata("https://oauth.test", { fetch })).toEqual(configured);
			expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
				"https://oauth.test/.well-known/oauth-authorization-server",
				"https://cdn.oauth.test/metadata.json",
			]);
			for (const [, init] of fetch.mock.calls) expect(init?.redirect).toBe("manual");
		});

		it("discovery 302 -> http is refused before following", async () => {
			const fetch = vi.fn(async (url: string | URL, _init?: RequestInit) =>
				new URL(String(url)).hostname === "oauth.test"
					? redirect(302, "http://attacker.test/metadata.json")
					: Response.json(metadata()),
			);
			await expect(discoverAuthorizationServerMetadata("https://oauth.test", { fetch })).rejects.toBeInstanceOf(
				OAuthInsecureEndpointError,
			);
			await expect(
				discoverOAuthServerInfo("https://resource.test/mcp", {
					fetch: async (url, init) =>
						new URL(String(url)).hostname === "resource.test"
							? redirect(302, "http://attacker.test/prm")
							: fetch(url, init),
				}),
			).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
			expect(fetch.mock.calls.every(([url]) => new URL(String(url)).hostname === "oauth.test")).toBe(true);
		});

		it("discovery stops after a bounded number of redirects", async () => {
			const fetch = vi.fn(async () => redirect(302, "https://oauth.test/loop"));
			await expect(discoverAuthorizationServerMetadata("https://oauth.test", { fetch })).rejects.toBeInstanceOf(
				OAuthRedirectRefusedError,
			);
			expect(fetch).toHaveBeenCalledTimes(4);
		});

		it("real fetch: a loopback token endpoint answering 307 receives exactly one request", async () => {
			const seen: string[] = [];
			const server = createServer((req: IncomingMessage, res) => {
				seen.push(`${req.method} ${req.url}`);
				req.resume();
				if (req.url === "/token") {
					res.writeHead(307, { location: "/stolen" }).end();
				} else {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ access_token: "stolen", token_type: "Bearer" }));
				}
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			try {
				const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
				await expect(
					refreshAuthorization(origin, {
						metadata: metadata(origin),
						clientInformation,
						refreshToken: "synthetic-refresh",
					}),
				).rejects.toBeInstanceOf(OAuthRedirectRefusedError);
				expect(seen).toEqual(["POST /token"]);
			} finally {
				await new Promise((resolve) => server.close(resolve));
			}
		});
	});

	it.each(["http://localhost.attacker.test", "ftp://localhost"])(
		"refuses non-HTTP loopback exceptions and lookalike hosts: %s",
		async (origin) => {
			await expect(
				startAuthorization(origin, { clientInformation, redirectUrl: clientMetadata.redirect_uris[0]! }),
			).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
		},
	);
});
