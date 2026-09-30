import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { createMcpAuthProvider, McpOAuthCredentialStore, signInMcpServer } from "../src/extensions/mcp/oauth.ts";
import { startOAuthMcpServer } from "./suite/mcp-oauth-server.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// smarty-dev#2241 F22 / Astra4: public sign-in and refresh with independent durable-store owners.
describe("MCP OAuth grant and browser attempt revisions", () => {
	const cleanups: (() => Promise<void> | void)[] = [];
	const releases: (() => void)[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		while (releases.length > 0) releases.pop()?.();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup() {
		const dir = mkdtempSync(join(tmpdir(), "pi-oauth-revision-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		// Distinct backends sharing only real files and proper-lockfile locks, as in two processes.
		const owner = () => new McpOAuthCredentialStore(new FileAuthStorageBackend(join(dir, "auth.json")), dir);
		const first = owner();
		const second = owner();
		const begin = (credentials = first, scope?: string) => {
			const shown = deferred<URL>();
			const cancel = deferred<string | undefined>();
			const pending = signInMcpServer({
				serverUrl: server.url,
				store: credentials.forServer(server.url),
				settings: { scope: "read" },
				challenge: scope ? { error: "insufficient_scope", scope } : undefined,
				prompt: {
					showAuthorizationUrl: shown.resolve,
					promptForRedirectUrl: (signal) => {
						signal.addEventListener("abort", () => cancel.resolve(undefined), { once: true });
						return cancel.promise;
					},
				},
			});
			// Observe rejection immediately; tests join the outcome after releasing their response gates.
			const outcome = pending.then(
				() => undefined,
				(error: unknown) => error,
			);
			cleanups.push(async () => {
				cancel.resolve(undefined);
				await outcome;
			});
			return { shown: shown.promise, pending, outcome };
		};
		const complete = async (attempt: ReturnType<typeof begin>) => {
			await fetch(await attempt.shown);
			await attempt.pending;
		};
		const provider = createMcpAuthProvider({
			serverUrl: server.url,
			store: first.forServer(server.url),
			settings: () => ({}),
			onChallenge: () => {},
		});
		const usable = async () => {
			const token = await provider.token();
			const response = await fetch(server.url, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } }),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ result: { content: [{ text: `token ${token}` }] } });
		};
		return { server, dir, first, second, begin, complete, provider, usable };
	}

	it("keeps B's grant after A's original state-bound callback arrives", async () => {
		const { server, first, second, begin, complete, usable } = await setup();
		const a = begin(first);
		const aUrl = await a.shown;
		// Issue A's original code before B starts, without delivering its callback yet.
		const aRedirect = (await fetch(aUrl, { redirect: "manual" })).headers.get("location");
		expect(aRedirect).toBeTruthy();
		await complete(begin(second));
		const grant = second.tokens(server.url);
		expect(grant?.access_token).toBe("access-1");
		await fetch(aRedirect!);
		expect(await a.outcome).toBeInstanceOf(Error);
		expect(first.tokens(server.url)).toEqual(grant);
		await usable();
	});

	for (const responseKind of ["success", "invalid_grant"] as const) {
		it(`rejects A's late ${responseKind} response after B has committed`, async () => {
			const { server, first, second, begin, complete, usable } = await setup();
			const realFetch = globalThis.fetch;
			const reached = deferred<void>();
			const release = deferred<void>();
			releases.push(() => release.resolve());
			let paused = false;
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				const response = await realFetch(input, init);
				if (new URL(String(input)).pathname === "/token" && !paused) {
					paused = true;
					reached.resolve();
					await release.promise;
					if (responseKind === "invalid_grant") {
						await response.body?.cancel();
						return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
					}
				}
				return response;
			});
			const a = begin(first);
			await realFetch(await a.shown);
			await reached.promise;
			await complete(begin(second));
			const grant = second.tokens(server.url);
			expect(grant?.access_token).toBe("access-2");
			release.resolve();
			const outcome = await a.outcome;
			expect(first.tokens(server.url)).toEqual(grant);
			expect(outcome).toBeInstanceOf(Error);
			await usable();
		});
	}

	for (const responseKind of ["success", "invalid_grant"] as const) {
		it(`keeps an additional-scope grant when the old refresh settles with ${responseKind}`, async () => {
			const { server, first, second, begin, complete, provider, usable } = await setup();
			await complete(begin(first));
			const scope = begin(second, "write");
			const url = await scope.shown;
			expect(url.searchParams.get("scope")).toBe("read write");
			const reached = deferred<void>();
			const release = deferred<void>();
			releases.push(() => release.resolve());
			const oldRefresh = provider.onUnauthorized?.({
				response: new Response(null, { status: 401 }),
				serverUrl: new URL(server.url),
				token: "access-1",
				fetch: async (input, init) => {
					const response = await fetch(input, init);
					if (new URL(String(input)).pathname === "/token") {
						reached.resolve();
						await release.promise;
						if (responseKind === "invalid_grant") {
							await response.body?.cancel();
							return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
						}
					}
					return response;
				},
			});
			const oldOutcome = oldRefresh?.catch((error: unknown) => error);
			await reached.promise;
			try {
				await complete(scope);
				const replacement = second.tokens(server.url);
				expect(replacement?.access_token).toBe("access-3");
				release.resolve();
				await oldOutcome;
				expect(first.tokens(server.url)).toEqual(replacement);
				await usable();
			} finally {
				release.resolve();
				await oldOutcome;
			}
		});
	}

	it("reads the rotated token when ordinary login started during another owner's refresh", async () => {
		const { server, second, begin, complete, provider, usable } = await setup();
		await complete(begin());
		const reached = deferred<void>();
		const release = deferred<void>();
		releases.push(() => release.resolve());
		const refreshing = provider.onUnauthorized?.({
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
		const login = signInMcpServer({
			serverUrl: server.url,
			store: second.forServer(server.url),
			settings: {},
			prompt: {
				showAuthorizationUrl: () => {
					throw new Error("ordinary login must use the rotated refresh token");
				},
				promptForRedirectUrl: async () => undefined,
			},
		});
		release.resolve();
		await refreshing;
		await login;
		expect(second.tokens(server.url)?.access_token).toBe("access-3");
		expect(server.log.filter((entry) => entry === "token refresh")).toHaveLength(2);
		await usable();
	});

	it("retains ordinary DCR, login, rotating refresh, repeated login, and logout fencing", async () => {
		const { server, dir, first, second, begin, complete, provider, usable } = await setup();
		await complete(begin(first));
		expect(server.log).toContain("register");
		await provider.onUnauthorized?.({
			response: new Response(null, { status: 401 }),
			serverUrl: new URL(server.url),
			token: "access-1",
			fetch,
		});
		expect(first.tokens(server.url)?.refresh_token).toBe("refresh-2");
		await usable();
		await signInMcpServer({
			serverUrl: server.url,
			store: second.forServer(server.url),
			settings: {},
			prompt: {
				showAuthorizationUrl: () => {
					throw new Error("ordinary repeated login should refresh");
				},
				promptForRedirectUrl: async () => undefined,
			},
		});
		expect(second.tokens(server.url)?.access_token).toBe("access-3");
		const staleDefault = first.forServer(server.url);
		const stale = staleDefault.forGrant();
		expect(await second.remove(server.url)).toBe(true);
		expect(() =>
			stale.save({ serverUrl: server.url, tokens: { access_token: "stale", token_type: "Bearer" } }),
		).toThrow();
		expect(() =>
			staleDefault.save({ serverUrl: server.url, tokens: { access_token: "stale", token_type: "Bearer" } }),
		).toThrow();
		expect(await provider.token()).toBeUndefined();
		await complete(begin(first));
		await usable();
		expect(readdirSync(dir)).toEqual(["auth.json"]);
	});
});
