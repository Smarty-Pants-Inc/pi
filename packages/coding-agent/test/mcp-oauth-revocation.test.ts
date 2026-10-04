import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { createMcpAuthProvider, McpOAuthCredentialStore, signInMcpServer } from "../src/extensions/mcp/oauth.ts";
import { startOAuthMcpServer } from "./suite/mcp-oauth-server.ts";

describe("MCP OAuth logout publication boundary", () => {
	// smarty-dev#3535 / pi#137 A12: logout must invalidate remote work already in flight.
	it.each(["refresh", "sign-in"] as const)("rejects delayed %s publication after successful logout", async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-revoke-"));
		const server = await startOAuthMcpServer();
		const nativeFetch = globalThis.fetch;
		const open = () => new McpOAuthCredentialStore(new FileAuthStorageBackend(join(root, "mcp-auth.json")), root);
		const browser = {
			showAuthorizationUrl: (url: URL) => {
				void nativeFetch(url);
			},
			promptForRedirectUrl: (signal: AbortSignal) =>
				new Promise<undefined>((resolve) =>
					signal.addEventListener("abort", () => resolve(undefined), { once: true }),
				),
		};
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let received!: () => void;
		const responseReady = new Promise<void>((resolve) => {
			received = resolve;
		});
		let work: Promise<unknown> | undefined;
		try {
			await signInMcpServer({
				serverUrl: server.url,
				store: open().forServer("test", server.url),
				settings: {},
				prompt: browser,
			});
			const delayedFetch: typeof globalThis.fetch = async (input, init) => {
				const response = await nativeFetch(input, init);
				if (String(input).endsWith("/token")) {
					received();
					await gate;
				}
				return response;
			};
			if (mode === "refresh") {
				server.expireAccessTokens();
				const provider = createMcpAuthProvider({
					serverUrl: server.url,
					store: open().forServer("test", server.url),
					settings: () => ({}),
					onChallenge: () => {},
				});
				work = provider.onUnauthorized!({
					response: new Response(null, { status: 401 }),
					serverUrl: new URL(server.url),
					fetch: delayedFetch,
					token: "access-1",
				});
			} else {
				vi.spyOn(globalThis, "fetch").mockImplementation(delayedFetch);
				work = signInMcpServer({
					serverUrl: server.url,
					store: open().forServer("test", server.url),
					settings: {},
					challenge: { error: "insufficient_scope", scope: "extra" },
					prompt: browser,
				});
			}
			work = work.then(
				() => undefined,
				(error: unknown) => error,
			);
			await responseReady;
			const logout = open();
			expect(logout.remove("test", server.url)).toBe(true);
			expect(await open().forServer("test", server.url).load()).toBeUndefined();
			// The response is released only after an independently opened store reports logout success.
			release();
			const result = await work;
			expect(logout.tokens("test", server.url)).toBeUndefined();
			expect(await open().forServer("test", server.url).load()).toBeUndefined();
			expect(result).toBeInstanceOf(Error);
			vi.restoreAllMocks();
			// A new explicit login may publish using the new generation.
			await signInMcpServer({
				serverUrl: server.url,
				store: open().forServer("test", server.url),
				settings: {},
				prompt: browser,
			});
			expect(open().tokens("test", server.url)?.access_token).toBeTruthy();
		} finally {
			release();
			await work;
			vi.restoreAllMocks();
			await server.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
