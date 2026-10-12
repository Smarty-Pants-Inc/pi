// T-C1 (smarty-dev#5822, S3 of #5443): provider callbacks run outside the message projector, so they must
// receive only Pi-owned values. Every callback argument is serialized at the moment of the call and compared
// with the exact owned schema; the synthetic credential-shaped values below must never appear.
import { describe, expect, it } from "vitest";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import { createModels } from "../src/models.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";
import type { AssistantMessage, Model, StreamOptions } from "../src/types.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const SYNTHETIC = "sk-synthetic-5822-c1-0123456789abcdef";
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const STREAM_EVENT = [{ type: "provider_stream_event" }];

function model<TApi extends "openai-completions" | "openai-responses" | "pi-messages">(api: TApi): Model<TApi> {
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
		headers: { "x-model-credential": SYNTHETIC },
	};
}

function sse(events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream", "x-upstream-credential": SYNTHETIC, "set-cookie": SYNTHETIC },
	});
}

/** Callbacks that snapshot their arguments immediately, before any later normalization can touch them. */
function capture() {
	const responses: string[] = [];
	const events: string[] = [];
	const options: Pick<StreamOptions, "onResponse" | "onProviderStreamEvent"> = {
		onResponse: (...args: unknown[]) => {
			responses.push(JSON.stringify(args));
		},
		onProviderStreamEvent: (...args: unknown[]) => {
			events.push(JSON.stringify(args));
		},
	};
	return { responses, events, options };
}

function expectOwned(captured: ReturnType<typeof capture>, eventCount: number): void {
	expect(captured.responses.map((args) => JSON.parse(args))).toEqual([[{ status: 200 }]]);
	expect(captured.events.map((args) => JSON.parse(args))).toEqual(
		Array.from({ length: eventCount }, () => STREAM_EVENT),
	);
	expect([...captured.responses, ...captured.events].join("\n")).not.toContain(SYNTHETIC);
}

describe("T-C1: value-free provider callbacks (smarty-dev#5822)", () => {
	it("Responses: an error event and response headers reach callbacks only as owned values", async () => {
		const captured = capture();
		const result = await streamResponses(model("openai-responses"), context, {
			apiKey: "k",
			fetch: async () =>
				sse([
					{ type: "response.created", sequence_number: 0, response: { id: SYNTHETIC, status: "in_progress" } },
					{ type: "error", sequence_number: 1, code: "server_error", message: `upstream echoed ${SYNTHETIC}` },
				]),
			...captured.options,
		}).result();
		expect(result.stopReason).toBe("error");
		expectOwned(captured, 2);
	});

	it("pi-messages: wire events, an error event and gateway headers reach callbacks only as owned values", async () => {
		const captured = capture();
		const result = await streamPiMessages(model("pi-messages"), context, {
			apiKey: "k",
			fetch: async () =>
				sse([
					{ type: "start", gatewayField: SYNTHETIC },
					{ type: "error", reason: "error", errorMessage: `gateway echoed ${SYNTHETIC}`, responseId: SYNTHETIC },
				]),
			...captured.options,
		}).result();
		expect(result.stopReason).toBe("error");
		expectOwned(captured, 2);
	});

	it("Completions: chunks with ids, models and metadata reach callbacks only as owned values", async () => {
		const captured = capture();
		const result = await streamCompletions(model("openai-completions"), context, {
			apiKey: "k",
			fetch: async () =>
				sse([
					{ id: SYNTHETIC, model: SYNTHETIC, choices: [{ index: 0, delta: { content: "hello" } }] },
					{
						id: SYNTHETIC,
						model: SYNTHETIC,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						openrouter_metadata: { echoed: SYNTHETIC },
					},
				]),
			...captured.options,
		}).result();
		expect(result.stopReason).toBe("stop");
		expectOwned(captured, 2);
	});

	it("faux: stream, deferred fetch and cancel callbacks receive only the status", async () => {
		const faux = fauxProvider({ deferred: {} });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("ok")]);
		const fauxModel = faux.getModel();
		const calls: string[] = [];
		const onResponse = (...args: unknown[]) => {
			calls.push(JSON.stringify(args));
		};
		const submitted = await models
			.streamSimple(fauxModel, context, { deferred: { window: "1h" }, onResponse })
			.result();
		if (!submitted.deferred) throw new Error("faux did not defer the response");
		await models.fetchDeferred(fauxModel, submitted.deferred, { wait: 0, onResponse });
		await models.cancelDeferred(fauxModel, submitted.deferred, { onResponse });
		expect(calls.map((args) => JSON.parse(args))).toEqual([[{ status: 200 }], [{ status: 200 }], [{ status: 200 }]]);
	});

	it("an observer rejection is terminal, owned and never regenerated", async () => {
		let requests = 0;
		const result = await retryAssistantCall(
			() => {
				requests++;
				return streamPiMessages(model("pi-messages"), context, {
					apiKey: "k",
					fetch: async () => sse([{ type: "start" }, { type: "done", reason: "stop" }]),
					onProviderStreamEvent: () => {
						throw new Error(`503 overloaded ${SYNTHETIC}`);
					},
				}).result();
			},
			{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
			undefined,
		);
		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.diagnostics?.map((diagnostic) => diagnostic.type)).toContain("provider_stream_observer_error");
		expect(isRetryableAssistantError(result as AssistantMessage)).toBe(false);
		expect(JSON.stringify(result)).not.toContain(SYNTHETIC);
	});
});
