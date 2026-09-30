import { afterEach, describe, expect, it } from "vitest";
import {
	authorizeMcp,
	discoverOAuthServerInfo,
	exchangeAuthorizationCode,
	McpOAuthProvider,
	MemoryOAuthStateStore,
	OAuthInsecureEndpointError,
	refreshAuthorization,
	registerClient,
} from "../src/oauth/index.ts";
import { closeServers, listen, readBody } from "./helpers.ts";

afterEach(closeServers);

// smarty-dev#2241 F8: remote discovery must never pass file/native URLs to the application's opener.
describe("OAuth metadata web URL boundary", () => {
	it.each([
		"file:///tmp/oauth",
		"file://localhost/tmp/oauth",
		"ms-settings:privacy",
		"ftp://localhost/oauth",
		"http://remote.example/authorize",
	])("rejects discovered authorization endpoint %s before redirecting", async (endpoint) => {
		const origin = await listen(async (request, response, serverOrigin) => {
			if (request.url === "/.well-known/oauth-authorization-server") {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						issuer: serverOrigin,
						authorization_endpoint: endpoint,
						token_endpoint: `${serverOrigin}/token`,
						response_types_supported: ["code"],
					}),
				);
			} else response.writeHead(404).end();
		});
		const opened: URL[] = [];
		const provider = new McpOAuthProvider({
			serverUrl: `${origin}/mcp`,
			redirectUrl: "http://127.0.0.1/callback",
			clientMetadata: { client_name: "security-test" },
			clientId: "fixture-client",
			onRedirect: (url) => {
				opened.push(url);
			},
		});
		await expect(authorizeMcp(provider, { serverUrl: `${origin}/mcp` })).rejects.toBeInstanceOf(
			OAuthInsecureEndpointError,
		);
		expect(opened).toEqual([]);
	});

	it("revalidates persisted discovery before passing a native URL to the opener", async () => {
		const store = new MemoryOAuthStateStore();
		const serverUrl = "https://resource.example/mcp";
		store.save({
			serverUrl,
			discovery: {
				authorizationServerUrl: "https://issuer.example",
				authorizationServerMetadata: {
					issuer: "https://issuer.example",
					authorization_endpoint: "file:///tmp/oauth",
					token_endpoint: "https://issuer.example/token",
					response_types_supported: ["code"],
				},
			},
		});
		const opened: URL[] = [];
		const provider = new McpOAuthProvider({
			serverUrl,
			redirectUrl: "http://127.0.0.1/callback",
			clientMetadata: { client_name: "security-test" },
			clientId: "fixture-client",
			store,
			onRedirect: (url) => {
				opened.push(url);
			},
		});
		await expect(
			authorizeMcp(provider, {
				serverUrl,
				fetch: async () => {
					throw new Error("unexpected network");
				},
			}),
		).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
		expect(opened).toEqual([]);
	});

	it("rejects nonweb authorization-server selection instead of silently falling back", async () => {
		const origin = await listen(async (_request, response, serverOrigin) => {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({ resource: `${serverOrigin}/mcp`, authorization_servers: ["file:///tmp/issuer"] }),
			);
		});
		await expect(discoverOAuthServerInfo(`${origin}/mcp`)).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
	});

	it("rejects a nonweb resource-metadata challenge before fetching it", async () => {
		let fetched = false;
		await expect(
			discoverOAuthServerInfo("https://resource.example/mcp", {
				resourceMetadataUrl: new URL("file:///tmp/metadata"),
				fetch: async () => {
					fetched = true;
					throw new Error("unexpected network");
				},
			}),
		).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
		expect(fetched).toBe(false);
	});

	it.each([
		"https://issuer.example/authorize",
		"http://localhost:3210/authorize",
		"http://127.0.0.1:3210/authorize",
		"http://[::1]:3210/authorize",
	])("keeps discovered HTTPS and explicit loopback HTTP authorization endpoint %s working", async (endpoint) => {
		const origin = await listen(async (request, response, serverOrigin) => {
			if (request.url === "/.well-known/oauth-authorization-server") {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						issuer: serverOrigin,
						authorization_endpoint: endpoint,
						token_endpoint: `${serverOrigin}/token`,
						response_types_supported: ["code"],
						code_challenge_methods_supported: ["S256"],
					}),
				);
			} else response.writeHead(404).end();
		});
		const opened: URL[] = [];
		const provider = new McpOAuthProvider({
			serverUrl: `${origin}/mcp`,
			redirectUrl: "http://127.0.0.1/callback",
			clientMetadata: { client_name: "security-test" },
			clientId: "fixture-client",
			onRedirect: (url) => {
				opened.push(url);
			},
		});
		expect(await authorizeMcp(provider, { serverUrl: `${origin}/mcp` })).toBe("REDIRECT");
		expect(opened).toHaveLength(1);
		expect(opened[0].origin).toBe(new URL(endpoint).origin);
		expect(opened[0].searchParams.get("code_challenge_method")).toBe("S256");
		expect(opened[0].searchParams.get("state")).toBe(await provider.state());
	});

	it("enforces the same boundary for token and registration endpoints, including loopback native schemes", async () => {
		const metadata = {
			issuer: "https://issuer.example",
			authorization_endpoint: "https://issuer.example/authorize",
			token_endpoint: "file://localhost/tmp/token",
			registration_endpoint: "ftp://localhost/register",
			response_types_supported: ["code"],
		};
		let fetched = false;
		const fetch = async () => {
			fetched = true;
			throw new Error("unexpected network");
		};
		await expect(
			refreshAuthorization(metadata.issuer, {
				metadata,
				clientInformation: { client_id: "fixture-client" },
				refreshToken: "fixture-refresh",
				fetch,
			}),
		).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
		await expect(
			registerClient(metadata.issuer, {
				metadata,
				clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"] },
				fetch,
			}),
		).rejects.toBeInstanceOf(OAuthInsecureEndpointError);
		expect(fetched).toBe(false);
	});
});

