import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAuthStorageBackend, InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import {
	createMcpAuthProvider,
	McpOAuthCredentialStore,
	type McpOAuthServerStore,
	signInMcpServer,
} from "../src/extensions/mcp/oauth.ts";
import { startOAuthMcpServer } from "./suite/mcp-oauth-server.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
	const timer = new AbortController();
	try {
		return await Promise.race([
			promise,
			sleep(750, undefined, { signal: timer.signal }).then(() => {
				throw new Error("queued caller did not settle while the holder remained gated");
			}),
		]);
	} finally {
		timer.abort();
	}
}

// smarty-dev#2241 OAUTH-R1: real public callback binding, refresh ownership, and rotated grants.
describe("queued MCP sign-in lock cancellation", () => {
	const cleanups: (() => Promise<void> | void)[] = [];
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
		vi.restoreAllMocks();
	});

	async function setup(file: boolean) {
		const dir = mkdtempSync(join(tmpdir(), "pi-oauth-lock-cancellation-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const memory = new InMemoryAuthStorageBackend();
		// File owners share no backend/queue; only the real proper-lockfile directory.
		const owner = () =>
			new McpOAuthCredentialStore(
				file ? new FileAuthStorageBackend(join(dir, "auth.json")) : memory,
				file ? dir : undefined,
			);
		const first = owner();
		const second = owner();
		const reservation = createServer();
		reservation.listen(0, "127.0.0.1");
		await once(reservation, "listening");
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("missing TCP address");
		const port = address.port;
		await new Promise<void>((resolve) => reservation.close(() => resolve()));
		const browsers: Promise<unknown>[] = [];
		const login = (store: McpOAuthServerStore, signal?: AbortSignal, browser = true) =>
			signInMcpServer({
				serverUrl: server.url,
				store,
				settings: { callbackPort: port },
				signal,
				prompt: {
					showAuthorizationUrl: (url) => {
						if (!browser) throw new Error("queued login must reread the rotated grant");
						browsers.push(fetch(url).then((response) => response.arrayBuffer()));
					},
					promptForRedirectUrl: (promptSignal) =>
						new Promise((resolve) =>
							promptSignal.addEventListener("abort", () => resolve(undefined), { once: true }),
						),
				},
			});
		await login(first.forServer(server.url));
		await Promise.all(browsers);
		const reached = deferred<void>();
		const release = deferred<void>();
		const provider = createMcpAuthProvider({
			serverUrl: server.url,
			store: first.forServer(server.url),
			settings: () => ({}),
			onChallenge: () => {},
		});
		let holderSettled = false;
		const holder = provider.onUnauthorized?.({
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
		const holderOutcome = holder?.finally(() => {
			holderSettled = true;
		});
		cleanups.push(async () => {
			release.resolve();
			await holderOutcome;
		});
		await reached.promise;
		const queued = deferred<void>();
		const store = second.forServer(server.url);
		const waiting: McpOAuthServerStore = {
			...store,
			withRefreshLock: (fn, ...args) => {
				queued.resolve(); // Public sign-in has finished binding before reaching this boundary.
				return store.withRefreshLock(fn, ...args);
			},
		};
		return {
			dir,
			server,
			first,
			second,
			store,
			waiting,
			port,
			queued,
			login,
			release,
			holderOutcome,
			holderSettled: () => holderSettled,
		};
	}

	for (const file of [true, false]) {
		// smarty-dev#2241: aborted queued work must not write, monopolize a port, or cancel the holder.
		it(`${file ? "file" : "in-process"}: retires a bound callback and sockets while another holder rotates`, async () => {
			const f = await setup(file);
			const controller = new AbortController();
			const reason = new Error("exact queued cancellation reason");
			const before = file ? readFileSync(join(f.dir, "auth.json")) : undefined;
			let authorizationWrites = 0;
			const forAuthorization = f.waiting.forAuthorization;
			f.waiting.forAuthorization = () => {
				const attempt = forAuthorization();
				return {
					...attempt,
					save: (...args) => {
						authorizationWrites++;
						return attempt.save(...args);
					},
				};
			};
			const outcome = f.login(f.waiting, controller.signal).catch((error: unknown) => error);
			await f.queued.promise;
			const sockets: Socket[] = [
				createConnection({ host: "127.0.0.1", port: f.port }),
				createConnection({ host: "127.0.0.1", port: f.port }),
			];
			cleanups.push(() => {
				for (const socket of sockets) socket.destroy();
			});
			await Promise.all(sockets.map((socket) => once(socket, "connect")));
			const closed = sockets.map((socket) => {
				socket.on("error", () => {});
				return new Promise<void>((resolve) => socket.once("close", () => resolve()));
			});
			sockets[1].write("GET /callback HTTP/1.1\r\nHost: localhost\r\n");
			try {
				controller.abort(reason);
				expect(await promptly(outcome)).toBe(reason);
				await promptly(Promise.all(closed));
				expect(sockets.every((socket) => socket.destroyed)).toBe(true);
				expect(f.holderSettled()).toBe(false);
				expect(authorizationWrites).toBe(0);
				expect(f.second.tokens(f.server.url)?.access_token).toBe("access-1");
				if (file) expect(readFileSync(join(f.dir, "auth.json"))).toEqual(before);
				const rebound = createServer();
				rebound.listen(f.port, "127.0.0.1");
				await once(rebound, "listening");
				await new Promise<void>((resolve) => rebound.close(() => resolve()));
			} finally {
				f.release.resolve();
				await f.holderOutcome;
				await outcome;
			}
			expect(f.second.tokens(f.server.url)?.refresh_token).toBe("refresh-2");
			await f.store.withRefreshLock(async () => {});
			expect(authorizationWrites).toBe(0);
			expect(f.second.tokens(f.server.url)?.refresh_token).toBe("refresh-2");
			await f.second.remove(f.server.url);
			await f.login(f.second.forServer(f.server.url));
			expect(f.second.tokens(f.server.url)?.access_token).toBe("access-3");
			expect(f.server.log.filter((entry) => entry === "token code")).toHaveLength(2);
		}, 5000);

		// smarty-dev#2241: cancellation must not weaken ordinary serialization or grant rereads.
		it(`${file ? "file" : "in-process"}: noncancelled B waits for A and uses A's rotated token`, async () => {
			const f = await setup(file);
			let settled = false;
			const login = f.login(f.waiting, undefined, false).finally(() => {
				settled = true;
			});
			await f.queued.promise;
			expect(settled).toBe(false);
			expect(f.holderSettled()).toBe(false);
			expect(f.server.log.filter((entry) => entry === "token refresh")).toHaveLength(1);
			f.release.resolve();
			await f.holderOutcome;
			await login;
			expect(f.second.tokens(f.server.url)?.refresh_token).toBe("refresh-3");
			expect(f.server.log.filter((entry) => entry === "token refresh")).toHaveLength(2);
		}, 5000);
	}

	// smarty-dev#2241: cancelling a queue slot must not remove its still-active predecessor.
	it("skips cancelled in-process work, retains the queue, and joins an aborted active holder", async () => {
		const backend = new InMemoryAuthStorageBackend();
		const first = new McpOAuthCredentialStore(backend).forServer("http://localhost/mcp");
		const second = new McpOAuthCredentialStore(backend).forServer("http://localhost/mcp");
		const reached = deferred<void>();
		const release = deferred<void>();
		const activeSignal = new AbortController();
		let activeSettled = false;
		const active = first
			.withRefreshLock(async () => {
				reached.resolve();
				await release.promise;
				await first.save({
					serverUrl: "http://localhost/mcp",
					tokens: { access_token: "rotated", token_type: "Bearer" },
				});
			}, activeSignal.signal)
			.finally(() => {
				activeSettled = true;
			});
		await reached.promise;
		const queuedSignal = new AbortController();
		const skipped = vi.fn(async () => {});
		const outcome = second.withRefreshLock(skipped, queuedSignal.signal).catch((error: unknown) => error);
		const reason = new Error("skip queued callback");
		queuedSignal.abort(reason);
		try {
			expect(await promptly(outcome)).toBe(reason);
			activeSignal.abort(new Error("holder must still save and settle"));
			let followerStarted = false;
			const follower = second.withRefreshLock(async () => {
				followerStarted = true;
				expect((await second.load())?.tokens?.access_token).toBe("rotated");
			});
			// A microtask checkpoint, not a delay-based ordering fixture.
			await Promise.resolve();
			expect(activeSettled).toBe(false);
			expect(followerStarted).toBe(false);
			release.resolve();
			await active;
			await follower;
			expect(skipped).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await active;
		}
	});

	// smarty-dev#2241: a live file holder is renewed past stale=20s; noncancelled acquisition stays bounded.
	it("retains the 25-second noncancelled acquisition bound and 100ms retry/20s stale settings", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-oauth-lock-bound-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const owner = () =>
			new McpOAuthCredentialStore(new InMemoryAuthStorageBackend(), dir).forServer("http://localhost/mcp");
		const reached = deferred<void>();
		const release = deferred<void>();
		const holder = owner().withRefreshLock(async () => {
			reached.resolve();
			await release.promise;
		});
		await reached.promise;
		const nativeLock = lockfile.lock;
		let attempts = 0;
		vi.spyOn(lockfile, "lock").mockImplementation((path, options) => {
			attempts++;
			expect(options?.stale).toBe(20_000);
			expect(options?.retries).toBe(0);
			return nativeLock(path, options);
		});
		const callback = vi.fn(async () => {});
		const started = Date.now();
		try {
			await expect(owner().withRefreshLock(callback)).rejects.toMatchObject({ code: "ELOCKED" });
			expect(Date.now() - started).toBeGreaterThanOrEqual(25_000);
			expect(Date.now() - started).toBeLessThan(28_000);
			expect(attempts).toBeGreaterThan(200);
			expect(attempts).toBeLessThanOrEqual(252);
			expect(callback).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			release.resolve();
			await holder;
		}
		await owner().withRefreshLock(async () => {});
	}, 30_000);

	// smarty-dev#2241: an acquired lock cannot be abandoned when cancellation wins concurrently.
	it("releases a file lock acquired concurrently with abort before rejecting", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-oauth-lock-acquire-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const store = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend(), dir).forServer(
			"http://localhost/mcp",
		);
		const controller = new AbortController();
		const reason = new Error("abort at acquisition completion");
		const nativeLock = lockfile.lock;
		vi.spyOn(lockfile, "lock").mockImplementation(async (path, options) => {
			const release = await nativeLock(path, options);
			controller.abort(reason);
			return release;
		});
		const callback = vi.fn(async () => {});
		await expect(store.withRefreshLock(callback, controller.signal)).rejects.toBe(reason);
		expect(callback).not.toHaveBeenCalled();
		vi.restoreAllMocks();
		await store.withRefreshLock(async () => {});
	});
});
