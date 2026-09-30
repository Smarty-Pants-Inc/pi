import { join } from "node:path";
import type { OAuthTokens } from "@earendil-works/pi-mcp/oauth";
import { FileAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { createMcpAuthProvider, McpOAuthCredentialStore, signInMcpServer } from "../../src/extensions/mcp/oauth.ts";

export type OAuthProcessEvent =
	| { kind: "shown"; url: string; pid: number }
	| { kind: "paused"; pid: number }
	| { kind: "done"; error?: string; tokens?: OAuthTokens; pid: number }
	| { kind: "probe"; token?: string; status: number; body: unknown; tokens?: OAuthTokens; pid: number };

const [dir, serverUrl, operation, scope, responseKind] = process.argv.slice(2);
const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(join(dir, "auth.json")), dir);
const provider = createMcpAuthProvider({
	serverUrl,
	store: credentials.forServer(serverUrl),
	settings: () => ({}),
	onChallenge: () => {},
});
const send = (event: OAuthProcessEvent) => process.send?.(event);
const proceed = new Promise<void>((resolve) => {
	process.on("message", (message: unknown) => {
		if (message === "continue") resolve();
	});
});
const release = new Promise<void>((resolve) => {
	process.on("message", (message: unknown) => {
		if (message === "release") resolve();
	});
});
const realFetch = globalThis.fetch;
let paused = false;
const gatedFetch: typeof fetch = async (input, init) => {
	const response = await realFetch(input, init);
	if (responseKind && !paused && new URL(String(input)).pathname === "/token") {
		paused = true;
		send({ kind: "paused", pid: process.pid });
		await release;
		if (responseKind === "invalid_grant") {
			await response.body?.cancel();
			return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
		}
	}
	return response;
};
process.on("message", (message: unknown) => {
	if (message !== "probe" && message !== "probe-refresh") return;
	void (async () => {
		if (message === "probe-refresh") {
			await provider.onUnauthorized?.({
				response: new Response(null, { status: 401 }),
				serverUrl: new URL(serverUrl),
				token: await provider.token(),
				fetch: realFetch,
			});
		}
		const token = await provider.token();
		const response = await realFetch(serverUrl, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } }),
		});
		send({
			kind: "probe",
			token,
			status: response.status,
			body: await response.json(),
			tokens: credentials.tokens(serverUrl),
			pid: process.pid,
		});
	})().catch((error: unknown) => {
		send({ kind: "done", error: String(error), pid: process.pid });
	});
});

try {
	if (operation === "refresh") {
		await provider.onUnauthorized?.({
			response: new Response(null, { status: 401 }),
			serverUrl: new URL(serverUrl),
			token: "access-1",
			fetch: gatedFetch,
		});
	} else {
		globalThis.fetch = gatedFetch;
		await signInMcpServer({
			serverUrl,
			store: credentials.forServer(serverUrl),
			settings: { scope: "read" },
			challenge: scope ? { error: "insufficient_scope", scope } : undefined,
			prompt: {
				showAuthorizationUrl: (url) => {
					send({ kind: "shown", url: url.href, pid: process.pid });
					void proceed
						.then(() => realFetch(url))
						.catch((error: unknown) => {
							send({ kind: "done", error: String(error), pid: process.pid });
						});
				},
				promptForRedirectUrl: (signal) =>
					new Promise((resolve) => {
						signal.addEventListener("abort", () => resolve(undefined), { once: true });
					}),
			},
		});
	}
	send({ kind: "done", tokens: credentials.tokens(serverUrl), pid: process.pid });
} catch (error) {
	send({ kind: "done", error: String(error), tokens: credentials.tokens(serverUrl), pid: process.pid });
} finally {
	globalThis.fetch = realFetch;
}
