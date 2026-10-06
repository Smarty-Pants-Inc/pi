import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import type { AuthEvent } from "../src/auth/types.ts";

// smarty-dev#5822 (T-R2-02): exercise the real listener helper without opening a socket.
const listener = vi.hoisted(() => ({
	bindFailure: false,
	closed: 0,
	bound: false,
	handler: undefined as ((request: IncomingMessage, response: ServerResponse) => void) | undefined,
}));

vi.mock("node:http", () => ({
	createServer: (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
		listener.handler = handler;
		let errorListener: ((error: Error) => void) | undefined;
		return {
			on: () => {},
			once: (_event: string, callback: (error: Error) => void) => {
				errorListener = callback;
			},
			off: () => {},
			listen: (_port: number, _host: string, callback: () => void) => {
				if (listener.bindFailure) errorListener?.(new Error("synthetic EADDRINUSE"));
				else {
					listener.bound = true;
					callback();
				}
			},
			address: () => ({ port: 53692 }),
			close: () => {
				listener.closed++;
			},
			closeAllConnections: () => {},
		};
	},
}));

function callbackRequest(state: string, code = "synthetic-code"): { status?: number; page?: string } {
	const result: { status?: number; page?: string } = {};
	const response = {
		writeHead: (status: number) => {
			result.status = status;
		},
		end: (page: string) => {
			result.page = page;
		},
	};
	listener.handler?.(
		{ method: "GET", url: `/callback?code=${code}&state=${state}` } as IncomingMessage,
		response as unknown as ServerResponse,
	);
	return result;
}

function checkExchange(events: AuthEvent[], body: Record<string, string>): void {
	const event = events.find((value) => value.type === "auth_url");
	if (event?.type !== "auth_url") throw new Error("Missing auth URL");
	const url = new URL(event.url);
	expect(body.state).toBe(url.searchParams.get("state"));
	expect(body.state).not.toBe(body.code_verifier);
	expect(body.state).toMatch(/^[a-f0-9]{64}$/);
	expect(url.searchParams.get("code_challenge")).toBe(
		createHash("sha256").update(body.code_verifier).digest("base64url"),
	);
	expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	expect(JSON.stringify(events)).not.toContain(body.code_verifier);
}

describe("Anthropic owned listener and private PKCE verifier", () => {
	let bodies: Record<string, string>[];
	beforeEach(() => {
		listener.bindFailure = false;
		listener.bound = false;
		listener.closed = 0;
		listener.handler = undefined;
		bodies = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body)) as Record<string, string>);
				return new Response(
					JSON.stringify({
						access_token: "synthetic-access",
						refresh_token: "synthetic-refresh",
						expires_in: 3600,
					}),
					{ status: 200 },
				);
			}),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fails closed before advertising any auth URL when the listener cannot bind", async () => {
		listener.bindFailure = true;
		const events: AuthEvent[] = [];
		await expect(
			anthropicOAuth.login({
				signal: new AbortController().signal,
				notify: (event) => events.push(event),
				prompt: async (prompt) => (prompt.type === "select" ? "browser" : "synthetic-code"),
			}),
		).rejects.toThrow("oauth_request_failed (HTTP unknown)");
		expect(events).toEqual([]);
		expect(bodies).toEqual([]);
		expect(listener.closed).toBe(1);
	});

	it.each(["browser", "copy_code"])("keeps state independent of verifier for %s manual completion", async (method) => {
		const events: AuthEvent[] = [];
		const credential = await anthropicOAuth.login({
			signal: new AbortController().signal,
			notify: (event) => {
				if (method === "browser") expect(listener.bound).toBe(true);
				events.push(event);
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") return method;
				const event = events.find((value) => value.type === "auth_url");
				if (event?.type !== "auth_url") throw new Error("Missing auth URL");
				return `synthetic-code#${new URL(event.url).searchParams.get("state")}`;
			},
		});
		expect(credential.access).toBe("synthetic-access");
		expect(bodies).toHaveLength(1);
		checkExchange(events, bodies[0]);
		expect(bodies[0].redirect_uri).toBe(
			method === "browser" ? "http://localhost:53692/callback" : "https://platform.claude.com/oauth/code/callback",
		);
		expect(listener.closed).toBe(method === "browser" ? 1 : 0);
	});

	it("validates browser callback state, rejects a mismatched callback without settling, and closes the listener", async () => {
		const events: AuthEvent[] = [];
		let rejected: ReturnType<typeof callbackRequest> | undefined;
		let accepted: ReturnType<typeof callbackRequest> | undefined;
		const credential = await anthropicOAuth.login({
			signal: new AbortController().signal,
			notify: (event) => {
				events.push(event);
				if (event.type === "auth_url") {
					rejected = callbackRequest("synthetic-wrong-state");
					accepted = callbackRequest(new URL(event.url).searchParams.get("state") ?? "");
				}
			},
			prompt: (prompt) =>
				prompt.type === "select"
					? Promise.resolve("browser")
					: new Promise<string>((_resolve, reject) => {
							prompt.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")), {
								once: true,
							});
						}),
		});
		expect(credential.access).toBe("synthetic-access");
		expect(rejected?.status).toBe(400);
		expect(accepted?.status).toBe(200);
		expect(bodies).toHaveLength(1);
		checkExchange(events, bodies[0]);
		expect(listener.closed).toBe(1);
	});

	it.each(["browser", "copy_code"])(
		"refuses mismatched manual state for %s without token exchange",
		async (method) => {
			await expect(
				anthropicOAuth.login({
					signal: new AbortController().signal,
					notify: () => {},
					prompt: async (prompt) => (prompt.type === "select" ? method : "synthetic-code#synthetic-wrong-state"),
				}),
			).rejects.toThrow("oauth_request_failed (HTTP unknown)");
			expect(bodies).toEqual([]);
			expect(listener.closed).toBe(method === "browser" ? 1 : 0);
		},
	);
});
