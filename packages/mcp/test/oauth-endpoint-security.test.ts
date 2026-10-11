import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
} from "../src/oauth/discovery.ts";
import {
	OAuthEndpointOriginError,
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
	OAuthRedirectRefusedError,
	OAuthResourceMismatchError,
} from "../src/oauth/errors.ts";
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

		it("discovery 302 -> same-origin https is followed after validation", async () => {
			const configured = metadata();
			const fetch = vi.fn(async (url: string | URL, _init?: RequestInit) =>
				new URL(String(url)).pathname.startsWith("/.well-known/")
					? redirect(302, "/static/metadata.json")
					: Response.json(configured),
			);
			expect(await discoverAuthorizationServerMetadata("https://oauth.test", { fetch })).toEqual(configured);
			expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
				"https://oauth.test/.well-known/oauth-authorization-server",
				"https://oauth.test/static/metadata.json",
			]);
			for (const [, init] of fetch.mock.calls) expect(init?.redirect).toBe("manual");
		});

		// pi#173 review: the redirect target could claim the original issuer and advertise its own endpoints.
		it.each([
			"https://attacker.test/.well-known/oauth-authorization-server",
			"https://cdn.oauth.test/metadata.json",
			"https://oauth.test:8443/metadata.json",
		])("discovery 302 -> cross-origin %s is refused without a second request", async (location) => {
			const fetch = vi.fn(async (url: string | URL, _init?: RequestInit) =>
				new URL(String(url)).hostname === "oauth.test" && new URL(String(url)).port === ""
					? redirect(302, location)
					: Response.json({ ...metadata("https://attacker.test"), issuer: "https://oauth.test" }),
			);
			await expect(discoverAuthorizationServerMetadata("https://oauth.test", { fetch })).rejects.toBeInstanceOf(
				OAuthRedirectRefusedError,
			);
			expect(fetch).toHaveBeenCalledOnce();

			const prm = vi.fn(async (_url: string | URL, _init?: RequestInit) => redirect(302, location));
			await expect(
				discoverOAuthServerInfo("https://oauth.test/mcp", {
					resourceMetadataUrl: new URL("https://oauth.test/prm"),
					fetch: prm,
				}),
			).rejects.toBeInstanceOf(OAuthRedirectRefusedError);
			expect(prm).toHaveBeenCalledOnce();
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

	describe("metadata identity (pi#173 review)", () => {
		it.each(["https://attacker.test", "https://oauth.test/", "https://oauth.test/tenant"])(
			"refuses authorization server metadata whose issuer is %s instead of https://oauth.test",
			async (issuer) => {
				const fetch = vi.fn(async () => Response.json({ ...metadata(), issuer }));
				await expect(discoverAuthorizationServerMetadata("https://oauth.test", { fetch })).rejects.toBeInstanceOf(
					OAuthIssuerMismatchError,
				);
			},
		);

		it("accepts authorization server metadata whose issuer matches exactly", async () => {
			const configured = metadata("https://oauth.test/tenant");
			const fetch = vi.fn(async (_url: string | URL) => Response.json(configured));
			expect(await discoverAuthorizationServerMetadata("https://oauth.test/tenant", { fetch })).toEqual(configured);
			expect(String(fetch.mock.calls[0]?.[0])).toBe(
				"https://oauth.test/.well-known/oauth-authorization-server/tenant",
			);
		});

		it("checks the issuer of the server-origin fallback exactly", async () => {
			const fetch = vi.fn(async (url: string | URL) =>
				new URL(String(url)).pathname.startsWith("/.well-known/oauth-protected-resource")
					? new Response(null, { status: 404 })
					: Response.json(metadata("https://resource.test")),
			);
			const info = await discoverOAuthServerInfo("https://resource.test/mcp", { fetch });
			expect(info.authorizationServerUrl).toBe("https://resource.test");
			expect(info.authorizationServerMetadata?.issuer).toBe("https://resource.test");
		});

		it.each(["https://attacker.test/mcp", "https://resource.test/other"])(
			"refuses protected resource metadata for resource %s before using its authorization servers",
			async (resource) => {
				const fetch = vi.fn(async () =>
					Response.json({ resource, authorization_servers: ["https://attacker.test"] }),
				);
				await expect(
					discoverProtectedResourceMetadata("https://resource.test/mcp", { fetch }),
				).rejects.toBeInstanceOf(OAuthResourceMismatchError);
				fetch.mockClear();
				await expect(discoverOAuthServerInfo("https://resource.test/mcp", { fetch })).rejects.toBeInstanceOf(
					OAuthResourceMismatchError,
				);
				expect(fetch).toHaveBeenCalledOnce();
			},
		);

		it("accepts protected resource metadata for the MCP server", async () => {
			const prm = { resource: "https://resource.test/mcp", authorization_servers: ["https://oauth.test"] };
			const fetch = vi.fn(async () => Response.json(prm));
			expect(await discoverProtectedResourceMetadata("https://resource.test/mcp", { fetch })).toEqual(prm);
		});
	});

	describe("endpoint origin binding (pi#173 review)", () => {
		const tokens = { access_token: "synthetic-token", token_type: "Bearer" };

		/** Provider with a refresh token, so a flow that got this far would POST it to the token endpoint. */
		function refreshingProvider(cached?: AuthorizationServerMetadata) {
			const provider = {
				redirectUrl: clientMetadata.redirect_uris[0]!,
				clientMetadata,
				clientInformation: () => clientInformation,
				tokens: () => ({ access_token: "old", token_type: "Bearer", refresh_token: "synthetic-refresh" }),
				saveTokens: vi.fn(),
				saveCodeVerifier: () => {},
				codeVerifier: () => "synthetic",
				redirectToAuthorization: vi.fn(),
				saveDiscoveryState: vi.fn(),
				discoveryState: () =>
					cached && { authorizationServerUrl: cached.issuer, authorizationServerMetadata: cached },
			} satisfies OAuthClientProvider;
			return provider;
		}

		/** Fetch that routes by host and counts requests per host. */
		function hosts(routes: Record<string, (url: URL) => Response>) {
			const requests: Record<string, string[]> = {};
			const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				requests[url.host] = [...(requests[url.host] ?? []), `${init?.method ?? "GET"} ${url.pathname}`];
				return routes[url.host]?.(url) ?? new Response(null, { status: 404 });
			});
			return { fetch, requests };
		}

		const prm = { resource: "https://resource.test/mcp", authorization_servers: ["https://oauth.test"] };
		// Claims the original issuer, as a hostile redirect target would, but advertises its own endpoints.
		const hostile = { ...metadata("https://attacker.test"), issuer: "https://oauth.test" };

		it.each([
			["protected resource metadata", "resource.test", "https://attacker.test/prm"],
			[
				"authorization server metadata",
				"oauth.test",
				"https://attacker.test/.well-known/oauth-authorization-server",
			],
		])(
			"a discovery 307 for %s to another https host never reaches that host's token endpoint",
			async (_kind, redirecting, location) => {
				const { fetch, requests } = hosts({
					"resource.test": (url) =>
						redirecting === "resource.test"
							? new Response(null, { status: 307, headers: { location } })
							: url.pathname.startsWith("/.well-known/oauth-protected-resource")
								? Response.json(prm)
								: new Response(null, { status: 404 }),
					"oauth.test": () =>
						redirecting === "oauth.test"
							? new Response(null, { status: 307, headers: { location } })
							: Response.json(metadata()),
					"attacker.test": (url) =>
						url.pathname === "/token"
							? Response.json(tokens)
							: url.pathname === "/prm"
								? Response.json({ ...prm, authorization_servers: ["https://attacker.test"] })
								: Response.json(hostile),
				});
				const provider = refreshingProvider();
				await expect(
					authorizeMcp(provider, { serverUrl: "https://resource.test/mcp", fetch }),
				).rejects.toBeInstanceOf(OAuthRedirectRefusedError);
				expect(requests["attacker.test"]).toBeUndefined();
				expect(requests[redirecting]).toHaveLength(1);
				expect(provider.saveTokens).not.toHaveBeenCalled();
				expect(provider.saveDiscoveryState).not.toHaveBeenCalled();
				expect(provider.redirectToAuthorization).not.toHaveBeenCalled();
			},
		);

		it.each(["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"] as const)(
			"refuses metadata with the right issuer but %s on another origin",
			async (field) => {
				const crossOrigin = { ...metadata(), [field]: "https://attacker.test/endpoint" };
				const fetch = vi.fn(async () => Response.json(crossOrigin));
				const error = await discoverAuthorizationServerMetadata("https://oauth.test", { fetch }).catch(
					(caught: unknown) => caught,
				);
				expect(error).toBeInstanceOf(OAuthEndpointOriginError);
				expect((error as OAuthEndpointOriginError).field).toBe(field);
				expect((error as Error).message).toContain("allowedEndpointOrigins");
			},
		);

		it.each(["https://oauth.test:8443", "http://oauth.test", "https://login.oauth.test"])(
			"treats %s as another origin than issuer https://oauth.test",
			async (origin) => {
				const fetch = vi.fn(async () => Response.json({ ...metadata(), token_endpoint: `${origin}/token` }));
				await expect(discoverAuthorizationServerMetadata("https://oauth.test", { fetch })).rejects.toThrow(
					origin.startsWith("http:") ? OAuthInsecureEndpointError : OAuthEndpointOriginError,
				);
			},
		);

		it("a token_endpoint on another origin is refused in the flow before any request to it, and accepted when allowlisted", async () => {
			const crossOrigin = { ...metadata(), token_endpoint: "https://tokens.test/token" };
			const route = () =>
				hosts({
					"resource.test": () => Response.json(prm),
					"oauth.test": () => Response.json(crossOrigin),
					"tokens.test": () => Response.json(tokens),
				});

			const refused = route();
			const provider = refreshingProvider();
			await expect(
				authorizeMcp(provider, { serverUrl: "https://resource.test/mcp", fetch: refused.fetch }),
			).rejects.toBeInstanceOf(OAuthEndpointOriginError);
			expect(refused.requests["tokens.test"]).toBeUndefined();
			expect(provider.saveTokens).not.toHaveBeenCalled();
			expect(provider.saveDiscoveryState).not.toHaveBeenCalled();

			const accepted = route();
			expect(
				await authorizeMcp(provider, {
					serverUrl: "https://resource.test/mcp",
					fetch: accepted.fetch,
					allowedEndpointOrigins: ["https://tokens.test"],
				}),
			).toBe("AUTHORIZED");
			expect(accepted.requests["tokens.test"]).toEqual(["POST /token"]);
			expect(provider.saveTokens).toHaveBeenCalledOnce();
		});

		it("binds cached metadata too", async () => {
			const crossOrigin = { ...metadata(), token_endpoint: "https://tokens.test/token" };
			const { fetch, requests } = hosts({ "tokens.test": () => Response.json(tokens) });
			const provider = refreshingProvider(crossOrigin);
			await expect(authorizeMcp(provider, { serverUrl: "https://resource.test/mcp", fetch })).rejects.toBeInstanceOf(
				OAuthEndpointOriginError,
			);
			expect(requests).toEqual({});
			expect(
				await authorizeMcp(provider, {
					serverUrl: "https://resource.test/mcp",
					fetch,
					allowedEndpointOrigins: ["https://tokens.test/"],
				}),
			).toBe("AUTHORIZED");
			expect(requests).toEqual({ "tokens.test": ["POST /token"] });
		});

		it("binds a configured authorizationServerMetadataUrl document to the issuer it names", async () => {
			// The configured document's issuer is trusted as configured; its endpoints must still share that origin.
			const configured = { ...metadata("https://idp.test"), token_endpoint: "https://tokens.test/token" };
			const { fetch, requests } = hosts({
				"resource.test": () => Response.json(prm),
				"config.test": () => Response.json(configured),
				"tokens.test": () => Response.json(tokens),
			});
			const options = {
				serverUrl: "https://resource.test/mcp",
				authorizationServerMetadataUrl: new URL("https://config.test/metadata.json"),
				fetch,
			};
			await expect(discoverOAuthServerInfo(options.serverUrl, options)).rejects.toBeInstanceOf(
				OAuthEndpointOriginError,
			);
			await expect(authorizeMcp(refreshingProvider(), options)).rejects.toBeInstanceOf(OAuthEndpointOriginError);
			expect(requests["tokens.test"]).toBeUndefined();
			expect(
				await authorizeMcp(refreshingProvider(), { ...options, allowedEndpointOrigins: ["https://tokens.test"] }),
			).toBe("AUTHORIZED");
			expect(requests["tokens.test"]).toEqual(["POST /token"]);
		});

		it("keeps the HTTPS/loopback rule for allowlisted origins and rejects malformed entries", async () => {
			const fetch = vi.fn(async () => Response.json({ ...metadata(), token_endpoint: "http://tokens.test/token" }));
			await expect(
				discoverAuthorizationServerMetadata("https://oauth.test", {
					fetch,
					allowedEndpointOrigins: ["http://tokens.test"],
				}),
			).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
			const valid = vi.fn(async () => Response.json(metadata()));
			await expect(
				discoverAuthorizationServerMetadata("https://oauth.test", {
					fetch: valid,
					allowedEndpointOrigins: ["tokens.test"],
				}),
			).rejects.toBeInstanceOf(TypeError);
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
