// T-N5682 (smarty-dev#5822, S3 of #5443): numeric canonicalization cannot bypass deletion.
// Plant numeric credentials in codes and nested diagnostics; rebuild only owned types and local timestamps.
import { describe, expect, it } from "vitest";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { normalizeProviderError } from "../src/utils/error-body.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const KEY = "000123456789012345";
const CANONICAL = Number(KEY);
const EXPONENT = 1.23456789012345e14;
const FORGED_TIMESTAMP = 42;
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

function plantedError(): Error {
	const error = new Error("planted", { cause: { code: CANONICAL } });
	error.name = KEY;
	return Object.assign(error, { code: CANONICAL });
}

function plantedDiagnostics(): unknown[] {
	const nested = { code: CANONICAL, values: [CANONICAL, EXPONENT, KEY, { deeper: [EXPONENT] }] };
	return [
		{ type: "provider_limit", timestamp: FORGED_TIMESTAMP, details: nested, error: plantedError() },
		{ type: "pi_messages_rewrite", timestamp: FORGED_TIMESTAMP, details: { [KEY]: nested } },
		{ type: "anthropic_input_transformations", timestamp: FORGED_TIMESTAMP, thinkingBlocksDropped: EXPONENT },
		{ type: "unknown_type", timestamp: FORGED_TIMESTAMP, details: nested },
	];
}

function message(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "custom-5822",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "500 internal error",
		diagnostics: plantedDiagnostics() as AssistantMessage["diagnostics"],
		timestamp: Date.now(),
	};
}

function expectOwnedDiagnostics(published: unknown, before: number): void {
	const diagnostics = (published as AssistantMessage).diagnostics ?? [];
	for (const diagnostic of diagnostics) {
		expect(Object.keys(diagnostic).every((key) => ["type", "timestamp", "thinkingBlocksDropped"].includes(key))).toBe(
			true,
		);
		expect(diagnostic.timestamp).toBeGreaterThanOrEqual(before);
	}
	expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
		"provider_limit",
		"pi_messages_rewrite",
		"anthropic_input_transformations",
	]);
	// A producer-supplied count is not Pi's count (pi#202 round 2 P1-1).
	expect(diagnostics[2]?.thinkingBlocksDropped).toBeUndefined();
	const json = JSON.stringify(published);
	for (const planted of [KEY, String(CANONICAL), String(EXPONENT), "123456789012345"]) {
		expect(json).not.toContain(planted);
	}
}

describe("T-N5682: numeric values have no diagnostic output path (smarty-dev#5822)", () => {
	it("model-less push rebuilds error diagnostics in the event and the result", async () => {
		const before = Date.now();
		const stream = createAssistantMessageEventStream();
		const events: string[] = [];
		const source = message();
		stream.push({ type: "error", reason: "error", error: source });
		for await (const event of stream) events.push(JSON.stringify(event));
		expectOwnedDiagnostics(JSON.parse(events[0]!).error, before);
		expectOwnedDiagnostics(await stream.result(), before);
	});

	it("model-less end(result) rebuilds diagnostics", async () => {
		const before = Date.now();
		const stream = createAssistantMessageEventStream();
		stream.end(message());
		expectOwnedDiagnostics(await stream.result(), before);
	});

	it("partial events rebuild diagnostics before failure", async () => {
		const before = Date.now();
		const stream = createAssistantMessageEventStream();
		const partial = { ...message(), stopReason: "pending" } as AssistantMessage;
		stream.push({ type: "start", partial });
		const first = (await stream[Symbol.asyncIterator]().next()).value as AssistantMessageEvent;
		expectOwnedDiagnostics(JSON.parse(JSON.stringify(first)).partial, before);
	});

	it("a direct retryAssistantCall producer returns rebuilt diagnostics", async () => {
		const before = Date.now();
		const scheduled: string[] = [];
		const result = await retryAssistantCall(
			async () => ({ ...message(), errorMessage: "400 invalid request" }),
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
			undefined,
			{ onRetryScheduled: (...args) => void scheduled.push(JSON.stringify(args)) },
		);
		expectOwnedDiagnostics(result, before);
		expect(scheduled).toEqual([]);
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	it("a model-bound wire done event publishes only the owned rewrite type", async () => {
		const before = Date.now();
		const model: Model<"pi-messages"> = {
			id: "test-model",
			name: "Test model",
			provider: "custom-5822",
			api: "pi-messages",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4096,
		};
		const rewrite = { code: CANONICAL, values: [EXPONENT, KEY], timestamp: FORGED_TIMESTAMP };
		const result = await streamPiMessages(model, context, {
			apiKey: "k",
			fetch: async () =>
				new Response(`data: ${JSON.stringify({ type: "done", reason: "stop", rewrite })}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				}),
		}).result();
		expect(result.diagnostics).toEqual([{ type: "pi_messages_rewrite", timestamp: expect.any(Number) }]);
		expect(result.diagnostics?.[0]?.timestamp).toBeGreaterThanOrEqual(before);
		expect(JSON.stringify(result)).not.toContain("123456789012345");
	});

	it.each([
		["push", "push"],
		["end", "end"],
	])("drops a producer-supplied thinkingBlocksDropped on %s", async (_name, via) => {
		const stream = createAssistantMessageEventStream();
		const source = message();
		source.diagnostics = [
			{ type: "anthropic_input_transformations", timestamp: FORGED_TIMESTAMP, thinkingBlocksDropped: 4242 },
		];
		if (via === "push") stream.push({ type: "error", reason: "error", error: source });
		else stream.end(source);
		const result = await stream.result();
		expect(result.diagnostics).toEqual([{ type: "anthropic_input_transformations", timestamp: expect.any(Number) }]);
		expect(JSON.stringify(result)).not.toContain("4242");
	});

	it("a numeric error code in 100-599 is never an HTTP status", () => {
		const norm = normalizeProviderError(Object.assign(new Error("failed"), { code: 503 }), "custom-5822");
		expect(norm.status).toBeUndefined();
	});
});
