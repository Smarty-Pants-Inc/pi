// T-C2 (smarty-dev#5822, S3 of #5443): early wire metadata is suppressed without destroying private state.
// Adapters keep `responseId`/`responseModel`/`providerThinkingLevel` on their own private output object; every
// published copy omits them on partials and on failed or aborted results. Events are snapshotted synchronously,
// before the terminal error is awaited, so a later in-place mutation cannot hide an early leak.
import { describe, expect, it } from "vitest";
import { openAICompletionsApi } from "../src/api/openai-completions.lazy.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const SYNTHETIC_ID = "chatcmpl-sk-synthetic-5822-c2-id";
const SYNTHETIC_MODEL = "sk-synthetic-5822-c2-model";
const SYNTHETIC_EFFORT = "sk-synthetic-5822-c2-effort";
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

function model<TApi extends "openai-completions" | "pi-messages">(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test model",
		provider: "custom-5822",
		api,
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

/** First chunk carries synthetic id/model, then text, then the body breaks off with a transport failure. */
function failingCompletionsResponse(): Response {
	const encoder = new TextEncoder();
	const chunk = { id: SYNTHETIC_ID, model: SYNTHETIC_MODEL, choices: [{ index: 0, delta: { content: "hello" } }] };
	let pulls = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pulls++ === 0) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
			else controller.error(new Error("socket hang up"));
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Iterate a stream, serializing every event at the moment it is delivered. */
async function snapshots(stream: AsyncIterable<AssistantMessageEvent>): Promise<string[]> {
	const seen: string[] = [];
	for await (const event of stream) seen.push(JSON.stringify(event));
	return seen;
}

function expectNoWireMetadata(json: string): void {
	for (const value of [SYNTHETIC_ID, SYNTHETIC_MODEL, SYNTHETIC_EFFORT]) expect(json).not.toContain(value);
	for (const key of ["responseId", "responseModel", "providerThinkingLevel"]) expect(json).not.toContain(`"${key}"`);
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "partial" }],
		api: "openai-completions",
		provider: "custom-5822",
		model: "test-model",
		responseId: SYNTHETIC_ID,
		responseModel: SYNTHETIC_MODEL,
		providerThinkingLevel: SYNTHETIC_EFFORT,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("T-C2: no early or failed wire metadata (smarty-dev#5822)", () => {
	it("Completions: the first chunk's id and model reach no partial, error or result", async () => {
		const stream = streamCompletions(model("openai-completions"), context, {
			apiKey: "k",
			maxRetries: 0,
			fetch: async () => failingCompletionsResponse(),
		});
		const seen = await snapshots(stream);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(seen.some((event) => event.includes('"text_delta"'))).toBe(true);
		for (const event of seen) expectNoWireMetadata(event);
		expectNoWireMetadata(JSON.stringify(result));
	});

	it("lazy Completions forwarding publishes the same restrictions", async () => {
		const stream = openAICompletionsApi().stream(model("openai-completions"), context, {
			apiKey: "k",
			maxRetries: 0,
			fetch: async () => failingCompletionsResponse(),
		});
		for (const event of await snapshots(stream)) expectNoWireMetadata(event);
		expectNoWireMetadata(JSON.stringify(await stream.result()));
	});

	it("pi-messages: a wire error's id and effort are not published", async () => {
		const wire = { type: "error", reason: "error", errorMessage: "upstream", responseId: SYNTHETIC_ID };
		const stream = streamPiMessages(model("pi-messages"), context, {
			apiKey: "k",
			fetch: async () =>
				new Response(
					`data: ${JSON.stringify({ type: "start" })}\n\ndata: ${JSON.stringify({ ...wire, providerThinkingLevel: SYNTHETIC_EFFORT })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
		for (const event of await snapshots(stream)) expectNoWireMetadata(event);
		expectNoWireMetadata(JSON.stringify(await stream.result()));
	});

	it("model-less push and end apply partial and failure restrictions, and success keeps metadata", async () => {
		const partialStream = createAssistantMessageEventStream();
		const source = message();
		partialStream.push({ type: "start", partial: source });
		partialStream.end(message());
		expectNoWireMetadata(JSON.stringify(await snapshots(partialStream)));
		expectNoWireMetadata(JSON.stringify(await partialStream.result()));

		const failed = createAssistantMessageEventStream();
		failed.end(message({ stopReason: "aborted" }));
		expectNoWireMetadata(JSON.stringify(await failed.result()));

		// Control: a successful result keeps its receipt (R1 non-goal; dropped by the section 9 slice).
		const succeeded = createAssistantMessageEventStream();
		succeeded.end(message({ stopReason: "stop" }));
		expect((await succeeded.result()).responseId).toBe(SYNTHETIC_ID);
	});

	it("never changes the producer's object, and an early snapshot cannot change later", async () => {
		const stream = createAssistantMessageEventStream();
		const source = message();
		const before = JSON.stringify(source);
		stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: source });
		const iterator = stream[Symbol.asyncIterator]();
		const early = (await iterator.next()).value as Extract<AssistantMessageEvent, { type: "text_delta" }>;
		const earlyJson = JSON.stringify(early);

		// The adapter keeps its private receipt and goes on mutating its own object.
		expect(JSON.stringify(source)).toBe(before);
		(source.content[0] as { text: string }).text += " and more";
		source.usage.output = 99;
		stream.push({ type: "error", reason: "error", error: { ...source, stopReason: "error", errorMessage: "x" } });

		expect(JSON.stringify(early)).toBe(earlyJson);
		expect(early.partial).not.toBe(source);
		expect(source.responseId).toBe(SYNTHETIC_ID);

		// A consumer mutating a published partial cannot reach adapter state.
		(early.partial.content[0] as { text: string }).text = "consumer";
		expect((source.content[0] as { text: string }).text).toBe("partial and more");
	});
});