// smarty-dev#2241 Astra A1: exchange/refresh POST bodies must not follow 307/308 redirects.
describe("OAuth token POST redirect policy", () => {
	it.each([307, 308])("rejects %i without delivering grant credentials to a second local origin", async (status) => {
		const received: string[] = [];
		const collector = await listen(async (request, response) => {
			received.push(await readBody(request));
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ access_token: "redirected", token_type: "Bearer" }));
		});
		const intended: URLSearchParams[] = [];
		const issuer = await listen(async (request, response) => {
			intended.push(new URLSearchParams(await readBody(request)));
			response.writeHead(status, { location: `${collector}/collect` }).end();
		});
		const options = {
			metadata: {
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				response_types_supported: ["code"],
				token_endpoint_auth_methods_supported: ["client_secret_post"],
			},
			clientInformation: { client_id: "fixture-client", client_secret: "fixture-secret" },
		};
		await expect(
			exchangeAuthorizationCode(issuer, {
				...options,
				code: "fixture-code",
				codeVerifier: "fixture-verifier",
				redirectUrl: "http://127.0.0.1/callback",
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
		await expect(refreshAuthorization(issuer, { ...options, refreshToken: "fixture-refresh" })).rejects.toMatchObject(
			{ code: "invalid_request" },
		);
		expect(intended).toHaveLength(2);
		expect(intended[0].get("code")).toBe("fixture-code");
		expect(intended[0].get("code_verifier")).toBe("fixture-verifier");
		expect(intended[1].get("refresh_token")).toBe("fixture-refresh");
		for (const params of intended) expect(params.get("client_secret")).toBe("fixture-secret");
		expect(received).toEqual([]);
	});

	it("preserves nonredirecting local code exchange and refresh with client_secret_post", async () => {
		const received: URLSearchParams[] = [];
		const issuer = await listen(async (request, response) => {
			received.push(new URLSearchParams(await readBody(request)));
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ access_token: "fixture-access", token_type: "Bearer" }));
		});
		const options = {
			metadata: {
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				response_types_supported: ["code"],
				token_endpoint_auth_methods_supported: ["client_secret_post"],
			},
			clientInformation: { client_id: "fixture-client", client_secret: "fixture-secret" },
		};
		const exchanged = await exchangeAuthorizationCode(issuer, {
			...options,
			code: "fixture-code",
			codeVerifier: "fixture-verifier",
			redirectUrl: "http://127.0.0.1/callback",
		});
		expect(exchanged.access_token).toBe("fixture-access");
		const refreshed = await refreshAuthorization(issuer, { ...options, refreshToken: "fixture-refresh" });
		expect(refreshed.access_token).toBe("fixture-access");
		expect(refreshed.refresh_token).toBe("fixture-refresh");
		expect(received.map((params) => params.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
		for (const params of received) expect(params.get("client_secret")).toBe("fixture-secret");
	});
});
