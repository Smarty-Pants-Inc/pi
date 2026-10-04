/**
 * Loopback OAuth redirect handler shared by the browser sign-in flows.
 *
 * NOTE: This module uses node:http. It is only reachable through the lazily
 * loaded OAuth flow modules, never from browser-facing entry points.
 */

import { createServer, type ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "../../utils/oauth-page.ts";
import type { ProviderAuthInteraction } from "../types.ts";
import { oauthAuthorizationError } from "./credential-response.ts";

export interface OAuthCallbackServerOptions<T> {
	/** Provider name used on the browser page, for example `OpenAI`. */
	providerName: string;
	/** Address to listen on. */
	host: string;
	/** Port to listen on; `0` picks a free port. */
	port: number;
	path: string;
	/** Host in `redirectUri` when it differs from `host`, for example `localhost`. */
	redirectHost?: string;
	/** Expected `state` parameter. Omit when the provider does not send one. */
	state?: string;
	/**
	 * Finishes the sign-in with the received code before the browser page is sent, so the page can
	 * show exchange failures. The exchange must honor the callback-owned signal; terminal wait
	 * settlement joins its disposition. Pass `async (code) => code` to exchange the code later.
	 */
	complete: (code: string, signal: AbortSignal) => Promise<T>;
	signal?: AbortSignal;
	/** Absolute callback/exchange deadline, defaults to five minutes. */
	timeoutMs?: number;
}

export interface OAuthCallbackServer<T> {
	redirectUri: string;
	/**
	 * Resolves with the result of `complete`, or `undefined` after `cancel()`. Rejects when the provider
	 * redirects with an error, `complete` fails, the signal aborts, or the timeout elapses.
	 */
	wait(): Promise<T | undefined>;
	/** Stop waiting for the browser unless a callback is already being completed. */
	cancel(): void;
	close(): void;
}

function sendPage(response: ServerResponse, status: number, html: string): void {
	response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	response.end(html);
}

export async function startOAuthCallbackServer<T>(
	options: OAuthCallbackServerOptions<T>,
): Promise<OAuthCallbackServer<T>> {
	const { providerName, signal } = options;
	if (signal?.aborted) throw new Error("Login cancelled");

	let resolveWait: (value: T | undefined) => void = () => {};
	let rejectWait: (error: Error) => void = () => {};
	const waitPromise = new Promise<T | undefined>((resolve, reject) => {
		resolveWait = resolve;
		rejectWait = reject;
	});
	// A cancelled or closed wait may never be observed.
	waitPromise.catch(() => undefined);

	const completionController = new AbortController();
	let completion: Promise<T> | undefined;
	let claimed = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => finish({ error: new Error("Login cancelled") });
	const finish = (result: { value: T | undefined } | { error: Error }): void => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		// Cancellation owns the exact accepted exchange. Observe and join its disposition
		// before exposing terminal settlement; a late value cannot win after cancellation.
		if ("error" in result) completionController.abort(result.error);
		const settle = () => {
			if ("error" in result) rejectWait(result.error);
			else resolveWait(result.value);
		};
		if (completion) void completion.then(settle, settle);
		else settle();
	};

	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (request.method !== "GET" || url.pathname !== options.path) {
				sendPage(response, 404, oauthErrorHtml("Callback route not found."));
				return;
			}
			if (options.state !== undefined && url.searchParams.get("state") !== options.state) {
				sendPage(response, 400, oauthErrorHtml("State mismatch."));
				return;
			}
			if (claimed || settled) {
				sendPage(response, 409, oauthErrorHtml("This sign-in has already been handled."));
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				const code = oauthAuthorizationError(error);
				sendPage(response, 400, oauthErrorHtml(`${providerName} authorization failed.`, code));
				finish({ error: new Error(`${providerName} authorization failed: ${code}`) });
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				sendPage(response, 400, oauthErrorHtml("Missing authorization code."));
				return;
			}
			claimed = true;
			try {
				completion = Promise.resolve().then(() => options.complete(code, completionController.signal));
				const value = await completion;
				if (settled) return;
				sendPage(response, 200, oauthSuccessHtml(`Signed in to ${providerName}. You may now close this page.`));
				finish({ value });
			} catch (error) {
				if (settled) return;
				const failure = error instanceof Error ? error : new Error(String(error));
				sendPage(response, 502, oauthErrorHtml(`${providerName} sign-in failed.`, failure.message));
				finish({ error: failure });
			}
		})().catch(() => {
			// Observe the complete listener promise, including URL/route/page handling.
			// Invalid requests must not settle a legitimate pending authorization.
			try {
				if (!response.headersSent) sendPage(response, 400, oauthErrorHtml("Invalid OAuth callback request."));
				else response.destroy();
			} catch {
				response.destroy();
			}
		});
	});

	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port, options.host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		if (signal?.aborted) throw new Error("Login cancelled");
	} catch (error) {
		signal?.removeEventListener("abort", onAbort);
		server.close();
		server.closeAllConnections();
		throw error;
	}
	const address = server.address();
	if (!address || typeof address === "string") {
		signal?.removeEventListener("abort", onAbort);
		server.close();
		server.closeAllConnections();
		throw new Error("OAuth callback server did not bind to TCP");
	}

	server.on("error", (error) => finish({ error }));
	timer = setTimeout(
		() => finish({ error: new Error(`${providerName} sign-in timed out`) }),
		options.timeoutMs ?? 5 * 60 * 1000,
	);
	const redirectHost = options.redirectHost ?? options.host;
	return {
		redirectUri: `http://${redirectHost.includes(":") ? `[${redirectHost}]` : redirectHost}:${address.port}${options.path}`,
		wait: () => waitPromise,
		cancel: () => {
			if (!claimed) finish({ value: undefined });
		},
		close: () => {
			finish({ error: new Error("OAuth callback server closed") });
			server.close();
			server.closeAllConnections();
		},
	};
}

/**
 * Wait for the browser callback, or for the user to paste the code or redirect URL when the browser
 * cannot reach the loopback server (for example over SSH). Without a callback server only the manual
 * prompt is used.
 */
export async function waitForCallbackOrManualInput<T>(
	interaction: ProviderAuthInteraction,
	callback: OAuthCallbackServer<T> | undefined,
	prompt: { message: string; placeholder: string },
): Promise<{ type: "callback"; value: T } | { type: "manual"; input: string }> {
	interaction.signal.throwIfAborted();
	const manualAbort = new AbortController();
	const signal = AbortSignal.any([interaction.signal, manualAbort.signal]);
	let manualError: Error | undefined;
	const manual = Promise.resolve()
		.then(() => {
			signal.throwIfAborted();
			return interaction.prompt({ type: "manual_code", ...prompt, signal });
		})
		.then((input) => {
			callback?.cancel();
			return input;
		})
		.catch((error: unknown) => {
			manualError = error instanceof Error ? error : new Error(String(error));
			callback?.cancel();
			return undefined;
		});
	try {
		const value = await callback?.wait();
		if (manualError) throw manualError;
		if (value !== undefined) return { type: "callback", value };
		const input = await manual;
		if (manualError) throw manualError;
		return { type: "manual", input: input ?? "" };
	} finally {
		manualAbort.abort();
		// The exact accepted prompt is observed above and joined on every terminal path.
		await manual;
	}
}
