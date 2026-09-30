import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import { createMcpAuthProvider, McpOAuthCredentialStore, signInMcpServer } from "../src/extensions/mcp/oauth.ts";
import { startOAuthMcpServer } from "./suite/mcp-oauth-server.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// smarty-dev#2241 F6: real sign-in/refresh and the CLI logout share a durable file and per-server lock.
describe("MCP OAuth logout grant fencing", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup() {
		const dir = mkdtempSync(join(tmpdir(), "pi-security-oauth-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { issues: { url: server.url } } }));
		const credentials = () =>
			new McpOAuthCredentialStore(new FileAuthStorageBackend(join(dir, "mcp-auth.json")), dir);
		const login = (store: McpOAuthCredentialStore) =>
			signInMcpServer({
				serverUrl: server.url,
				store: store.forServer(server.url),
				settings: {},
				prompt: {
					showAuthorizationUrl: (url) => void fetch(url),
					promptForRedirectUrl: (signal) =>
						new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
				},
			});
		const logout = (store: McpOAuthCredentialStore, log: (line: string) => void = () => {}) =>
			runMcpCommand(["logout", "issues"], { cwd: dir, agentDir: dir, credentials: store, log });
		return { server, credentials, login, logout };
	}

	it("does not report logout success before a cross-process refresh is deleted", async () => {
		const { server, credentials, login, logout } = await setup();
		const first = credentials();
		const second = credentials();
		await login(first);
		const reached = deferred();
		const release = deferred();
		const provider = createMcpAuthProvider({
			serverUrl: server.url,
			store: first.forServer(server.url),
			settings: () => ({}),
			onChallenge: () => {},
		});
		const refresh = provider.onUnauthorized?.({
			response: new Response(null, { status: 401 }),
			serverUrl: new URL(server.url),
			token: "access-1",
			fetch: async (input, init) => {
				const response = await fetch(input, init);
				if (new URL(String(input)).pathname === "/token") {
					reached.resolve();
					await release.promise;
				}
				return response;
			},
		});
		await reached.promise;
		let reported = false;
		const deletion = logout(second, () => {
			reported = true;
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(reported).toBe(false);
		} finally {
			release.resolve();
		}
		await refresh;
		expect(await deletion).toBe(0);
		expect(reported).toBe(true);
		expect(await provider.token()).toBeUndefined();
		expect(await second.forServer(server.url).load()).toBeUndefined();
	});

	it("serializes logout with sign-in that is awaiting a refresh response", async () => {
		const { server, credentials, login, logout } = await setup();
		const first = credentials();
		const second = credentials();
		await login(first);
		const realFetch = globalThis.fetch;
		const reached = deferred();
		const release = deferred();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const response = await realFetch(input, init);
			if (new URL(String(input)).pathname === "/token") {
				reached.resolve();
				await release.promise;
			}
			return response;
		});
		const pending = login(first);
		await reached.promise;
		let reported = false;
		const deletion = logout(second, () => {
			reported = true;
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(reported).toBe(false);
		} finally {
			release.resolve();
		}
		await pending;
		expect(await deletion).toBe(0);
		expect(first.tokens(server.url)).toBeUndefined();
		expect(server.log.filter((entry) => entry === "token refresh")).toHaveLength(1);
	});

	it("rejects a code exchange arriving after successful logout, but permits a new login", async () => {
		const { server, credentials, login, logout } = await setup();
		const first = credentials();
		const second = credentials();
		const realFetch = globalThis.fetch;
		const reached = deferred();
		const release = deferred();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const response = await realFetch(input, init);
			if (new URL(String(input)).pathname === "/token") {
				reached.resolve();
				await release.promise;
			}
			return response;
		});
		const pending = login(first);
		const rejected = expect(pending).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
		await reached.promise;
		try {
			expect(await logout(second)).toBe(0);
			expect(await second.forServer(server.url).load()).toBeUndefined();
		} finally {
			release.resolve();
		}
		await rejected;
		expect(first.tokens(server.url)).toBeUndefined();
		vi.restoreAllMocks();
		await login(first);
		expect(first.tokens(server.url)?.access_token).toBe("access-2");
	});

	it("invalidates an empty grant and keeps a revoked view fenced across a later login", async () => {
		const { server, credentials, login } = await setup();
		const first = credentials();
		const second = credentials();
		const stale = first.forServer(server.url).forGrant();
		expect(await second.remove(server.url)).toBe(false);
		await login(second);
		expect(() =>
			stale.save({ serverUrl: server.url, tokens: { access_token: "stale", token_type: "Bearer" } }),
		).toThrow(McpOAuthAuthorizationRequiredError);
		expect(second.tokens(server.url)?.access_token).toBe("access-1");
	});

	it("keeps ordinary login, rotated refresh, logout, and subsequent login working", async () => {
		const { server, credentials, login, logout } = await setup();
		const store = credentials();
		await login(store);
		const provider = createMcpAuthProvider({
			serverUrl: server.url,
			store: store.forServer(server.url),
			settings: () => ({}),
			onChallenge: () => {},
		});
		await provider.onUnauthorized?.({
			response: new Response(null, { status: 401 }),
			serverUrl: new URL(server.url),
			token: "access-1",
			fetch,
		});
		expect(await provider.token()).toBe("access-2");
		expect(store.tokens(server.url)?.refresh_token).toBe("refresh-2");
		expect(await logout(store)).toBe(0);
		expect(await provider.token()).toBeUndefined();
		await login(store);
		expect(await provider.token()).toBe("access-3");
	});
});
