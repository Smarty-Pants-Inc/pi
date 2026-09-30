import { once } from "node:events";
import { request, Server, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type OAuthCallbackServer,
	type OAuthCallbackServerOptions,
	startOAuthCallbackServer,
} from "../src/auth/oauth/callback-server.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import type { ProviderAuthInteraction } from "../src/auth/types.ts";

// Use the HTTP client rather than fetch: fetch normalizes or rejects the malicious target before sending it.
function callbackRequest(
	redirectUri: string,
	target: string,
): Promise<{ status: number; body: string; contentType: string | undefined }> {
	const url = new URL(redirectUri);
	return new Promise((resolve, reject) => {
		const outgoing = request(
			{ hostname: url.hostname, port: url.port, path: target, method: "GET", agent: false },
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					body += chunk;
				});
				response.once("error", reject);
				response.once("end", () =>
					resolve({ status: response.statusCode ?? 0, body, contentType: response.headers["content-type"] }),
				);
			},
		);
		outgoing.once("error", reject);
		outgoing.setTimeout(2_000, () => outgoing.destroy(new Error("Callback request timed out")));
		outgoing.end();
	});
}

describe.sequential("OAuth callback security boundaries", () => {
	const servers: OAuthCallbackServer<string>[] = [];
	const start = async (options: Partial<OAuthCallbackServerOptions<string>> = {}) => {
		const server = await startOAuthCallbackServer({
			providerName: "Example",
			host: "127.0.0.1",
			port: 0,
			path: "/callback",
			state: "expected-state",
			complete: async (code) => `exchanged:${code}`,
			...options,
		});
		servers.push(server);
		return server;
	};

	afterEach(() => {
		vi.restoreAllMocks();
		for (const server of servers.splice(0)) server.close();
	});

	// smarty-dev#2241 F7: an unauthenticated malformed authority must not reject the HTTP listener.
	it.each(["//[", "//[invalid/callback"])("recovers after malformed request target %s", async (target) => {
		const complete = vi.fn(async (code: string) => `exchanged:${code}`);
		const server = await start({ complete });
		let settled = false;
		const waiting = server.wait();
		waiting.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		const invalid = await callbackRequest(server.redirectUri, target);
		expect(invalid.status).toBe(400);
		expect(invalid.body).toContain("Invalid OAuth callback request.");
		expect(settled).toBe(false);
		expect(complete).not.toHaveBeenCalled();
		expect((await callbackRequest(server.redirectUri, "/other")).status).toBe(404);
		expect((await callbackRequest(server.redirectUri, "/callback?state=wrong&code=forged")).status).toBe(400);
		expect((await callbackRequest(server.redirectUri, "/callback?state=expected-state")).status).toBe(400);
		expect(settled).toBe(false);
		expect(complete).not.toHaveBeenCalled();

		// Allowed counterexample: a well-formed absolute-form target still completes with matching state.
		const valid = await callbackRequest(server.redirectUri, `${server.redirectUri}?state=expected-state&code=good`);
		expect(valid.status).toBe(200);
		expect(valid.body).toContain("Signed in to Example.");
		await expect(waiting).resolves.toBe("exchanged:good");
		expect(complete).toHaveBeenCalledExactlyOnceWith("good");
		expect((await callbackRequest(server.redirectUri, "/callback?state=expected-state&code=again")).status).toBe(409);
	});

	// smarty-dev#2241 F7: observing URL parsing alone is not a whole-handler exception boundary.
	it("observes a response failure outside URL parsing and keeps the unclaimed login active", async () => {
		const server = await start();
		vi.spyOn(ServerResponse.prototype, "writeHead").mockImplementationOnce(() => {
			throw new Error("response failed before headers");
		});
		expect((await callbackRequest(server.redirectUri, "/other")).status).toBe(400);
		expect((await callbackRequest(server.redirectUri, "/callback?state=expected-state&code=good")).status).toBe(200);
		await expect(server.wait()).resolves.toBe("exchanged:good");
	});

	// smarty-dev#2241 F7 countercases: real provider/exchange errors must still reject, not remain pending.
	it("preserves provider rejection and completion failure", async () => {
		const denied = await start();
		const failure = await callbackRequest(
			denied.redirectUri,
			"/callback?state=expected-state&error=access_denied&error_description=Denied",
		);
		expect(failure.status).toBe(400);
		await expect(denied.wait()).rejects.toThrow("Example authorization failed: Denied");

		const exchange = await start({
			complete: async () => {
				throw new Error("exchange failed");
			},
		});
		const exchangeFailure = await callbackRequest(exchange.redirectUri, "/callback?state=expected-state&code=good");
		expect(exchangeFailure.status).toBe(502);
		expect(exchangeFailure.body).toContain("exchange failed");
		await expect(exchange.wait()).rejects.toThrow("exchange failed");
	});

	// smarty-dev#2241 F7 countercase: providers without state and manual cancellation retain their contract.
	it("allows callbacks without configured state and retains manual cancellation", async () => {
		const noState = await start({ state: undefined });
		expect((await callbackRequest(noState.redirectUri, "/callback?code=good")).status).toBe(200);
		await expect(noState.wait()).resolves.toBe("exchanged:good");
		const cancelled = await start();
		cancelled.cancel();
		await expect(cancelled.wait()).resolves.toBeUndefined();
		expect((await callbackRequest(cancelled.redirectUri, "/callback?state=expected-state&code=late")).status).toBe(
			409,
		);
	});

	// smarty-dev#2241 F9: pre-aborted login must never bind a listener.
	it("rejects a pre-aborted signal before binding", async () => {
		const controller = new AbortController();
		controller.abort();
		const listen = vi.spyOn(Server.prototype, "listen");
		await expect(start({ signal: controller.signal })).rejects.toThrow("Login cancelled");
		expect(listen).not.toHaveBeenCalled();
	});

	// smarty-dev#2241 F9: use a real TCP listener, withholding its listening receipt across the bind await.
	it("rejects abort during awaited binding and retires the late-bound listener", async () => {
		const controller = new AbortController();
		const complete = vi.fn(async (code: string) => code);
		const emit: (event: string, ...args: unknown[]) => boolean = Server.prototype.emit;
		let releaseBind: (() => void) | undefined;
		let boundServer: Server | undefined;
		let callback: OAuthCallbackServer<string> | undefined;
		const bound = new Promise<Server>((resolve) => {
			vi.spyOn(Server.prototype, "emit").mockImplementation(function (
				this: Server,
				event: string,
				...args: unknown[]
			) {
				if (event === "listening") {
					boundServer = this;
					releaseBind = () => {
						emit.call(this, event, ...args);
					};
					resolve(this);
					return true;
				}
				return emit.call(this, event, ...args);
			});
		});
		const starting = start({ signal: controller.signal, complete }).then((server) => {
			callback = server;
			return server;
		});
		starting.catch(() => undefined);
		try {
			const listener = await bound;
			expect(listener.listening).toBe(true);
			const closed = once(listener, "close");
			controller.abort();
			releaseBind?.();
			releaseBind = undefined;
			await expect(starting).rejects.toThrow("Login cancelled");
			await closed;
			expect(listener.listening).toBe(false);
			expect(complete).not.toHaveBeenCalled();
		} finally {
			releaseBind?.();
			callback?.close();
			if (boundServer?.listening) boundServer.close();
		}
	});

	// smarty-dev#2241 F9 countercase: a real abort after successful binding also rejects and closes TCP.
	it("rejects abort after binding and stops accepting HTTP callbacks", async () => {
		const controller = new AbortController();
		const complete = vi.fn(async (code: string) => code);
		const server = await start({ signal: controller.signal, complete });
		controller.abort();
		await expect(server.wait()).rejects.toThrow("Login cancelled");
		await expect(
			callbackRequest(server.redirectUri, "/callback?state=expected-state&code=late"),
		).rejects.toMatchObject({
			code: "ECONNREFUSED",
		});
		expect(complete).not.toHaveBeenCalled();
	});
});

