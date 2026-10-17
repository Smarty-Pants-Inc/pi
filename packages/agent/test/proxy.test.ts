import { inspect } from "node:util";
import type { AssistantMessage, AssistantMessageEvent, AssistantRecovery, Model } from "@earendil-works/pi-ai";
import {
	isContextOverflow,
	isRetryableAssistantError,
	normalizeContext,
	retryAssistantCall,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy", () => {
	it("preserves tool-call metadata received only on toolcall_end", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_test|fc_test", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"value":"hello"}' },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: "toolCall",
					id: "call_test|fc_test",
					name: "lookup",
					arguments: { value: "hello" },
					namespace: "dynamic_tools",
				},
			},
			{ type: "done", reason: "toolUse", usage },
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		const endEvent = events.find((event) => event.type === "toolcall_end");

		expect(endEvent).toMatchObject({
			type: "toolcall_end",
			toolCall: { namespace: "dynamic_tools" },
		});
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { value: "hello" },
			namespace: "dynamic_tools",
		});
	});

	// Regression tests for https://github.com/earendil-works/pi/issues/8996
	it("processes terminal metadata when the event is not newline-terminated", async () => {
		const start = `data: ${JSON.stringify({ type: "start" })}\n\n`;
		const done = `data: ${JSON.stringify({ type: "done", reason: "stop", usage, providerThinkingLevel: "high" })}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(start + done, { status: 200 })),
		);

		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.providerThinkingLevel).toBe("high");
	});

	it("emits an error instead of hanging when the stream ends without a terminal event", async () => {
		const body = `data: ${JSON.stringify({ type: "start" })}\n\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connection closed by proxy server");
	});

	// smarty-dev#5822 (pi#202 round 4): a wire `error` event's text stays private; it decides recovery exactly as
	// before, and only owned text is published.
	async function wireError(errorMessage: string, reason: "error" | "aborted" = "error") {
		const proxyEvents = [{ type: "start" }, { type: "error", reason, errorMessage, usage }];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);
		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
		const events: string[] = [];
		for await (const event of stream) events.push(JSON.stringify(event));
		return { events, result: await stream.result() };
	}

	it("keeps a planted wire error text out of the event, the result and the session JSON", async () => {
		const planted = "503 overloaded for corp-eu-west-7-tenant-plum sk-ant-api03-synthetic5822roundfour";
		let thrown: unknown;
		let outcome: Awaited<ReturnType<typeof wireError>> | undefined;
		try {
			outcome = await wireError(planted);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeUndefined();
		const { events, result } = outcome!;
		expect(result.errorMessage).toBe("Proxy error");
		const published = [inspect(result, { depth: 10 }), JSON.stringify(result), ...events].join("\n");
		expect(published).not.toContain("tenant-plum");
		expect(published).not.toContain("synthetic5822");
		// The private text still decided recovery: a transient overload is retried as before.
		expect(result.recovery).toEqual({ recovery: "retryable", retryable: true });
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it.each([
		[
			"overflow",
			"prompt is too long: 300000 tokens > 200000 maximum",
			{ recovery: "context_length_exceeded", retryable: false },
		],
		["quota", "insufficient_quota: billing hard limit", { retryable: false }],
		["premature", "stream ended before message_stop", { recovery: "premature_stream", retryable: true }],
		["unknown", "something else", { retryable: false }],
	] as [string, string, AssistantRecovery][])(
		"classifies a %s wire error privately and publishes owned text",
		async (_name, text, recovery) => {
			const { result } = await wireError(text);
			expect(result.errorMessage).toBe("Proxy error");
			expect(result.recovery).toEqual(recovery);
			expect(isContextOverflow(result)).toBe(recovery.recovery === "context_length_exceeded");
			expect(isRetryableAssistantError(result)).toBe(recovery.retryable);
		},
	);

	it("publishes an aborted wire error with its closed reason", async () => {
		const { result } = await wireError("cancelled by tenant corp-eu-west-7-tenant-plum", "aborted");
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Proxy error (aborted)");
	});

	// smarty-dev#5822 (pi#202 round 3): a non-2xx proxy response publishes its status only, never its error
	// body or status text, which may carry a credential or a plain environment value.
	it("publishes only the status of a non-2xx proxy response", async () => {
		const planted = "corp-eu-west-7-tenant-plum sk-ant-api03-synthetic5822roundthree";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: planted }, { status: 503, statusText: planted })),
		);

		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
		});
		const events: string[] = [];
		for await (const event of stream) events.push(JSON.stringify(event));
		const result = await stream.result();

		expect(result.errorMessage).toBe("Proxy error (503)");
		const published = [JSON.stringify(result), ...events].join("\n");
		expect(published).not.toContain("tenant-plum");
		expect(published).not.toContain("synthetic5822");
	});

	async function collectProxy(signal?: AbortSignal) {
		const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example.com",
			signal,
		});
		const events: string[] = [];
		for await (const event of stream) events.push(JSON.stringify(event));
		return { events, result: await stream.result() };
	}

	// CR-4, smarty-dev#5822 / pi#202: HTTP recovery must survive suppression just like SSE recovery.
	// Keep reason: the private HTTP body is a trust boundary and used to change retry/overflow decisions.
	it.each([
		[429, "insufficient_quota", { retryable: false }],
		[429, "billing hard limit", { retryable: false }],
		[
			400,
			"prompt is too long: 300000 tokens > 200000 maximum",
			{ recovery: "context_length_exceeded", retryable: false },
		],
		[503, "temporarily overloaded", { recovery: "retryable", retryable: true }],
		[429, "too many requests", { recovery: "retryable", retryable: true }],
		[400, "invalid request", { retryable: false }],
	] as [number, string, AssistantRecovery][])(
		"keeps HTTP %s (%s) recovery private through retry and a subsequent normal SSE response",
		async (status, text, recovery) => {
			const planted = "corp-tenant-cr4 sk-synthetic-cr4-private";
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(Response.json({ error: `${text} ${planted}` }, { status, statusText: planted }))
				.mockResolvedValueOnce(
					new Response(`data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`),
				);
			vi.stubGlobal("fetch", fetchMock);
			const outcomes: Awaited<ReturnType<typeof collectProxy>>[] = [];
			const result = await retryAssistantCall(
				async () => {
					const outcome = await collectProxy();
					outcomes.push(outcome);
					return outcome.result;
				},
				{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
				undefined,
			);
			const first = outcomes[0].result;
			expect(first.errorMessage).toBe(`Proxy error (${status})`);
			expect(first.recovery).toEqual(recovery);
			expect(isRetryableAssistantError(first)).toBe(recovery.retryable);
			expect(isContextOverflow(first)).toBe(recovery.recovery === "context_length_exceeded");
			expect(outcomes).toHaveLength(recovery.retryable ? 2 : 1);
			expect(result.stopReason).toBe(recovery.retryable ? "stop" : "error");
			// A refused retry leaves the normal reply for a later request (overflow compaction is caller-owned).
			if (!recovery.retryable) outcomes.push(await collectProxy());
			expect(outcomes[1].result.stopReason).toBe("stop");
			expect(outcomes[1].result.recovery).toBeUndefined();
			expect(fetchMock).toHaveBeenCalledTimes(2);
			const published = outcomes
				.flatMap(({ events, result: message }) => [
					inspect(message, { depth: 10 }),
					JSON.stringify(message),
					...events,
				])
				.join("\n");
			expect(published).not.toContain(planted);
			expect(published).not.toContain(text);
		},
	);

	it("uses the legacy JSON error override rather than combining it with the private status text", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ error: "overloaded" }, { status: 503, statusText: "billing private-status-cr4" }),
			),
		);
		const { events, result } = await collectProxy();
		expect(result.recovery).toEqual({ recovery: "retryable", retryable: true });
		expect([inspect(result), ...events].join("\n")).not.toContain("private-status-cr4");
	});

	it("classifies a private status-text fallback without publishing it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("invalid JSON", { status: 429, statusText: "insufficient_quota private-status-cr4" }),
			),
		);
		const { events, result } = await collectProxy();
		expect(result.errorMessage).toBe("Proxy error (429)");
		expect(result.recovery).toEqual({ retryable: false });
		expect([inspect(result), ...events].join("\n")).not.toContain("private-status-cr4");
	});

	it.each(["missing", "malformed", "read failure"])(
		"keeps HTTP 503 recovery when its private body is %s",
		async (kind) => {
			const planted = "insufficient_quota sk-synthetic-cr4-private";
			const body =
				kind === "missing"
					? null
					: kind === "malformed"
						? `{ invalid JSON ${planted}`
						: new ReadableStream<Uint8Array>({
								start(controller) {
									controller.error(new Error(planted));
								},
							});
			const response = new Response(body, { status: 503 });
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => response),
			);
			const { events, result } = await collectProxy();
			expect(result.errorMessage).toBe("Proxy error (503)");
			expect(result.recovery).toEqual({ recovery: "retryable", retryable: true });
			expect([inspect(result), JSON.stringify(result), ...events].join("\n")).not.toContain(planted);
			expect(response.body?.locked ?? false).toBe(false);
		},
	);

	it("accepts a complete JSON error exactly at the private byte limit", async () => {
		const body = JSON.stringify({ error: "insufficient_quota sk-synthetic-cr4-private" }).padEnd(16 * 1024, " ");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 429 })),
		);
		const { events, result } = await collectProxy();
		expect(result.recovery).toEqual({ retryable: false });
		expect(isRetryableAssistantError(result)).toBe(false);
		expect([inspect(result), ...events].join("\n")).not.toContain("sk-synthetic-cr4-private");
	});

	it.each(["single chunk", "multiple chunks", "UTF-8 bytes"])(
		"discards an oversized private body (%s), cancels it, and keeps status recovery",
		async (kind) => {
			const prefix = JSON.stringify({ error: "insufficient_quota sk-synthetic-cr4-private" });
			const text = kind === "UTF-8 bytes" ? prefix + "é".repeat(9 * 1024) : prefix.padEnd(16 * 1024 + 1, " ");
			const bytes = new TextEncoder().encode(text);
			const cancel = vi.fn(() =>
				kind === "multiple chunks"
					? new Promise<void>(() => {})
					: Promise.reject(new Error("sk-synthetic-cr4-private cancellation")),
			);
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					if (kind === "multiple chunks") {
						controller.enqueue(bytes.slice(0, 8000));
						controller.enqueue(bytes.slice(8000));
					} else controller.enqueue(bytes);
					// Deliberately do not close: the reader must stop at the limit, not wait for EOF.
				},
				cancel,
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(body, { status: 503 })),
			);
			const { events, result } = await collectProxy();
			expect(result.errorMessage).toBe("Proxy error (503)");
			expect(result.recovery).toEqual({ recovery: "retryable", retryable: true });
			expect(cancel).toHaveBeenCalledOnce();
			expect(body.locked).toBe(false);
			expect([inspect(result), ...events].join("\n")).not.toContain("sk-synthetic-cr4-private");
		},
	);

	// #3155 / DELTA-1: the private HTTP trust boundary needs a time bound as well as a byte cap.
	// Pair incomplete bodies with completed JSON, caller cancellation, and a slow normal SSE stream.
	describe("private HTTP body deadline", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it.each(["empty", "small JSON"])(
			"bounds an open %s body without a caller signal and falls back to private status recovery",
			async (kind) => {
				const planted = "sk-synthetic-3155-private";
				let bodyController!: ReadableStreamDefaultController<Uint8Array>;
				let started!: () => void;
				const reading = new Promise<void>((resolve) => {
					started = resolve;
				});
				const cancel = vi.fn(() => new Promise<void>(() => {}));
				const body = new ReadableStream<Uint8Array>(
					{
						start(controller) {
							bodyController = controller;
							if (kind === "small JSON") {
								controller.enqueue(
									new TextEncoder().encode(JSON.stringify({ error: `insufficient_quota ${planted}` })),
								);
							}
						},
						pull() {
							started();
						},
						cancel,
					},
					{ highWaterMark: 0 },
				);
				const fetchMock = vi
					.fn()
					.mockResolvedValueOnce(new Response(body, { status: 429, statusText: `overloaded ${planted}` }))
					.mockResolvedValueOnce(
						new Response(`data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`),
					);
				vi.stubGlobal("fetch", fetchMock);
				const outcome = collectProxy();
				let settled = false;
				void outcome.then(() => {
					settled = true;
				});
				await reading;
				expect(body.locked).toBe(true);
				expect(vi.getTimerCount()).toBe(1);
				await vi.advanceTimersByTimeAsync(4_999);
				expect(settled).toBe(false);
				// A late chunk must not restart the whole-read deadline; complete JSON still needs EOF.
				bodyController.enqueue(new TextEncoder().encode(" "));
				await vi.advanceTimersByTimeAsync(1);
				expect(settled).toBe(true);
				const { events, result } = await outcome;
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toBe("Proxy error (429)");
				expect(result.recovery).toEqual({ recovery: "retryable", retryable: true });
				expect(isRetryableAssistantError(result)).toBe(true);
				expect(events).toHaveLength(1);
				expect(events[0]).toContain('"type":"error"');
				expect(cancel).toHaveBeenCalledOnce();
				expect(body.locked).toBe(false);
				expect(vi.getTimerCount()).toBe(0);
				expect([inspect(result), JSON.stringify(result), ...events].join("\n")).not.toContain(planted);
				const next = await collectProxy();
				expect(next.result.stopReason).toBe("stop");
				expect(next.result.recovery).toBeUndefined();
				expect(fetchMock).toHaveBeenCalledTimes(2);
				expect(vi.getTimerCount()).toBe(0);
			},
		);

		it("classifies completed small JSON before the deadline and clears the timer", async () => {
			const planted = "sk-synthetic-3155-private";
			let bodyController!: ReadableStreamDefaultController<Uint8Array>;
			let started!: () => void;
			const reading = new Promise<void>((resolve) => {
				started = resolve;
			});
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						bodyController = controller;
						controller.enqueue(
							new TextEncoder().encode(JSON.stringify({ error: `insufficient_quota ${planted}` })),
						);
					},
					pull() {
						started();
					},
					cancel,
				},
				{ highWaterMark: 0 },
			);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(body, { status: 429, statusText: `overloaded ${planted}` })),
			);
			const outcome = collectProxy();
			await reading;
			await vi.advanceTimersByTimeAsync(4_999);
			expect(vi.getTimerCount()).toBe(1);
			bodyController.close();
			const { events, result } = await outcome;
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("Proxy error (429)");
			expect(result.recovery).toEqual({ retryable: false });
			expect(isRetryableAssistantError(result)).toBe(false);
			expect(body.locked).toBe(false);
			expect(cancel).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			expect([inspect(result), JSON.stringify(result), ...events].join("\n")).not.toContain(planted);
		});

		it("keeps caller abort terminal and clears the deadline even when cancellation never settles", async () => {
			const controller = new AbortController();
			let started!: () => void;
			const reading = new Promise<void>((resolve) => {
				started = resolve;
			});
			const cancel = vi.fn(() => new Promise<void>(() => {}));
			const body = new ReadableStream<Uint8Array>(
				{
					pull() {
						started();
					},
					cancel,
				},
				{ highWaterMark: 0 },
			);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(body, { status: 429 })),
			);
			const outcome = collectProxy(controller.signal);
			await reading;
			await vi.advanceTimersByTimeAsync(4_999);
			controller.abort("sk-synthetic-3155-private abort reason");
			const { events, result } = await outcome;
			expect(result.stopReason).toBe("aborted");
			expect(result.errorMessage).toBe("Request aborted by user");
			expect(result.recovery).toBeUndefined();
			expect(isRetryableAssistantError(result)).toBe(false);
			expect(cancel).toHaveBeenCalledOnce();
			expect(body.locked).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(result.stopReason).toBe("aborted");
			expect(events).toHaveLength(1);
			expect([inspect(result), ...events].join("\n")).not.toContain("sk-synthetic-3155-private");
		});

		it("does not impose the private HTTP deadline on a normal SSE response", async () => {
			let bodyController!: ReadableStreamDefaultController<Uint8Array>;
			let started!: () => void;
			const reading = new Promise<void>((resolve) => {
				started = resolve;
			});
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						bodyController = controller;
						controller.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'));
					},
					pull() {
						started();
					},
					cancel,
				},
				{ highWaterMark: 0 },
			);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(body, { status: 200 })),
			);
			const outcome = collectProxy();
			let settled = false;
			void outcome.then(() => {
				settled = true;
			});
			await reading;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(settled).toBe(false);
			expect(cancel).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			bodyController.enqueue(
				new TextEncoder().encode(`data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`),
			);
			bodyController.close();
			const { events, result } = await outcome;
			expect(result.stopReason).toBe("stop");
			expect(result.recovery).toBeUndefined();
			expect(events).toHaveLength(2);
			expect(events[0]).toContain('"type":"start"');
			expect(events[1]).toContain('"type":"done"');
			expect(cancel).not.toHaveBeenCalled();
		});
	});

	it("cancels a pending private read with an owned aborted result even when synthetic fetch ignores the signal", async () => {
		const controller = new AbortController();
		let started!: () => void;
		const reading = new Promise<void>((resolve) => {
			started = resolve;
		});
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>(
			{
				pull() {
					started();
				},
				cancel,
			},
			{ highWaterMark: 0 },
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 429 })),
		);
		const outcome = collectProxy(controller.signal);
		await reading;
		controller.abort("sk-synthetic-cr4-private abort reason");
		const { events, result } = await outcome;
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request aborted by user");
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(result.recovery).toBeUndefined();
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
		expect([inspect(result), ...events].join("\n")).not.toContain("sk-synthetic-cr4-private");
	});

	it("does not start a private body read when synthetic fetch returns after cancellation", async () => {
		const controller = new AbortController();
		controller.abort("sk-synthetic-cr4-private abort reason");
		const pull = vi.fn();
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 503 })),
		);
		const { events, result } = await collectProxy(controller.signal);
		expect(result.stopReason).toBe("aborted");
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(pull).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
		expect([inspect(result), ...events].join("\n")).not.toContain("sk-synthetic-cr4-private");
	});

	it("does not mask an unrelated fetch failure as an HTTP failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network error: local transport failure");
			}),
		);
		const { result } = await collectProxy();
		expect(result.errorMessage).toBe("network error: local transport failure");
		// The final AI stream classifies transport errors too, without inventing an HTTP response.
		expect(result.recovery).toEqual({ recovery: "retryable", retryable: true });
		expect(isRetryableAssistantError(result)).toBe(true);
	});
});
