import { Server } from "node:http";
import { connect } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { classify } from "../src/api/llama-cpp-classify.ts";
import * as callbackServers from "../src/auth/oauth/callback-server.ts";
import { startOAuthCallbackServer } from "../src/auth/oauth/callback-server.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import { openRouterOAuth } from "../src/auth/oauth/openrouter.ts";
import { createRadiusOAuth } from "../src/auth/oauth/radius.ts";
import type { ClassifierModel } from "../src/types.ts";

// PR #131 P2-8: provider exchanges must use the callback-owned cancellation signal.
it.each(["openrouter", "radius"])("joins %s exchange when callback times out", async (provider) => {
	const start = callbackServers.startOAuthCallbackServer;
	vi.spyOn(callbackServers, "startOAuthCallbackServer").mockImplementation((options) =>
		start({ ...options, timeoutMs: 100 }),
	);
	let retired = false;
	const controller = new AbortController();
	let exchange: Promise<Response> | undefined;
	let callbackRequest: Promise<unknown> | undefined;
	let exchangeSignal: AbortSignal | null | undefined;
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input).endsWith("/v1/oauth"))
			return Response.json({ authorizationEndpoint: "https://radius.test/authorize" });
		exchangeSignal = init?.signal;
		exchange = new Promise<Response>((_resolve, reject) =>
			init?.signal?.addEventListener(
				"abort",
				() =>
					setTimeout(() => {
						retired = true;
						reject(new Error("cancelled"));
					}, 20),
				{ once: true },
			),
		);
		return exchange;
	});
	const oauth =
		provider === "openrouter"
			? openRouterOAuth
			: createRadiusOAuth({ name: "Radius", gateway: "https://radius.test" });
	const login = oauth.login({
		signal: controller.signal,
		prompt: (prompt) =>
			prompt.type === "select"
				? Promise.resolve("browser")
				: new Promise<string>((_resolve, reject) =>
						prompt.signal?.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true }),
					),
		notify: (event) => {
			if (event.type !== "auth_url") return;
			const authorize = new URL(event.url);
			const callback = new URL(
				authorize.searchParams.get("callback_url") ?? authorize.searchParams.get("redirect_uri")!,
			);
			callback.searchParams.set("code", "code");
			if (authorize.searchParams.has("state"))
				callback.searchParams.set("state", authorize.searchParams.get("state")!);
			callbackRequest = nativeFetch(callback).catch(() => undefined);
		},
	});
	try {
		await expect(login).rejects.toThrow("timed out");
		expect(exchangeSignal?.aborted).toBe(true);
		expect(retired).toBe(true);
	} finally {
		controller.abort();
		await exchange?.catch(() => undefined);
		await callbackRequest;
	}
});

// PR #131 P2-10: progress cannot renew the whole native body operation.
it.each(["chatgpt", "codex", "device"])("deadlines a trickling %s body", async (kind) => {
	vi.useFakeTimers();
	let cancelled = false;
	let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
	vi.stubGlobal(
		"fetch",
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						stream = controller;
						controller.enqueue(new TextEncoder().encode("{"));
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
	);
	const controller = new AbortController();
	const work =
		kind === "device"
			? openaiCodexOAuth.login({ signal: controller.signal, prompt: async () => "device_code", notify: () => {} })
			: (kind === "codex" ? openaiCodexOAuth : openaiChatGPTOAuth).refresh(credential, controller.signal);
	const observed = work.catch((error) => error as Error);
	try {
		for (let index = 0; index < 3; index++) {
			await vi.advanceTimersByTimeAsync(9000);
			stream?.enqueue(new TextEncoder().encode(" "));
		}
		await vi.advanceTimersByTimeAsync(3001);
		expect(cancelled).toBe(true);
		expect(await observed).toBeInstanceOf(Error);
	} finally {
		controller.abort();
		if (!cancelled) stream?.error(new Error("cleanup"));
		await observed;
	}
});

// PR #131 P2-10: classifier success and error readers share the cumulative byte limit.
it.each([200, 500])("bounds classifier HTTP %s bodies", async (status) => {
	let cancelled = 0;
	const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
	const work = classify(
		{ ...model, baseUrl: `http://size-${status}.test/v1` },
		{ state: {}, questions: { pick: { type: "choice", instructions: "Pick", criteria: { a: "", b: "" } } } },
		{
			maxRetries: 0,
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							streams.push(controller);
							controller.enqueue(new Uint8Array(17 * 1024 * 1024));
						},
						cancel() {
							cancelled++;
						},
					}),
					{ status },
				),
		},
	);
	try {
		await vi.waitFor(() => expect(cancelled).toBeGreaterThan(0), { timeout: 300 });
		const result = await work;
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("byte limit");
	} finally {
		if (!cancelled) for (const stream of streams) stream.error(new Error("cleanup"));
		await work;
	}
});

