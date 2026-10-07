// smarty-dev#5443 slice S4: terminal behavior of pi-messages and protected streams.
// T-F6-usage (wire usage bound), T-F6-deferred (deferred.id masking),
// T-F6-error-kind and T-F6-stop (regression matrices).
import { describe, expect, it } from "vitest";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import type { AssistantMessage, AssistantMessageEvent, Model, Usage } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Fetch = (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => Promise<Response>;

const KEY = "sk-live-5443-s4-reflected-secret";
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

const model: Model<"pi-messages"> = {
	id: "auto",
	name: "Auto",
	api: "pi-messages",
	provider: "pi-test",
	baseUrl: "https://pi.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

const usage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 1,
	cacheWrite: 2,
	totalTokens: 18,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Raw SSE body, so the wire can carry JSON that a typed event cannot (1e400, strings, null). */
function sse(lines: string[]): Response {
	return new Response(lines.map((data) => `data: ${data}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function run(fetch: Fetch, apiKey: string | undefined = "k", signal?: AbortSignal) {
	const wire: unknown[] = [];
	const stream = streamPiMessages(model, context, {
		apiKey,
		fetch,
		signal,
		onProviderStreamEvent: (event) => {
			wire.push(event);
		},
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result(), wire };
}

function expectSaneUsage(value: Usage): void {
	const numbers = [
		value.input,
		value.output,
		value.cacheRead,
		value.cacheWrite,
		value.totalTokens,
		value.cost.input,
		value.cost.output,
		value.cost.cacheRead,
		value.cost.cacheWrite,
		value.cost.total,
	];
	for (const n of numbers) {
		expect(typeof n).toBe("number");
		expect(Number.isFinite(n)).toBe(true);
		expect(n).toBeGreaterThanOrEqual(0);
		expect(n).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
	}
	// Two turns added together must stay finite (session totals, footer cost).
	expect(Number.isFinite(value.totalTokens + value.totalTokens)).toBe(true);
	expect(Number.isFinite(value.cost.total + value.cost.total)).toBe(true);
}

describe("T-F6-usage: pi-messages bounds wire usage on terminal events (smarty-dev#5443)", () => {
	const hostile =
		'{"input":-5,"output":"7","cacheRead":1e400,"cacheWrite":null,"totalTokens":1e308,"reasoning":-1,' +
		'"cost":{"input":"0.5","output":-2,"cacheRead":1e400,"cacheWrite":{},"total":1e308},"extra":{"x":1}}';

	it.each([
		["done", `{"type":"done","reason":"stop","usage":${hostile}}`],
		["error", `{"type":"error","reason":"error","usage":${hostile},"errorMessage":"x"}`],
	])("publishes only finite, non-negative, bounded numbers on %s", async (_kind, terminal) => {
		const { result } = await run(async () => sse(['{"type":"start"}', terminal]));
		expectSaneUsage(result.usage);
		expect(result.usage).toEqual({
			...zeroUsage,
			cacheRead: 0,
			totalTokens: Number.MAX_SAFE_INTEGER,
			cost: { ...zeroUsage.cost, total: Number.MAX_SAFE_INTEGER },
		});
		expect(Object.keys(result.usage)).not.toContain("extra");
	});

	it.each([
		["missing", '{"type":"done","reason":"stop"}'],
		["null", '{"type":"done","reason":"stop","usage":null}'],
		["array", '{"type":"done","reason":"stop","usage":[1,2]}'],
		["cost missing", '{"type":"done","reason":"stop","usage":{"input":3}}'],
	])("falls back to zero usage when it is %s", async (_kind, terminal) => {
		const { result } = await run(async () => sse([terminal]));
		expectSaneUsage(result.usage);
		expect(result.usage.cost).toEqual(zeroUsage.cost);
	});

	it("keeps valid usage exactly and does not alias the wire object", async () => {
		const valid = { ...usage, reasoning: 3, cacheWrite1h: 1 };
		const { result, wire } = await run(async () =>
			sse([JSON.stringify({ type: "done", reason: "stop", usage: valid })]),
		);
		expect(result.usage).toEqual(valid);
		const wireUsage = (wire.at(-1) as { usage: Usage }).usage;
		expect(result.usage).not.toBe(wireUsage);
		expect(result.usage.cost).not.toBe(wireUsage.cost);
	});
});

describe("T-F6-stop: pi-messages stop matrix (smarty-dev#5443 regression)", () => {
	it.each(["stop", "length", "toolUse"] as const)(
		"done/%s ends the stream once with a matching stopReason",
		async (reason) => {
			const { events, result } = await run(async () =>
				sse([
					'{"type":"start"}',
					JSON.stringify({ type: "done", reason, usage, responseId: "r1" }),
					// Anything after the terminal event is ignored.
					JSON.stringify({ type: "error", reason: "error", usage, errorMessage: "late" }),
				]),
			);
			const terminals = events.filter((event) => event.type === "done" || event.type === "error");
			expect(terminals).toHaveLength(1);
			expect(events.at(-1)).toMatchObject({ type: "done", reason });
			expect(result.stopReason).toBe(reason);
			expect(result.errorMessage).toBeUndefined();
			expect(result.responseId).toBe("r1");
			expect(result.usage).toEqual(usage);
		},
	);
});

describe("T-F6-error-kind: pi-messages error matrix (smarty-dev#5443 regression)", () => {
	const cases: Array<{
		name: string;
		reason: "error" | "aborted";
		message: RegExp;
		apiKey?: string;
		abort?: boolean;
		fetch: Fetch;
	}> = [
		{
			name: "missing API key",
			reason: "error",
			message: /No API key provided/,
			apiKey: "",
			fetch: async () => sse([]),
		},
		{
			name: "HTTP error status",
			reason: "error",
			message: /503 .*overloaded \(busy\)/,
			fetch: async () =>
				new Response(JSON.stringify({ error: { message: "overloaded", code: "busy" } }), {
					status: 503,
					statusText: "Service Unavailable",
				}),
		},
		{
			name: "network failure",
			reason: "error",
			message: /socket hang up/,
			fetch: async () => {
				throw new Error("socket hang up");
			},
		},
		{
			name: "malformed SSE data",
			reason: "error",
			message: /JSON/,
			fetch: async () => sse(['{"type":"start"}', "{not json"]),
		},
		{
			name: "stream without terminal event",
			reason: "error",
			message: /stream ended without a terminal event/,
			fetch: async () => sse(['{"type":"start"}', '{"type":"text_start","contentIndex":0}']),
		},
		{
			name: "wire error event",
			reason: "error",
			message: /^upstream failed$/,
			fetch: async () =>
				sse([JSON.stringify({ type: "error", reason: "error", usage, errorMessage: "upstream failed" })]),
		},
		{
			name: "wire aborted event",
			reason: "aborted",
			message: /^upstream aborted$/,
			fetch: async () =>
				sse([JSON.stringify({ type: "error", reason: "aborted", usage, errorMessage: "upstream aborted" })]),
		},
		{
			name: "caller abort",
			reason: "aborted",
			message: /abort/i,
			abort: true,
			fetch: async () => {
				throw new DOMException("This operation was aborted", "AbortError");
			},
		},
	];

	it.each(cases)("$name ends with exactly one error/$reason event", async (testCase) => {
		const controller = new AbortController();
		const fetch: Fetch = async (url, init) => {
			if (testCase.abort) controller.abort();
			return testCase.fetch(url, init);
		};
		const { events, result } = await run(fetch, testCase.apiKey ?? "k", controller.signal);
		const terminals = events.filter((event) => event.type === "done" || event.type === "error");
		expect(terminals).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "error", reason: testCase.reason });
		expect(result.stopReason).toBe(testCase.reason);
		expect(result.errorMessage).toMatch(testCase.message);
		expectSaneUsage(result.usage);
	});
});

describe("T-F6-deferred: protected streams mask live secrets in deferred.id (smarty-dev#5443)", () => {
	function deferredMessage(id: string): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "p",
			model: "m",
			usage: zeroUsage,
			stopReason: "deferred",
			deferred: { provider: "p", modelId: "m", api: "openai-responses", id, data: { keep: "me" } },
			timestamp: 1,
		};
	}

	it.each([
		["raw", `batch_1:${KEY}`],
		["URI-encoded", `resp?k=${encodeURIComponent(`Bearer ${KEY}`)}`],
		["base64url", Buffer.from(KEY).toString("base64url")],
	])("masks a %s reflected key in the done event and the result", async (_kind, id) => {
		const stream = new AssistantMessageEventStream([KEY]);
		const message = deferredMessage(id);
		const original = message.deferred;
		stream.push({ type: "done", reason: "deferred", message });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		const published = JSON.stringify({ events, result });
		expect(published).not.toContain(KEY);
		expect(published).not.toContain(encodeURIComponent(KEY));
		expect(published).not.toContain(Buffer.from(KEY).toString("base64url"));
		expect(result.deferred?.id).toContain("***");
		expect(result.deferred?.data).toEqual({ keep: "me" });
		// The provider's own handle object is not rewritten under it.
		expect(original?.id).toBe(id);
	});

	it("masks deferred.id when the stream ends with end(result)", async () => {
		const stream = new AssistantMessageEventStream([KEY]);
		stream.end(deferredMessage(`late-${KEY}`));
		expect((await stream.result()).deferred?.id).toBe("late-***");
	});

	it("keeps an unrelated deferred.id byte for byte", async () => {
		const stream = new AssistantMessageEventStream([KEY]);
		const message = deferredMessage("resp_abc%2F123 token=x");
		const handle = message.deferred;
		stream.push({ type: "done", reason: "deferred", message });
		const result = await stream.result();
		expect(result.deferred).toBe(handle);
		expect(result.deferred?.id).toBe("resp_abc%2F123 token=x");
	});
});
