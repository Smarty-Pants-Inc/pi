import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createConnection, createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OAuthNetworkError, OAuthResponseLimitError } from "@earendil-works/pi-mcp/oauth";
import { afterEach, describe, expect, it } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { McpOAuthCredentialStore, type McpSignInPrompt, signInMcpServer } from "../src/extensions/mcp/oauth.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// smarty-dev#2241 F21/F25: exercise actual signInMcpServer callback and on-disk refresh-lock ownership.
describe("MCP sign-in network failure retires owned resources", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});

	async function setup() {
		const dir = mkdtempSync(join(tmpdir(), "pi-oauth-lifecycle-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const reservation = createTcpServer();
		reservation.listen(0, "127.0.0.1");
		await once(reservation, "listening");
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("no callback TCP address");
		const callbackPort = address.port;
		await new Promise<void>((resolve) => reservation.close(() => resolve()));
		let origin = "";
		let mode: "normal" | "metadata-cap" | "refresh-cap" | "metadata-stall" | "metadata-headers-stall" = "normal";
		const requests: string[] = [];
		let issued = 0;
		const challenges = new Map<string, string>();
		const grants: string[] = [];
		const reached = deferred<{ response: ServerResponse; spare: Socket; closed: Promise<unknown[]> }>();
		const server = createServer((request, response) => {
			void (async () => {
				const url = new URL(request.url ?? "/", origin);
				requests.push(url.pathname);
				if (
					(mode.startsWith("metadata-") && url.pathname === "/.well-known/oauth-protected-resource/mcp") ||
					(mode === "refresh-cap" && url.pathname === "/token")
				) {
					// A real accepted preconnection must be retired by signIn's callback finally, not this fixture.
					const spare = createConnection({ host: "127.0.0.1", port: callbackPort });
					cleanups.push(() => {
						spare.destroy();
					});
					await once(spare, "connect");
					const closed = once(spare, "close");
					if (mode !== "metadata-headers-stall") {
						response.writeHead(200, { "content-type": "application/json" });
						if (mode === "metadata-stall") response.write(" ");
					}
					reached.resolve({ response, spare, closed });
					return;
				}
				const json = (value: unknown, status = 200) =>
					response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
				switch (url.pathname) {
					case "/.well-known/oauth-protected-resource/mcp":
						return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
					case "/.well-known/oauth-authorization-server":
						return json({
							issuer: origin,
							authorization_endpoint: `${origin}/authorize`,
							token_endpoint: `${origin}/token`,
							registration_endpoint: `${origin}/register`,
							response_types_supported: ["code"],
							code_challenge_methods_supported: ["S256"],
						});
					case "/register": {
						let body = "";
						for await (const chunk of request) body += chunk.toString();
						return json({ ...JSON.parse(body), client_id: "fake-client" }, 201);
					}
					case "/authorize": {
						const code = `code-${issued + 1}`;
						challenges.set(code, url.searchParams.get("code_challenge") ?? "");
						const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
						redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
						redirect.searchParams.set("code", code);
						response.writeHead(302, { location: redirect.href }).end();
						return;
					}
					case "/token": {
						let body = "";
						for await (const chunk of request) body += chunk.toString();
						const params = new URLSearchParams(body);
						const grant = params.get("grant_type") ?? "";
						grants.push(grant);
						if (grant === "authorization_code") {
							const code = params.get("code") ?? "";
							const challenge = createHash("sha256")
								.update(params.get("code_verifier") ?? "")
								.digest("base64url");
							if (!challenges.has(code) || challenges.get(code) !== challenge)
								return json({ error: "invalid_grant" }, 400);
							challenges.delete(code);
						}
						issued++;
						return json({
							access_token: `access-${issued}`,
							refresh_token: `refresh-${issued}`,
							token_type: "Bearer",
						});
					}
					default:
						response.writeHead(404).end();
				}
			})().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const serverAddress = server.address();
		if (!serverAddress || typeof serverAddress === "string") throw new Error("no OAuth TCP address");
		origin = `http://127.0.0.1:${serverAddress.port}`;
		cleanups.push(
			() =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		);
		const serverUrl = `${origin}/mcp`;
		// Separate file-backend/store instances exercise the actual proper-lockfile path.
		const credentials = () => new McpOAuthCredentialStore(new FileAuthStorageBackend(join(dir, "auth.json")), dir);
		const browserResponses: Promise<number>[] = [];
		const login = (signal?: AbortSignal, controls?: { networkTimeoutMs?: number; prompt?: McpSignInPrompt }) => {
			const options = {
				serverUrl,
				store: credentials().forServer(serverUrl),
				settings: { callbackPort },
				signal,
				networkTimeoutMs: controls?.networkTimeoutMs,
				prompt: controls?.prompt ?? {
					showAuthorizationUrl: (url: URL) => {
						browserResponses.push(fetch(url).then((response) => response.status));
					},
					promptForRedirectUrl: (promptSignal: AbortSignal) =>
						new Promise<string | undefined>((resolve) => {
							promptSignal.addEventListener("abort", () => resolve(undefined), { once: true });
						}),
				},
			};
			return signInMcpServer(options);
		};
		return {
			dir,
			serverUrl,
			credentials,
			login,
			grants,
			requests,
			browserResponses,
			callbackPort,
			origin,
			reached,
			setMode: (next: typeof mode) => {
				mode = next;
			},
		};
	}

	// smarty-dev#2241: cancellation controls must work through the public sign-in entry point.
	it("rejects an already-aborted caller before binding, requests, prompts, or storage writes", async () => {
		const fixture = await setup();
		// An occupied required port distinguishes the pre-bind abort from an eventual network abort.
		const sentinel = createTcpServer();
		sentinel.listen(fixture.callbackPort, "127.0.0.1");
		await once(sentinel, "listening");
		cleanups.push(() => new Promise<void>((resolve) => sentinel.close(() => resolve())));
		const controller = new AbortController();
		const reason = new Error("already cancelled");
		controller.abort(reason);
		let prompted = false;
		// Store construction initializes its file; snapshot before entering public sign-in.
		const store = fixture.credentials().forServer(fixture.serverUrl);
		const before = readFileSync(join(fixture.dir, "auth.json"));
		await expect(
			signInMcpServer({
				serverUrl: fixture.serverUrl,
				store,
				settings: { callbackPort: fixture.callbackPort },
				signal: controller.signal,
				prompt: {
					showAuthorizationUrl: () => {
						prompted = true;
					},
					promptForRedirectUrl: async () => {
						prompted = true;
						return undefined;
					},
				},
			}),
		).rejects.toBe(reason);
		expect(sentinel.listening).toBe(true);
		expect(prompted).toBe(false);
		expect(fixture.requests).toEqual([]);
		expect(readdirSync(fixture.dir)).toEqual(["auth.json"]);
		expect(readFileSync(join(fixture.dir, "auth.json"))).toEqual(before);
	});

	it("aborts an active human prompt and retires callback sockets before same-port PKCE sign-in", async () => {
		const fixture = await setup();
		const controller = new AbortController();
		cleanups.push(() => controller.abort());
		const prompting = deferred<AbortSignal>();
		let authorizationUrl: URL | undefined;
		const pending = fixture.login(controller.signal, {
			prompt: {
				showAuthorizationUrl: (url) => {
					authorizationUrl = url;
				},
				promptForRedirectUrl: (signal) => {
					prompting.resolve(signal);
					return new Promise((resolve) =>
						signal.addEventListener("abort", () => resolve(undefined), { once: true }),
					);
				},
			},
		});
		const outcome = pending.catch((error: unknown) => error);
		const promptSignal = await prompting.promise;
		expect(promptSignal.aborted).toBe(false);
		expect(authorizationUrl?.searchParams.get("redirect_uri")).toBe(
			`http://127.0.0.1:${fixture.callbackPort}/callback`,
		);
		// No browser request has been sent: this is genuinely waiting for a human, not racing a callback.
		expect(fixture.requests).not.toContain("/authorize");
		const sockets = [
			createConnection({ host: "127.0.0.1", port: fixture.callbackPort }),
			createConnection({ host: "127.0.0.1", port: fixture.callbackPort }),
		];
		cleanups.push(() => {
			for (const socket of sockets) socket.destroy();
		});
		await Promise.all(sockets.map((socket) => once(socket, "connect")));
		sockets[1].write("GET /callback HTTP/1.1\r\nHost: localhost\r\n");
		const socketErrors: string[] = [];
		const closed = sockets.map((socket) => {
			socket.on("error", (error: NodeJS.ErrnoException) => socketErrors.push(error.code ?? ""));
			// An incomplete HTTP request may reset; close, not absence of reset, proves retirement.
			return new Promise<void>((resolve) => socket.once("close", () => resolve()));
		});
		const reason = new Error("caller cancelled browser prompt");
		controller.abort(reason);
		expect(await outcome).toBe(reason);
		expect(promptSignal.aborted).toBe(true);
		await Promise.all(closed);
		expect(sockets.every((socket) => socket.destroyed)).toBe(true);
		expect(socketErrors.every((code) => code === "ECONNRESET")).toBe(true);
		expect(fixture.credentials().tokens(fixture.serverUrl)).toBeUndefined();
		expect(readdirSync(fixture.dir).filter((name) => name.endsWith(".lock"))).toEqual([]);
		await fixture
			.credentials()
			.forServer(fixture.serverUrl)
			.withRefreshLock(async () => {});
		await fixture.login();
		expect(fixture.credentials().tokens(fixture.serverUrl)?.access_token).toBe("access-1");
		expect(fixture.grants).toEqual(["authorization_code"]);
		expect(await Promise.all(fixture.browserResponses)).toEqual([200]);
	}, 5000);

	it.each(["metadata-headers-stall", "metadata-stall"] as const)(
		"public network deadline releases the callback and held refresh lock after %s",
		async (mode) => {
			const fixture = await setup();
			fixture.setMode(mode);
			const controller = new AbortController();
			cleanups.push(() => controller.abort());
			const pending = fixture.login(controller.signal, { networkTimeoutMs: 300 });
			const outcome = pending.catch((error: unknown) => error);
			const { response, spare, closed } = await fixture.reached.promise;
			const networkClosed = once(response, "close");
			expect(response.headersSent).toBe(mode === "metadata-stall");
			expect(spare.destroyed).toBe(false);
			expect(readdirSync(fixture.dir).filter((name) => name.endsWith(".lock"))).toHaveLength(1);
			const error = await outcome;
			expect(error).toBeInstanceOf(OAuthNetworkError);
			expect((error as Error).message).toContain("timed out after 300ms");
			expect(controller.signal.aborted).toBe(false);
			await Promise.all([closed, networkClosed]);
			expect(spare.destroyed).toBe(true);
			expect(fixture.credentials().tokens(fixture.serverUrl)).toBeUndefined();
			expect(readdirSync(fixture.dir).filter((name) => name.endsWith(".lock"))).toEqual([]);
			await fixture
				.credentials()
				.forServer(fixture.serverUrl)
				.withRefreshLock(async () => {});
			fixture.setMode("normal");
			await fixture.login();
			expect(fixture.credentials().tokens(fixture.serverUrl)?.access_token).toBe("access-1");
			expect(fixture.grants).toEqual(["authorization_code"]);
			expect(await Promise.all(fixture.browserResponses)).toEqual([200]);
		},
		5000,
	);

	it("does not time out human waiting and exchanges a later real PKCE callback", async () => {
		const fixture = await setup();
		const controller = new AbortController();
		cleanups.push(() => controller.abort());
		const prompting = deferred<AbortSignal>();
		let authorizationUrl: URL | undefined;
		let settled = false;
		const pending = fixture.login(controller.signal, {
			networkTimeoutMs: 300,
			prompt: {
				showAuthorizationUrl: (url) => {
					authorizationUrl = url;
				},
				promptForRedirectUrl: (signal) => {
					prompting.resolve(signal);
					return new Promise((resolve) =>
						signal.addEventListener("abort", () => resolve(undefined), { once: true }),
					);
				},
			},
		});
		const outcome = pending.then(
			() => {
				settled = true;
				return { ok: true as const };
			},
			(error: unknown) => {
				settled = true;
				return { ok: false as const, error };
			},
		);
		const promptSignal = await prompting.promise;
		await delay(700);
		expect(settled).toBe(false);
		expect(promptSignal.aborted).toBe(false);
		expect(fixture.requests).not.toContain("/authorize");
		// Human waiting must not monopolize another instance's refresh lock either.
		await fixture
			.credentials()
			.forServer(fixture.serverUrl)
			.withRefreshLock(async () => {});
		if (!authorizationUrl) throw new Error("missing authorization URL");
		const browser = await fetch(authorizationUrl);
		expect(browser.status).toBe(200);
		await browser.arrayBuffer();
		expect(await outcome).toEqual({ ok: true });
		expect(promptSignal.aborted).toBe(true);
		expect(fixture.grants).toEqual(["authorization_code"]);
		expect(fixture.credentials().tokens(fixture.serverUrl)?.access_token).toBe("access-1");
		expect(readdirSync(fixture.dir).filter((name) => name.endsWith(".lock"))).toEqual([]);
	}, 5000);

	it.each(["metadata-cap", "refresh-cap", "metadata-stall"] as const)(
		"releases the callback and refresh lock after %s, then permits a genuinely new browser sign-in",
		async (mode) => {
			const fixture = await setup();
			if (mode === "refresh-cap") await fixture.login();
			fixture.setMode(mode);
			const controller = new AbortController();
			const pending = fixture.login(controller.signal);
			// Observe rejection immediately; a deliberately stalled response must not produce an unhandled rejection.
			const outcome = pending.then(
				() => ({ ok: true as const }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			const { response, spare, closed } = await fixture.reached.promise;
			expect(spare.destroyed).toBe(false);
			expect(
				readdirSync(fixture.dir).filter((name) => name.startsWith("mcp-auth-refresh-") && name.endsWith(".lock")),
			).toHaveLength(1);
			if (mode === "metadata-stall") controller.abort(new Error("caller cancelled OAuth network"));
			else {
				// Valid oversized JSON: baseline acceptance is not merely a JSON syntax failure.
				const padding = "x".repeat(1024 * 1024 + 1);
				response.end(
					JSON.stringify(
						mode === "metadata-cap"
							? { resource: fixture.serverUrl, authorization_servers: [fixture.origin], padding }
							: { access_token: "oversized", refresh_token: "oversized-refresh", token_type: "Bearer", padding },
					),
				);
			}
			const result = await outcome;
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.error).toBeInstanceOf(
					mode === "metadata-stall" ? OAuthNetworkError : OAuthResponseLimitError,
				);
			expect(fixture.credentials().tokens(fixture.serverUrl)?.access_token).toBe(
				mode === "refresh-cap" ? "access-1" : undefined,
			);
			await closed;
			expect(spare.destroyed).toBe(true);
			expect(readdirSync(fixture.dir).filter((name) => name.endsWith(".lock"))).toEqual([]);
			const refused = createConnection({ host: "127.0.0.1", port: fixture.callbackPort });
			const [error] = await once(refused, "error");
			expect((error as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
			// Independently reacquire the real cross-instance refresh lock, not just inspect its directory.
			await fixture
				.credentials()
				.forServer(fixture.serverUrl)
				.withRefreshLock(async () => {});
			await fixture.credentials().remove(fixture.serverUrl);
			fixture.setMode("normal");
			await fixture.login();
			expect(fixture.credentials().tokens(fixture.serverUrl)?.access_token).toBe(
				mode === "refresh-cap" ? "access-2" : "access-1",
			);
			expect(fixture.grants.at(-1)).toBe("authorization_code");
			expect(await Promise.all(fixture.browserResponses)).toEqual(mode === "refresh-cap" ? [200, 200] : [200]);
			expect(readdirSync(fixture.dir).filter((name) => name.endsWith(".lock"))).toEqual([]);
		},
		5000,
	);
});