// PR #131 P2-10: expiry interrupts the final in-flight device poll, not just its next sleep.
it("interrupts a device poll at the absolute authorization expiry", async () => {
	vi.useFakeTimers();
	let calls = 0;
	let heldSignal: AbortSignal | null | undefined;
	vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
		if (++calls === 1) return Response.json({ device_auth_id: "id", user_code: "code", interval: 899 });
		if (calls === 2) return new Response(null, { status: 403 });
		heldSignal = init?.signal;
		return new Promise<Response>((_resolve, reject) =>
			heldSignal?.addEventListener("abort", () => reject(new Error("expired")), { once: true }),
		);
	});
	const controller = new AbortController();
	const work = openaiCodexOAuth.login({
		signal: controller.signal,
		prompt: async () => "device_code",
		notify: () => {},
	});
	const observed = work.catch((error) => error as Error);
	try {
		await vi.advanceTimersByTimeAsync(899_000);
		expect(calls).toBe(3);
		await vi.advanceTimersByTimeAsync(1001);
		expect(heldSignal?.aborted).toBe(true);
		expect(((await observed) as Error).message).toBe("Device flow timed out");
	} finally {
		controller.abort();
		await observed;
	}
});

const nativeFetch = globalThis.fetch;
const credential = { type: "oauth" as const, access: "old", refresh: "old", expires: 0, clientId: "issued" };
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// PR #131 P2-7: unauthenticated errors cannot settle a live authorization.
it.each(["missing", "wrong"])("ignores %s-state browser and pasted errors before admission", async (state) => {
	vi.stubGlobal("fetch", async () =>
		Response.json({
			access_token: "access",
			refresh_token: "refresh",
			expires_in: 3600,
			id_token: "id",
			scope: "chatgpt.tokens.use.direct",
		}),
	);
	let authorize: URL | undefined;
	let prompts = 0;
	const result = await openaiChatGPTOAuth.login(
		{
			signal: new AbortController().signal,
			notify: (event) => {
				if (event.type === "auth_url") authorize = new URL(event.url);
			},
			prompt: async () => {
				const url = new URL(authorize!.searchParams.get("redirect_uri")!);
				if (++prompts === 1) {
					url.searchParams.set("error", "access_denied");
					url.searchParams.set("state", authorize!.searchParams.get("state")!);
					expect((await nativeFetch(url, { method: "POST" })).status).toBe(404);
					if (state === "missing") url.searchParams.delete("state");
					else url.searchParams.set("state", "wrong");
					const response = await nativeFetch(url);
					expect(response.status).toBe(400);
					return url.toString();
				}
				url.searchParams.set("state", authorize!.searchParams.get("state")!);
				url.searchParams.set("code", "code");
				url.searchParams.set("client_id", "issued");
				return url.toString();
			},
		},
		{ getDeviceId: () => "e61bbe28-07ef-466d-8e5d-a344f94ab305" },
	);
	expect(result.access).toBe("access");
	expect(prompts).toBe(2);
});

// PR #131 P2-8: abort during asynchronous listen must not publish a live server.
it("rechecks abort during bind", async () => {
	const controller = new AbortController();
	const listen = Server.prototype.listen;
	vi.spyOn(Server.prototype, "listen").mockImplementation(function (
		this: Server,
		...args: Parameters<Server["listen"]>
	) {
		const result = listen.apply(this, args);
		controller.abort();
		return result;
	});
	const started = await startOAuthCallbackServer({
		providerName: "Example",
		host: "127.0.0.1",
		port: 0,
		path: "/callback",
		complete: async (code) => code,
		signal: controller.signal,
	}).then(
		(value) => {
			value.close();
			return "published";
		},
		() => "cancelled",
	);
	expect(started).toBe("cancelled");
});

// PR #131 P2-8: close owns sockets that have not sent an HTTP request.
it("closes spare sockets", async () => {
	const callback = await startOAuthCallbackServer({
		providerName: "Example",
		host: "127.0.0.1",
		port: 0,
		path: "/callback",
		complete: async (code) => code,
	});
	const socket = connect(Number(new URL(callback.redirectUri).port), "127.0.0.1");
	try {
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		const closed = new Promise<boolean>((resolve) => socket.once("close", () => resolve(true)));
		callback.close();
		expect(
			await Promise.race([closed, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))]),
		).toBe(true);
	} finally {
		socket.destroy();
		callback.close();
	}
});

