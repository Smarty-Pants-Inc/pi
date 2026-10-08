import { describe, expect, it, vi } from "vitest";

// smarty-dev#5443 S2: one isolation contract for published assistant-message state
// (T-C2, T-C2-success-metadata, T-F6-content-shape).

const googleGenAiMock = vi.hoisted(() => ({
	streamChunks: [] as Array<Record<string, unknown>>,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				yield* googleGenAiMock.streamChunks;
			},
		};
	}
	return {
		FinishReason: { STOP: "STOP", MAX_TOKENS: "MAX_TOKENS", OTHER: "OTHER" },
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY", VALIDATED: "VALIDATED" },
		GoogleGenAI,
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });

function liveMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "pi-messages",
		provider: "radius",
		model: "auto",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 1,
	};
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function textOf(event: AssistantMessageEvent): string | undefined {
	if (!("partial" in event)) return undefined;
	const block = event.partial.content[0];
	return block?.type === "text" ? block.text : undefined;
}

const piModel: Model<"pi-messages"> = {
	id: "auto",
	name: "Radius Auto",
	api: "pi-messages",
	provider: "radius",
	baseUrl: "http://pi-messages.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

/** Raw SSE lines, so a test can send JSON that `JSON.stringify` of a literal cannot produce. */
function sseFetch(rawEvents: string[]): typeof fetch {
	return (async () =>
		new Response(rawEvents.map((data) => `data: ${data}\n\n`).join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		})) as typeof fetch;
}

const wireUsage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

describe("assistant message isolation contract", () => {
	// T-C2: each event carries the state at push time, not the live provider object.
	it("publishes an event-time snapshot that later provider writes cannot change", async () => {
		const stream = new AssistantMessageEventStream();
		const output = liveMessage();
		stream.push({ type: "start", partial: output });
		const block = { type: "text" as const, text: "" };
		output.content.push(block);
		stream.push({ type: "text_start", contentIndex: 0, partial: output });
		block.text += "Hel";
		stream.push({ type: "text_delta", contentIndex: 0, delta: "Hel", partial: output });
		block.text += "lo";
		stream.push({ type: "text_delta", contentIndex: 0, delta: "lo", partial: output });
		output.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message: output });

		const events = await collect(stream);
		expect(events.map((event) => ("partial" in event ? event.partial.content.length : -1))).toEqual([0, 1, 1, 1, -1]);
		expect(events.map(textOf)).toEqual([undefined, "", "Hel", "Hello", undefined]);
		for (const event of events) {
			if ("partial" in event) expect(event.partial).not.toBe(output);
		}
	});

	// T-C2: a consumer cannot write into the provider, a later event or the result.
	it("keeps consumer writes out of provider state, later events and the result", async () => {
		const stream = new AssistantMessageEventStream();
		const output = liveMessage();
		stream.push({ type: "start", partial: output });
		const [start] = await Promise.all([stream[Symbol.asyncIterator]().next()]);
		const startEvent = start.value as Extract<AssistantMessageEvent, { type: "start" }>;
		startEvent.partial.content.push({ type: "text", text: "injected" });
		startEvent.partial.usage.totalTokens = 999;
		expect(output.content).toEqual([]);
		expect(output.usage.totalTokens).toBe(0);

		output.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message: output });
		const result = await stream.result();
		expect(result.content).toEqual([]);
		expect(result.usage.totalTokens).toBe(0);
		expect(result).not.toBe(output);
	});

	// T-C2 at the cited provider path (google-generative-ai.ts pushes one live `output`).
	it("isolates Google Generative AI partials across events", async () => {
		googleGenAiMock.streamChunks = [
			{ responseId: "r1", candidates: [{ content: { parts: [{ text: "Hel" }] } }] },
			{ candidates: [{ content: { parts: [{ text: "lo" }] } }] },
			{
				candidates: [{ finishReason: "STOP" }],
				usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
			},
		];
		const events = await collect(
			streamGoogle(getModel("google", "gemini-2.5-flash"), context, { apiKey: "test-api-key" }),
		);
		const deltas = events.filter((event) => event.type === "text_delta");
		expect(deltas.map(textOf)).toEqual(["Hel", "Hello"]);
		const start = events.find((event) => event.type === "start");
		expect(start && "partial" in start ? start.partial.content : undefined).toEqual([]);
		for (const event of deltas) {
			if ("partial" in event) {
				expect(event.partial.stopReason).toBe("pending");
				expect(event.partial.usage.totalTokens).toBe(0);
			}
		}
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type === "done") expect(done.message.usage.totalTokens).toBe(5);
	});

	// T-C2-success-metadata: `done` metadata must not rewrite partials already published,
	// and the published result must not alias the wire usage object.
	it("keeps done metadata out of earlier partials and detaches it from the wire", async () => {
		const stream = streamPiMessages(piModel, context, {
			apiKey: "test-key",
			fetch: sseFetch([
				JSON.stringify({ type: "start" }),
				JSON.stringify({ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "read" }),
				JSON.stringify({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a.txt"}' }),
				JSON.stringify({
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } },
				}),
				JSON.stringify({ type: "done", reason: "toolUse", usage: wireUsage, responseId: "resp_1" }),
			]),
		});
		const events = await collect(stream);
		const end = events.find((event) => event.type === "toolcall_end");
		const done = events.find((event) => event.type === "done");
		if (end?.type !== "toolcall_end" || done?.type !== "done") throw new Error("missing events");
		expect(end.partial.stopReason).toBe("pending");
		expect(end.partial.usage.totalTokens).toBe(0);
		expect(end.partial.responseId).toBeUndefined();
		expect(done.message.usage).toEqual(wireUsage);
		expect(done.message.responseId).toBe("resp_1");

		done.message.usage.cost.total = 1000;
		done.message.content.length = 0;
		const result = await stream.result();
		expect(result.usage.cost.total).toBe(0.3);
		expect(result.content).toHaveLength(1);
	});

	// T-F6-content-shape: pi-messages.ts wrote the untrusted wire tool-call object into the
	// live partial with Object.assign, so wire fields could change the block type, add
	// fields, or replace the block prototype through an own `__proto__` key.
	it("admits only the declared ToolCall shape from a wire toolcall_end", async () => {
		const wireToolCall =
			'{"type":"text","id":"call_1","name":"read","arguments":{"path":"a.txt"},"extra":"untrusted","__proto__":{"polluted":true}}';
		const stream = streamPiMessages(piModel, context, {
			apiKey: "test-key",
			fetch: sseFetch([
				JSON.stringify({ type: "start" }),
				JSON.stringify({ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "read" }),
				`{"type":"toolcall_end","contentIndex":0,"toolCall":${wireToolCall}}`,
				JSON.stringify({ type: "done", reason: "toolUse", usage: wireUsage }),
			]),
		});
		const events = await collect(stream);
		const result = await stream.result();
		const end = events.find((event) => event.type === "toolcall_end");
		if (end?.type !== "toolcall_end") throw new Error("missing toolcall_end");
		const expected = { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } };
		for (const block of [end.toolCall, end.partial.content[0], result.content[0]]) {
			expect(block).toStrictEqual(expected);
			expect(Object.getPrototypeOf(block)).toBe(Object.prototype);
			expect((block as unknown as { polluted?: unknown }).polluted).toBeUndefined();
		}
		expect(result.stopReason).toBe("toolUse");
	});
});
