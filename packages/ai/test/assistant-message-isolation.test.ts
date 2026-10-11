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
	// and consumer writes to an earlier event must not reach the result. S3 (smarty-dev#5822)
	// changed the terminal policy: the result is the `done` event's message, not a second snapshot.
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
		expect(done.message.usage).not.toBe(end.partial.usage);

		end.partial.usage.totalTokens = 1000;
		end.partial.content.length = 0;
		const result = await stream.result();
		expect(result).toBe(done.message);
		expect(result.usage.totalTokens).toBe(15);
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

	// T-F6-content-shape: a malformed wire toolcall_end falls back to the block toolcall_start
	// and the deltas built; the published end tool call stays detached from the result.
	it.each([
		["wrong field types", '{"id":5,"arguments":[1]}'],
		["null", "null"],
	])("falls back to the started block for a malformed wire toolCall (%s)", async (_label, wireToolCall) => {
		const stream = streamPiMessages(piModel, context, {
			apiKey: "test-key",
			fetch: sseFetch([
				JSON.stringify({ type: "start" }),
				JSON.stringify({ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "read" }),
				JSON.stringify({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a"}' }),
				`{"type":"toolcall_end","contentIndex":0,"toolCall":${wireToolCall}}`,
				JSON.stringify({ type: "done", reason: "toolUse", usage: wireUsage }),
			]),
		});
		const events = await collect(stream);
		const end = events.find((event) => event.type === "toolcall_end");
		if (end?.type !== "toolcall_end") throw new Error("missing toolcall_end");
		const expected = { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } };
		expect(end.toolCall).toStrictEqual(expected);
		end.toolCall.arguments.path = "consumer";
		const result = await stream.result();
		expect(result.content[0]).toStrictEqual(expected);
		expect(result.content[0]).not.toBe(end.toolCall);
	});

	// T-F6-content-shape counterexample: valid wire fields override the fallback and survive;
	// unknown top-level fields, a foreign type and an own `__proto__` key stay dropped.
	it("keeps valid wire toolCall fields over the fallback", async () => {
		const wireToolCall =
			'{"type":"text","id":"call_2","name":"write","arguments":{"path":"b"},"thoughtSignature":"sig","namespace":"ns","extra":1,"__proto__":{"polluted":true}}';
		const stream = streamPiMessages(piModel, context, {
			apiKey: "test-key",
			fetch: sseFetch([
				JSON.stringify({ type: "start" }),
				JSON.stringify({ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "read" }),
				JSON.stringify({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a"}' }),
				`{"type":"toolcall_end","contentIndex":0,"toolCall":${wireToolCall}}`,
				JSON.stringify({ type: "done", reason: "toolUse", usage: wireUsage }),
			]),
		});
		const events = await collect(stream);
		const result = await stream.result();
		const end = events.find((event) => event.type === "toolcall_end");
		if (end?.type !== "toolcall_end") throw new Error("missing toolcall_end");
		const expected = {
			type: "toolCall",
			id: "call_2",
			name: "write",
			arguments: { path: "b" },
			thoughtSignature: "sig",
			namespace: "ns",
		};
		for (const block of [end.toolCall, result.content[0]]) {
			expect(block).toStrictEqual(expected);
			expect(Object.getPrototypeOf(block)).toBe(Object.prototype);
			expect((block as unknown as { polluted?: unknown }).polluted).toBeUndefined();
		}
	});
});

// pi#159: terminal publication must happen after the stream masks live secrets and sets
// `durationMs`, so the event and the result carry both. S3 (smarty-dev#5822) aligned contracts:
// the projector never changes the producer's object (the copy is masked and timed, not the live
// message), and the result is the terminal event's message (main's final-result alias policy),
// not a separate snapshot. Before S3, S2 asserted the live message was masked and timed in place
// and that result !== event message.
// Duration counterexamples (preset provider duration, timestamp predating the stream,
// late push after completion) are covered in event-stream.test.ts and not repeated here.
describe("assistant message terminal snapshots (pi#159)", () => {
	const secret = "sk-live-secret-value-0123456789";

	function failedMessage(): AssistantMessage {
		return {
			...liveMessage(),
			content: [{ type: "text", text: "partial" }],
			stopReason: "error",
			errorMessage: `401 invalid key ${secret}`,
			deferred: { provider: "radius", modelId: "auto", api: "pi-messages", id: `batch_${secret}` },
			timestamp: Date.now(),
		};
	}

	// pi#159: S3: result === error event message, the masked, timed projection; the producer's object is untouched.
	it("publishes the masked, timed error event message as the result without touching the producer", async () => {
		const stream = new AssistantMessageEventStream([secret]);
		const live = failedMessage();
		const liveDeferred = live.deferred;
		stream.push({ type: "error", reason: "error", error: live });
		const events = await collect(stream);
		const result = await stream.result();
		const event = events.at(-1);
		if (event?.type !== "error") throw new Error("missing error event");

		for (const message of [event.error, result]) {
			expect(message.errorMessage).toBeDefined();
			expect(message.errorMessage).not.toContain(secret);
			expect(message.deferred?.id).toBeDefined();
			expect(message.deferred?.id).not.toContain(secret);
			expect(message.durationMs).toBeTypeOf("number");
		}
		// S3: the projector never changes the producer's object; the published copy is masked and timed.
		expect(live.errorMessage).toContain(secret);
		expect(live.durationMs).toBeUndefined();
		expect(live.deferred).toBe(liveDeferred);
		expect(liveDeferred?.id).toBe(`batch_${secret}`);

		expect(event.error).not.toBe(live);
		expect(result).not.toBe(live);
		expect(result).toBe(event.error);
		expect(result.deferred).not.toBe(liveDeferred);
		expect(result.content).not.toBe(live.content);

		const resultError = result.errorMessage;
		const resultDuration = result.durationMs;
		live.errorMessage = "provider write";
		live.durationMs = -1;
		live.content.push({ type: "text", text: "late" });
		if (liveDeferred) liveDeferred.id = "provider";
		expect(result.errorMessage).toBe(resultError);
		expect(result.durationMs).toBe(resultDuration);
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(result.deferred?.id).not.toBe("provider");
	});

	// pi#159: the same ordering for a done event. S3: result === done event message.
	it("publishes durationMs on the done event message, which is the result, detached from the producer", async () => {
		const stream = new AssistantMessageEventStream([secret]);
		const live: AssistantMessage = { ...liveMessage(), stopReason: "stop", timestamp: Date.now() };
		stream.push({ type: "done", reason: "stop", message: live });
		const events = await collect(stream);
		const result = await stream.result();
		const event = events.at(-1);
		if (event?.type !== "done") throw new Error("missing done event");
		expect(event.message.durationMs).toBeTypeOf("number");
		expect(result).toBe(event.message);
		expect(result).not.toBe(live);
		expect(result.usage).not.toBe(live.usage);
		expect(live.durationMs).toBeUndefined();
		live.usage.totalTokens = 999;
		expect(result.usage.totalTokens).toBe(0);
	});

	// pi#159: end(result) publishes a masked, timed snapshot that later writes to the argument cannot change.
	it("snapshots the end(result) argument after redaction and timing", async () => {
		const stream = new AssistantMessageEventStream([secret]);
		const live = failedMessage();
		stream.end(live);
		const result = await stream.result();
		expect(result).not.toBe(live);
		expect(result.errorMessage).not.toContain(secret);
		expect(result.deferred?.id).not.toContain(secret);
		expect(result.durationMs).toBeTypeOf("number");
		// S3: the copy is timed, the producer's object is not (S2 asserted live.durationMs equal).
		expect(live.durationMs).toBeUndefined();
		expect(live.errorMessage).toContain(secret);
		expect(await collect(stream)).toEqual([]);

		const resultError = result.errorMessage;
		live.errorMessage = "provider write";
		live.durationMs = -1;
		live.content.push({ type: "text", text: "late" });
		live.usage.totalTokens = 999;
		if (live.deferred) live.deferred.id = "provider";
		expect(result.errorMessage).toBe(resultError);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(result.usage.totalTokens).toBe(0);
		expect(result.deferred?.id).not.toBe("provider");
		expect(await stream.result()).toBe(result);
	});
});
