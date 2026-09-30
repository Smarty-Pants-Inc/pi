import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { McpOAuthCredentialStore, signInMcpServer } from "../src/extensions/mcp/oauth.ts";
import type { OAuthProcessEvent } from "./fixtures/security-round2-oauth-process.ts";
import { startOAuthMcpServer } from "./suite/mcp-oauth-server.ts";

// smarty-dev#2241 F22: separate OS processes share only the credential file and proper-lockfile directory.
describe("MCP OAuth replacement authority across processes", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});

	async function setup() {
		const dir = mkdtempSync(join(tmpdir(), "pi-oauth-processes-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(join(dir, "auth.json")), dir);
		await signInMcpServer({
			serverUrl: server.url,
			store: credentials.forServer(server.url),
			settings: { scope: "read" },
			prompt: {
				showAuthorizationUrl: (url) => void fetch(url),
				promptForRedirectUrl: (signal) =>
					new Promise((resolve) => {
						signal.addEventListener("abort", () => resolve(undefined), { once: true });
					}),
			},
		});
		expect(credentials.tokens(server.url)).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
		const child = (operation: "login" | "refresh", scope = "", responseKind = "") => {
			const home = join(dir, `home-${readdirSync(dir).length}`);
			mkdirSync(home);
			// Do not forward credentials, provider endpoints, NODE_OPTIONS, or the user's agent configuration.
			const process = fork(
				new URL("./fixtures/security-round2-oauth-process.ts", import.meta.url),
				[dir, server.url, operation, scope, responseKind],
				{
					// MCP publishes a source condition: use these exact sources, not potentially stale dist.
					execArgv: ["--conditions=source"],
					env: { HOME: home, TMPDIR: home, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1" },
					stdio: ["ignore", "ignore", "pipe", "ipc"],
				},
			);
			let stderr = "";
			process.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const events: OAuthProcessEvent[] = [];
			let wake: (() => void) | undefined;
			process.on("message", (event: OAuthProcessEvent) => {
				events.push(event);
				wake?.();
			});
			process.on("exit", () => wake?.());
			process.on("error", (error) => {
				stderr += String(error);
				wake?.();
			});
			const next = async <K extends OAuthProcessEvent["kind"]>(kind: K) => {
				const deadline = Date.now() + 10000;
				while (!events.some((event) => event.kind === kind)) {
					if (process.exitCode !== null || process.signalCode !== null)
						throw new Error(`OAuth child exited: ${stderr}`);
					const remaining = deadline - Date.now();
					if (remaining <= 0) throw new Error(`OAuth child timed out waiting for ${kind}: ${stderr}`);
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, remaining);
						wake = () => {
							clearTimeout(timer);
							resolve();
						};
					});
				}
				const index = events.findIndex((event) => event.kind === kind);
				return events.splice(index, 1)[0] as Extract<OAuthProcessEvent, { kind: K }>;
			};
			cleanups.push(async () => {
				if (process.exitCode !== null || process.signalCode !== null) return;
				const exited = once(process, "exit");
				process.kill("SIGTERM");
				const force = setTimeout(() => process.kill("SIGKILL"), 2000);
				try {
					await exited;
				} finally {
					clearTimeout(force);
				}
			});
			return { pid: process.pid, send: (command: string) => process.send(command), next };
		};
		const usable = async (owner: ReturnType<typeof child>, refresh = false) => {
			owner.send(refresh ? "probe-refresh" : "probe");
			const probe = await owner.next("probe");
			expect(probe.status).toBe(200);
			expect(probe.body).toMatchObject({ result: { content: [{ text: `token ${probe.token}` }] } });
			return probe;
		};
		return { server, dir, credentials, child, usable };
	}

	for (const responseKind of ["success", "invalid_grant"] as const) {
		// smarty-dev#2241: A owns a live refresh lock; B's already-started browser exchange commits outside that lock.
		it(`preserves B's additional-scope grant after A's old refresh ${responseKind}`, async () => {
			const { server, dir, credentials, child, usable } = await setup();
			const b = child("login", "write");
			const shown = await b.next("shown");
			expect(new URL(shown.url).searchParams.get("scope")).toBe("read write");
			const a = child("refresh", "", responseKind);
			const paused = await a.next("paused");
			expect(paused.pid).toBe(a.pid);
			expect(shown.pid).toBe(b.pid);
			expect(new Set([process.pid, paused.pid, shown.pid]).size).toBe(3);
			expect(
				readdirSync(dir).filter((name) => name.startsWith("mcp-auth-refresh-") && name.endsWith(".lock")),
			).toHaveLength(1);
			b.send("continue");
			const replacement = await b.next("done");
			expect(replacement.error).toBeUndefined();
			expect(replacement.tokens).toMatchObject({ access_token: "access-3", refresh_token: "refresh-3" });
			a.send("release");
			const old = await a.next("done");
			// Check real token effects before any optional error assertion or refresh could hide the mutation.
			expect(old.tokens).toEqual(replacement.tokens);
			expect(credentials.tokens(server.url)).toEqual(replacement.tokens);
			expect(old.error).toBeTruthy();
			expect((await usable(b)).tokens).toEqual(replacement.tokens);
			expect((await usable(b, true)).tokens).toMatchObject({ access_token: "access-4", refresh_token: "refresh-4" });
			expect(readdirSync(dir).filter((name) => name.endsWith(".lock"))).toEqual([]);
		});

		// smarty-dev#2241: a superseded browser exchange must not publish or erase the newer process's grant.
		it(`preserves B's grant after A's superseded browser ${responseKind}`, async () => {
			const { server, credentials, child, usable } = await setup();
			const a = child("login", "write", responseKind);
			await a.next("shown");
			a.send("continue");
			const paused = await a.next("paused");
			const b = child("login", "write");
			const shown = await b.next("shown");
			expect(paused.pid).toBe(a.pid);
			expect(shown.pid).toBe(b.pid);
			expect(new Set([process.pid, paused.pid, shown.pid]).size).toBe(3);
			b.send("continue");
			const replacement = await b.next("done");
			expect(replacement.error).toBeUndefined();
			expect(replacement.tokens).toMatchObject({ access_token: "access-3", refresh_token: "refresh-3" });
			a.send("release");
			const old = await a.next("done");
			expect(old.tokens).toEqual(replacement.tokens);
			expect(credentials.tokens(server.url)).toEqual(replacement.tokens);
			expect(old.error).toBeTruthy();
			expect((await usable(b)).tokens).toEqual(replacement.tokens);
			expect((await usable(b, true)).tokens).toMatchObject({ access_token: "access-4", refresh_token: "refresh-4" });
		});
	}

	// smarty-dev#2241: control proves shared refresh locking still prevents a second use of a rotated token.
	it("uses the rotated grant without refreshing it again in another process", async () => {
		const { server, child, usable } = await setup();
		const a = child("refresh", "", "success");
		await a.next("paused");
		const b = child("refresh");
		a.send("release");
		const first = await a.next("done");
		const second = await b.next("done");
		expect(first.error).toBeUndefined();
		expect(second.error).toBeUndefined();
		expect(second.tokens).toEqual(first.tokens);
		expect(second.tokens).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2" });
		expect(server.log.filter((entry) => entry === "token refresh")).toHaveLength(1);
		await usable(b);
	});
});
