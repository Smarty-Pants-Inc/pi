import { afterEach, describe, expect, it } from "vitest";
import {
	adaptOAuthProvider,
	authorizeMcp,
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
	exchangeAuthorizationCode,
	McpOAuthProvider,
	OAuthError,
	OAuthRegistrationError,
	refreshAuthorization,
	registerClient,
} from "../src/oauth/index.ts";
import { closeServers, listen } from "./helpers.ts";

const CAP = 1024 * 1024;
const clientInformation = { client_id: "fixture-client" };
const clientMetadata = { redirect_uris: ["http://127.0.0.1/callback"] };
const tokenOptions = { clientInformation, refreshToken: "fixture-refresh" };
afterEach(closeServers);

// smarty-dev#2241 round2: exercise public entry points against real loopback HTTP, not mocked JSON readers.
describe("OAuth response byte and network bounds", () => {
	it.each(["finite", "chunked", "multibyte"])(
		"rejects oversized %s metadata, tokens and registrations",
		async (mode) => {
			const padding = mode === "multibyte" ? "é".repeat(CAP / 2) : "x".repeat(CAP);
			const origin = await listen(async (request, response, base) => {
				const value = request.url?.includes("well-known")
					? { resource: `${base}/mcp`, padding }
					: request.url === "/register"
						? { client_id: "fixture", padding }
						: { access_token: "fixture", token_type: "Bearer", padding };
				const body = JSON.stringify(value);
				if (mode === "finite") response.setHeader("content-length", Buffer.byteLength(body));
				if (mode === "chunked") {
					response.write(body.slice(0, 200));
					response.end(body.slice(200));
				} else response.end(body);
			});
			await expect(discoverProtectedResourceMetadata(`${origin}/mcp`)).rejects.toMatchObject({
				name: "OAuthResponseLimitError",
			});
			await expect(refreshAuthorization(origin, tokenOptions)).rejects.toMatchObject({
				name: "OAuthResponseLimitError",
			});
			await expect(registerClient(origin, { clientMetadata })).rejects.toMatchObject({
				name: "OAuthResponseLimitError",
			});
		},
	);

	it("enforces the authorization-server cap and accepts an exact-cap multibyte body split inside UTF-8", async () => {
		let oversized = true;
		const origin = await listen(async (_request, response, base) => {
			const metadata = {
				issuer: base,
				authorization_endpoint: `${base}/authorize`,
				token_endpoint: `${base}/token`,
				response_types_supported: ["code"],
				padding: "",
			};
			const overhead = Buffer.byteLength(JSON.stringify(metadata));
			metadata.padding =
				"é".repeat(Math.floor((CAP - overhead) / 2)) + "x".repeat(((CAP - overhead) % 2) + (oversized ? 1 : 0));
			const bytes = Buffer.from(JSON.stringify(metadata));
			expect(bytes.byteLength).toBe(CAP + (oversized ? 1 : 0));
			const firstMultibyte = bytes.indexOf(0xc3);
			response.write(bytes.subarray(0, firstMultibyte + 1));
			response.end(bytes.subarray(firstMultibyte + 1));
		});
		await expect(discoverAuthorizationServerMetadata(origin)).rejects.toMatchObject({
			name: "OAuthResponseLimitError",
		});
		oversized = false;
		const metadata = await discoverAuthorizationServerMetadata(origin);
		expect(metadata?.issuer).toBe(origin);
		expect((metadata?.padding as string).startsWith("éé")).toBe(true);
	});

	it("rejects oversized errors with a bounded diagnostic prefix and retires an endless stream", async () => {
		let closed = 0;
		const origin = await listen(async (_request, response) => {
			response.on("close", () => closed++);
			response.writeHead(500);
			response.write(`diagnostic:${"x".repeat(CAP + 100)}`);
		});
		for (const operation of [
			() => refreshAuthorization(origin, tokenOptions),
			() => registerClient(origin, { clientMetadata }),
		]) {
			const error: unknown = await operation().catch((failure: unknown) => failure);
			expect(error).toMatchObject({ name: "OAuthResponseLimitError" });
			const prefix = (error as { body: string }).body;
			expect(prefix.startsWith("diagnostic:")).toBe(true);
			expect(Buffer.byteLength(prefix)).toBeLessThanOrEqual(4096);
		}
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(closed).toBe(2);
	});

	it.each(["headers", "body"])(
		"bounds never-finishing %s across direct exports and permits later controls",
		async (phase) => {
			let closed = 0;
			const origin = await listen(async (request, response, base) => {
				if (request.url?.includes("control")) {
					response.end(JSON.stringify({ resource: `${base}/mcp` }));
					return;
				}
				response.on("close", () => closed++);
				if (phase === "body") {
					response.writeHead(200);
					response.write("{");
				}
			});
			const options = { networkTimeoutMs: 80 };
			for (const operation of [
				() => discoverProtectedResourceMetadata(`${origin}/mcp`, options),
				() => discoverAuthorizationServerMetadata(origin, options),
				() => discoverOAuthServerInfo(`${origin}/mcp`, options),
				() => refreshAuthorization(origin, { ...tokenOptions, ...options }),
				() =>
					exchangeAuthorizationCode(origin, {
						...options,
						clientInformation,
						code: "fixture-code",
						codeVerifier: "fixture-verifier",
						redirectUrl: "http://127.0.0.1/callback",
					}),
				() => registerClient(origin, { ...options, clientMetadata }),
			]) {
				const start = Date.now();
				await expect(operation()).rejects.toMatchObject({ name: "OAuthNetworkError" });
				expect(Date.now() - start).toBeLessThan(1000);
			}
			expect(
				await discoverProtectedResourceMetadata(`${origin}/mcp`, {
					resourceMetadataUrl: `${origin}/control`,
					...options,
				}),
			).toEqual({ resource: `${origin}/mcp` });
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(closed).toBe(6);
		},
	);

	it("cancels caller requests before headers and during body reads", async () => {
		const origin = await listen(async (request, response) => {
			if (request.url === "/register") {
				response.writeHead(200);
				response.write("{");
			}
		});
		for (const operation of [
			(signal: AbortSignal) => refreshAuthorization(origin, { ...tokenOptions, signal }),
			(signal: AbortSignal) => registerClient(origin, { clientMetadata, signal }),
		]) {
			const controller = new AbortController();
			const pending = operation(controller.signal);
			const timer = setTimeout(() => controller.abort(), 30);
			try {
				await expect(pending).rejects.toMatchObject({ name: "OAuthNetworkError" });
			} finally {
				clearTimeout(timer);
			}
		}
	});

	it("shares one deadline across discovery misses and cancels discarded bodies without draining", async () => {
		let calls = 0;
		let closed = 0;
		const origin = await listen(async (_request, response) => {
			calls++;
			response.on("close", () => closed++);
			await new Promise((resolve) => setTimeout(resolve, 60));
			response.writeHead(404);
			response.write("x".repeat(CAP * 2));
		});
		const options = { networkTimeoutMs: 100 };
		await expect(discoverAuthorizationServerMetadata(`${origin}/tenant`, options)).rejects.toMatchObject({
			name: "OAuthNetworkError",
		});
		expect(calls).toBe(2);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(closed).toBe(2);
	});

	it("does not swallow limits or deadlines in authorize/adapt refresh and releases shared refresh for a later operation", async () => {
		let bad = true;
		let redirects = 0;
		const origin = await listen(async (_request, response) => {
			if (bad) {
				response.writeHead(200);
				response.write("{");
			} else
				response.end(
					JSON.stringify({ access_token: "fixture-new", refresh_token: "fixture-rotated", token_type: "Bearer" }),
				);
		});
		const provider = new McpOAuthProvider({
			serverUrl: `${origin}/mcp`,
			redirectUrl: clientMetadata.redirect_uris[0],
			clientMetadata,
			clientId: "fixture-client",
			onRedirect: () => {
				redirects++;
			},
		});
		await provider.saveDiscoveryState({
			authorizationServerUrl: origin,
			authorizationServerMetadata: {
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				response_types_supported: ["code"],
			},
		});
		await provider.saveTokens({
			access_token: "fixture-old",
			refresh_token: "fixture-refresh",
			token_type: "Bearer",
		});
		const options = { networkTimeoutMs: 80 };
		await expect(authorizeMcp(provider, { serverUrl: `${origin}/mcp`, ...options })).rejects.toMatchObject({
			name: "OAuthNetworkError",
		});
		const auth = adaptOAuthProvider(provider, options);
		const context = {
			response: new Response(null, { status: 401 }),
			serverUrl: new URL(`${origin}/mcp`),
			fetch,
			token: "fixture-old",
		};
		await expect(auth.onUnauthorized?.(context)).rejects.toMatchObject({ name: "OAuthNetworkError" });
		bad = false;
		await auth.onUnauthorized?.(context);
		expect(await auth.token()).toBe("fixture-new");
		expect((await provider.tokens())?.refresh_token).toBe("fixture-rotated");
		expect(redirects).toBe(0);
	});

	it("does not turn oversized protected-resource discovery or refresh into a browser redirect", async () => {
		const origin = await listen(async (_request, response, base) => {
			response.end(
				JSON.stringify({
					resource: `${base}/mcp`,
					access_token: "fixture",
					token_type: "Bearer",
					padding: "x".repeat(CAP),
				}),
			);
		});
		let redirects = 0;
		const provider = new McpOAuthProvider({
			serverUrl: `${origin}/mcp`,
			redirectUrl: clientMetadata.redirect_uris[0],
			clientMetadata,
			clientId: "fixture-client",
			onRedirect: () => {
				redirects++;
			},
		});
		await expect(authorizeMcp(provider, { serverUrl: `${origin}/mcp` })).rejects.toMatchObject({
			name: "OAuthResponseLimitError",
		});
		await provider.saveDiscoveryState({
			authorizationServerUrl: origin,
			authorizationServerMetadata: {
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				response_types_supported: ["code"],
			},
		});
		await provider.saveTokens({
			access_token: "fixture-old",
			refresh_token: "fixture-refresh",
			token_type: "Bearer",
		});
		await expect(authorizeMcp(provider, { serverUrl: `${origin}/mcp` })).rejects.toMatchObject({
			name: "OAuthResponseLimitError",
		});
		expect(redirects).toBe(0);
	});

	it("combines provider/attempt cancellation with caller cancellation in authorize and adapt", async () => {
		const origin = await listen(async (_request, response) => {
			response.writeHead(200);
			response.write("{");
		});
		for (const viaAdapt of [false, true]) {
			const owner = new AbortController();
			const caller = new AbortController();
			const provider = Object.assign(
				new McpOAuthProvider({
					serverUrl: `${origin}/mcp`,
					redirectUrl: clientMetadata.redirect_uris[0],
					clientMetadata,
					clientId: "fixture-client",
					onRedirect: () => {
						throw new Error("unexpected redirect");
					},
				}),
				{ signal: owner.signal },
			);
			await provider.saveDiscoveryState({
				authorizationServerUrl: origin,
				authorizationServerMetadata: {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
				},
			});
			await provider.saveTokens({
				access_token: "fixture-old",
				refresh_token: "fixture-refresh",
				token_type: "Bearer",
			});
			const options = { signal: caller.signal };
			const pending = viaAdapt
				? adaptOAuthProvider(provider, options).onUnauthorized?.({
						response: new Response(null, { status: 401 }),
						serverUrl: new URL(`${origin}/mcp`),
						fetch,
						token: "fixture-old",
					})
				: authorizeMcp(provider, { ...options, serverUrl: `${origin}/mcp` });
			const timer = setTimeout(() => owner.abort(), 30);
			try {
				await expect(pending).rejects.toMatchObject({ name: "OAuthNetworkError" });
			} finally {
				clearTimeout(timer);
			}
		}
	});

	it("retires redirect bodies without waiting for their end and preserves the grant redirect fence", async () => {
		let closed = false;
		const origin = await listen(async (_request, response) => {
			response.on("close", () => {
				closed = true;
			});
			response.writeHead(307, { location: "/collector" });
			response.write("x");
		});
		await expect(refreshAuthorization(origin, { ...tokenOptions, networkTimeoutMs: 100 })).rejects.toMatchObject({
			code: "invalid_request",
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(closed).toBe(true);
	});

	it("bounds injected noncooperative reads/cancellation and removes caller abort listeners", async () => {
		const controller = new AbortController();
		let cancelled = 0;
		let activeListeners = 0;
		const add = controller.signal.addEventListener.bind(controller.signal);
		const remove = controller.signal.removeEventListener.bind(controller.signal);
		controller.signal.addEventListener = (...args: Parameters<AbortSignal["addEventListener"]>) => {
			activeListeners++;
			add(...args);
		};
		controller.signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => {
			activeListeners--;
			remove(...args);
		};
		const body = new ReadableStream<Uint8Array>({
			cancel: () => {
				cancelled++;
				return new Promise<void>(() => {});
			},
		});
		await expect(
			refreshAuthorization("http://127.0.0.1", {
				...tokenOptions,
				signal: controller.signal,
				networkTimeoutMs: 30,
				fetch: async () => new Response(body),
			}),
		).rejects.toMatchObject({ name: "OAuthNetworkError" });
		expect(cancelled).toBe(1);
		expect(body.locked).toBe(false);
		expect(activeListeners).toBe(0);
	});

	it("does not apply the network deadline to a provider waiting for browser interaction", async () => {
		const origin = await listen(async (_request, response) => {
			response.writeHead(404).end();
		});
		const provider = new McpOAuthProvider({
			serverUrl: `${origin}/mcp`,
			redirectUrl: clientMetadata.redirect_uris[0],
			clientMetadata,
			clientId: "fixture-client",
			onRedirect: async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
			},
		});
		expect(await authorizeMcp(provider, { serverUrl: `${origin}/mcp`, networkTimeoutMs: 80 })).toBe("REDIRECT");
	});

	it("preserves invalid-client registration retry after a bounded normal OAuth error", async () => {
		let tokens = 0;
		let registrations = 0;
		const origin = await listen(async (request, response, base) => {
			if (request.url === "/register") {
				registrations++;
				response.end(JSON.stringify({ client_id: "fixture-retry" }));
			} else if (request.url === "/token") {
				tokens++;
				response.end(JSON.stringify({ error: "invalid_client" }));
			} else if (request.url?.includes("oauth-authorization-server"))
				response.end(
					JSON.stringify({
						issuer: base,
						authorization_endpoint: `${base}/authorize`,
						token_endpoint: `${base}/token`,
						registration_endpoint: `${base}/register`,
						response_types_supported: ["code"],
					}),
				);
			else response.writeHead(404).end();
		});
		const provider = new McpOAuthProvider({
			serverUrl: `${origin}/mcp`,
			redirectUrl: clientMetadata.redirect_uris[0],
			clientMetadata,
			onRedirect: () => {},
		});
		await provider.saveClientInformation({ client_id: "fixture-old" });
		await provider.saveTokens({
			access_token: "fixture-old",
			refresh_token: "fixture-refresh",
			token_type: "Bearer",
		});
		expect(await authorizeMcp(provider, { serverUrl: `${origin}/mcp` })).toBe("REDIRECT");
		expect(tokens).toBe(1);
		expect(registrations).toBe(1);
		expect((await provider.clientInformation())?.client_id).toBe("fixture-retry");
	});

	it("keeps normal discovery misses, typed OAuth errors, registration errors and successful controls", async () => {
		let mode = "success";
		const origin = await listen(async (request, response) => {
			if (request.url?.includes("well-known")) {
				response.writeHead(404).end();
				return;
			}
			if (mode === "oauth-error") {
				response.end(JSON.stringify({ error: "invalid_grant", error_description: "fixture-denial" }));
				return;
			}
			if (mode === "http-error") {
				response.writeHead(500).end("x".repeat(9000));
				return;
			}
			response.end(
				JSON.stringify(
					request.url === "/register"
						? { client_id: "fixture-client", redirect_uris: clientMetadata.redirect_uris }
						: { access_token: "fixture-access", token_type: "Bearer" },
				),
			);
		});
		expect(await discoverAuthorizationServerMetadata(`${origin}/tenant`)).toBeUndefined();
		expect((await refreshAuthorization(origin, tokenOptions)).refresh_token).toBe("fixture-refresh");
		expect((await registerClient(origin, { clientMetadata })).client_id).toBe("fixture-client");
		mode = "oauth-error";
		await expect(refreshAuthorization(origin, tokenOptions)).rejects.toBeInstanceOf(OAuthError);
		await expect(refreshAuthorization(origin, tokenOptions)).rejects.toMatchObject({
			code: "invalid_grant",
			message: "fixture-denial",
		});
		mode = "http-error";
		const error = await registerClient(origin, { clientMetadata }).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(OAuthRegistrationError);
		expect(Buffer.byteLength((error as OAuthRegistrationError).body)).toBe(4096);
	});
});