// PR #131 P2-8: terminal wait joins the accepted exchange's abort disposition.
it("aborts and joins an accepted exchange on timeout", async () => {
	let retired = false;
	let finish: (() => void) | undefined;
	const callback = await startOAuthCallbackServer({
		providerName: "Example",
		host: "127.0.0.1",
		port: 0,
		path: "/callback",
		timeoutMs: 100,
		complete: (_code: string, signal?: AbortSignal) =>
			new Promise<string>((resolve) => {
				finish = () => {
					retired = true;
					resolve("late");
				};
				signal?.addEventListener("abort", () => setTimeout(() => finish?.(), 20), { once: true });
			}),
	});
	const request = nativeFetch(`${callback.redirectUri}?code=code`).catch(() => undefined);
	try {
		await expect(callback.wait()).rejects.toThrow("timed out");
		expect(retired).toBe(true);
	} finally {
		finish?.();
		callback.close();
		await request;
	}
});

// PR #131 P2-10: valid but oversized credential bodies must be rejected before JSON admission.
it.each(["chatgpt", "codex", "device"])("bounds %s response bytes", async (kind) => {
	let cancelled = false;
	let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
	vi.stubGlobal(
		"fetch",
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						stream = controller;
						controller.enqueue(
							new TextEncoder().encode(
								JSON.stringify({
									access_token: "a".repeat(2 * 1024 * 1024),
									refresh_token: "r",
									expires_in: 3600,
									scope: "chatgpt.tokens.use.direct",
									device_auth_id: "id",
									user_code: "code",
									interval: 1,
								}),
							),
						);
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
	);
	const controller = new AbortController();
	const work =
		kind === "device"
			? openaiCodexOAuth.login({ signal: controller.signal, prompt: async () => "device_code", notify: () => {} })
			: (kind === "codex" ? openaiCodexOAuth : openaiChatGPTOAuth).refresh(credential, controller.signal);
	const observed = work.catch((error) => error as Error);
	try {
		await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 300 });
		expect(await observed).toBeInstanceOf(Error);
	} finally {
		controller.abort();
		if (!cancelled) stream?.error(new Error("cleanup"));
		await observed;
	}
});

// PR #131 P2-10: native headers and trickling bodies have one absolute deadline.
it.each(["chatgpt", "codex", "device"])("deadlines %s header resolution", async (kind) => {
	vi.useFakeTimers();
	let signal: AbortSignal | null | undefined;
	vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
		signal = init?.signal;
		return new Promise<Response>((_resolve, reject) =>
			signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
		);
	});
	const controller = new AbortController();
	const work =
		kind === "device"
			? openaiCodexOAuth.login({ signal: controller.signal, prompt: async () => "device_code", notify: () => {} })
			: (kind === "codex" ? openaiCodexOAuth : openaiChatGPTOAuth).refresh(credential, controller.signal);
	const observed = work.catch((error) => error as Error);
	try {
		await vi.advanceTimersByTimeAsync(30_001);
		expect(signal?.aborted).toBe(true);
	} finally {
		controller.abort();
		await observed;
	}
});

const model: ClassifierModel<"llama-cpp-classify"> = {
	type: "classifier",
	id: "bounds",
	name: "bounds",
	api: "llama-cpp-classify",
	provider: "llama.cpp",
	baseUrl: "http://bounds.test/v1",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
};
// PR #131 P2-10: successful phases cannot restart the classifier's absolute budget.
it("shares one classifier deadline across native phases", async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	const work = classify(
		{ ...model, baseUrl: "http://phases.test/v1" },
		{ state: {}, questions: { pick: { type: "choice", instructions: "Pick", criteria: { a: "", b: "" } } } },
		{
			signal: controller.signal,
			maxRetries: 0,
			fetch: (input, init) =>
				new Promise<Response>((resolve, reject) => {
					const timer = setTimeout(() => {
						const content = String((JSON.parse(String(init?.body)) as { content?: string }).content ?? "");
						resolve(
							Response.json(
								String(input).endsWith("/tokenize")
									? { tokens: [...content].map((char) => char.codePointAt(0)) }
									: { prompt: "prompt" },
							),
						);
					}, 40_000);
					init?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				}),
		},
	);
	let result: Awaited<typeof work> | undefined;
	const observed = work.then((value) => {
		result = value;
	});
	try {
		await vi.advanceTimersByTimeAsync(60_001);
		expect(result?.stopReason).toBe("error");
	} finally {
		controller.abort();
		await observed;
	}
});

// PR #131 P2-10: default classifier operation budget covers native header resolution.
it("deadlines classifier requests when timeout is omitted", async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	const signals: AbortSignal[] = [];
	const work = classify(
		model,
		{ state: {}, questions: { pick: { type: "choice", instructions: "Pick", criteria: { a: "", b: "" } } } },
		{
			signal: controller.signal,
			maxRetries: 0,
			fetch: (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					if (init?.signal) {
						signals.push(init.signal);
						init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					}
				}),
		},
	);
	try {
		await vi.advanceTimersByTimeAsync(60_001);
		expect(signals.length).toBeGreaterThan(0);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
	} finally {
		controller.abort();
		await work;
	}
});
