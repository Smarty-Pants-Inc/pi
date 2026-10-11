import { inspect } from "node:util";
import type { AssistantMessage, AssistantMessageEvent, AssistantRecovery, Model } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