describe.sequential("ChatGPT callback state admission", () => {
	afterEach(() => vi.unstubAllGlobals());

	const beginLogin = () => {
		const fetchToken = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(input instanceof Request ? input.url : String(input)).toBe(
				"https://auth.openai.com/api/accounts/oauth/token",
			);
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("grant_type")).toBe("authorization_code");
			expect(body.get("code")).toBe("good-code");
			expect(body.get("client_id")).toBe("oaiapp_security_test");
			return new Response(
				JSON.stringify({
					access_token: "fake-access",
					refresh_token: "fake-refresh",
					expires_in: 3600,
					id_token: "fake-id-token",
					scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
				}),
				{ headers: { "content-type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchToken);
		let resolveAuthorization: (url: URL) => void = () => {};
		let rejectAuthorization: (error: Error) => void = () => {};
		const authorization = new Promise<URL>((resolve, reject) => {
			resolveAuthorization = resolve;
			rejectAuthorization = reject;
		});
		let cancelManual: () => void = () => {};
		const interaction: ProviderAuthInteraction = {
			signal: new AbortController().signal,
			notify: (event) => {
				if (event.type === "auth_url") resolveAuthorization(new URL(event.url));
				// A bind failure must fail this real-HTTP test, not silently use the manual fallback.
				if (event.type === "info") rejectAuthorization(new Error(event.message));
			},
			prompt: (prompt) =>
				new Promise<string>((_, reject) => {
					cancelManual = () => reject(new Error("Manual prompt cancelled"));
					if (prompt.signal?.aborted) cancelManual();
					else prompt.signal?.addEventListener("abort", cancelManual, { once: true });
				}),
		};
		const login = openaiChatGPTOAuth.login(interaction, {
			getDeviceId: () => "e61bbe28-07ef-466d-8e5d-a344f94ab305",
		});
		let settled = false;
		login.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		return {
			authorization,
			login,
			fetchToken,
			cancel: () => cancelManual(),
			get settled() {
				return settled;
			},
		};
	};

	// smarty-dev#2241 A7: missing/wrong-state error callbacks must leave the public login pending.
	it.each([undefined, "wrong-state"])("keeps login pending after error with state %s", async (state) => {
		const attempt = beginLogin();
		try {
			const authorization = await attempt.authorization;
			const expectedState = authorization.searchParams.get("state");
			expect(expectedState).toBeTruthy();
			const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
			callback.searchParams.set("error", "access_denied");
			if (state !== undefined) callback.searchParams.set("state", state);
			const denied = await callbackRequest(callback.href, callback.pathname + callback.search);
			expect(denied.status).toBe(400);
			expect(denied.body).toContain(state === undefined ? "Missing OAuth state" : "OAuth state mismatch");
			expect(attempt.settled).toBe(false);
			expect(attempt.fetchToken).not.toHaveBeenCalled();

			callback.searchParams.delete("error");
			callback.searchParams.set("state", "wrong-success-state");
			callback.searchParams.set("code", "good-code");
			callback.searchParams.set("client_id", "oaiapp_security_test");
			expect((await callbackRequest(callback.href, callback.pathname + callback.search)).status).toBe(400);
			expect(attempt.settled).toBe(false);
			expect(attempt.fetchToken).not.toHaveBeenCalled();

			// Allowed counterexample: the same pending login accepts its matching-state success callback.
			callback.searchParams.set("state", expectedState ?? "");
			expect((await callbackRequest(callback.href, callback.pathname + callback.search)).status).toBe(200);
			await expect(attempt.login).resolves.toMatchObject({
				access: "fake-access",
				clientId: "oaiapp_security_test",
			});
			expect(attempt.fetchToken).toHaveBeenCalledOnce();
		} finally {
			attempt.cancel();
			await attempt.login.catch(() => undefined);
		}
	});

	// smarty-dev#2241 A7 countercase: matching-state provider errors must still reject the public login.
	it("rejects access_denied with matching state without exchanging tokens", async () => {
		const attempt = beginLogin();
		try {
			const authorization = await attempt.authorization;
			const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
			callback.searchParams.set("error", "access_denied");
			callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
			const denied = await callbackRequest(callback.href, callback.pathname + callback.search);
			expect(denied.status).toBe(400);
			expect(denied.body).toContain("ChatGPT was not connected.");
			await expect(attempt.login).rejects.toThrow("ChatGPT authorization failed: access_denied");
			expect(attempt.fetchToken).not.toHaveBeenCalled();
		} finally {
			attempt.cancel();
			await attempt.login.catch(() => undefined);
		}
	});
});
