// pi#202 round 3 P1-E and P1-F (smarty-dev#5822): provider-origin errors publish owned text only.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { ProviderDataError } from "../src/utils/error-body.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const CREDENTIAL = "sk-ant-api03-synthetic5822roundthreeDDDDDDDDDDDDDD";
const PLAIN_ENV = "corp-eu-west-7-tenant-plum";
const PLANTED = `${PLAIN_ENV} ${CREDENTIAL}`;
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
// Synthetic token; all provider requests use local fetch stubs.
const codexToken = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local-test" } })).toString("base64")}.test`;

function model<TApi extends string>(api: TApi, provider = "custom-5822"): Model<TApi> {
	return {
		id: "test-model",
		name: "Test model",
		provider,
		api,
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function sse(events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

async function collect(stream: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }) {
	const published: string[] = [];
	for await (const event of stream) published.push(JSON.stringify(event));
	const result = await stream.result();
	published.push(result.errorMessage ?? "", JSON.stringify(result));
	expectPrivate(published.join("\n"));
	expect(result.stopReason).toBe("error");
	return result;
}

function expectPrivate(text: string): void {
	expect(text).not.toContain(CREDENTIAL);
	expect(text).not.toContain(PLAIN_ENV);
}

describe("P1-E: provider text never reaches errorMessage (smarty-dev#5822)", () => {
	it("pi-messages: the wire error event's errorMessage", async () => {
		const result = await collect(
			streamPiMessages(model("pi-messages"), context, {
				apiKey: "k",
				fetch: async () => sse([{ type: "start" }, { type: "error", reason: "error", errorMessage: PLANTED }]),
			}),
		);
		expect(result.errorMessage).toBe("Provider request failed");
	});

	it("Anthropic: a non-2xx error message and type", async () => {
		const result = await collect(
			streamAnthropic(model("anthropic-messages"), context, {
				apiKey: "k",
				maxRetries: 0,
				fetch: async () =>
					Response.json({ type: "error", error: { type: PLAIN_ENV, message: PLANTED } }, { status: 400 }),
			}),
		);
		expect(result.errorMessage).toBe("Anthropic API error (400)");
	});

	it.each([
		[
			"an SSE error event",
			`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: PLANTED } })}\n\n`,
		],
		["an unparsable SSE event", `event: message_start\ndata: {"type":"message_start", ${PLANTED}\n\n`],
		[
			"an unknown stop reason",
			[
				{
					type: "message_start",
					message: { id: "m", model: "test-model", usage: { input_tokens: 1, output_tokens: 0 } },
				},
				{ type: "message_delta", delta: { stop_reason: PLANTED }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]
				.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
				.join(""),
		],
		[
			"a refusal explanation",
			[
				{
					type: "message_start",
					message: { id: "m", model: "test-model", usage: { input_tokens: 1, output_tokens: 0 } },
				},
				{
					type: "message_delta",
					delta: { stop_reason: "refusal", stop_details: { type: "refusal", explanation: PLANTED } },
					usage: { output_tokens: 1 },
				},
				{ type: "message_stop" },
			]
				.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
				.join(""),
		],
	])("Anthropic: %s", async (_name, body) => {
		await collect(
			streamAnthropic(model("anthropic-messages"), context, {
				apiKey: "k",
				maxRetries: 0,
				fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
			}),
		);
	});

	it.each([
		["error event", { type: "error", sequence_number: 1, code: PLAIN_ENV, message: PLANTED }],
		[
			"response.failed",
			{
				type: "response.failed",
				sequence_number: 1,
				response: { id: "r", status: "failed", output: [], error: { code: PLAIN_ENV, message: PLANTED } },
			},
		],
		[
			"response.incomplete reason",
			{
				type: "response.incomplete",
				sequence_number: 1,
				response: { id: "r", status: "incomplete", output: [], incomplete_details: { reason: PLANTED } },
			},
		],
	])("Responses: %s", async (_name, terminal) => {
		await collect(
			streamResponses(model("openai-responses"), context, {
				apiKey: "k",
				fetch: async () =>
					sse([
						{ type: "response.created", sequence_number: 0, response: { id: "r", status: "in_progress" } },
						terminal,
					]),
			}),
		);
	});

	it("Responses: a custom provider label outside the closed form becomes provider", async () => {
		const result = await streamResponses(model("openai-responses", `Tenant ${PLAIN_ENV}`), context, {
			apiKey: "k",
			maxRetries: 0,
			fetch: async () => Response.json({ error: { message: PLANTED } }, { status: 500 }),
		}).result();
		expect(result.errorMessage).toBe("provider API error (500)");
	});
});

describe("P1-F: provider-derived errors remain provider errors by origin (smarty-dev#5822)", () => {
	it.each([
		["SSE error event", () => sse([{ type: "error", code: PLAIN_ENV, message: PLANTED }])],
		[
			"response.failed",
			() =>
				sse([
					{
						type: "response.failed",
						response: { id: "r", status: "failed", error: { code: PLAIN_ENV, message: PLANTED } },
					},
				]),
		],
		[
			"unparsable frame",
			() => new Response(`data: {"type": ${PLANTED}\n\n`, { headers: { "content-type": "text/event-stream" } }),
		],
		[
			"usage limit with a planted plan",
			() =>
				Response.json(
					{ error: { code: "usage_limit_reached", plan_type: PLANTED, message: PLANTED } },
					{ status: 429 },
				),
		],
		["plain HTTP error body", () => Response.json({ error: { message: PLANTED } }, { status: 400 })],
	])("Codex: %s", async (_name, response) => {
		const result = await collect(
			streamCodex(model("openai-codex-responses"), context, {
				apiKey: codexToken,
				transport: "sse",
				maxRetries: 0,
				fetch: async () => response(),
			}),
		);
		expect(result.errorMessage).toBeDefined();
	});

	it("the thrown object, its cause and its stack carry no provider text", async () => {
		const failed = (async function* () {
			yield {
				type: "response.failed",
				sequence_number: 0,
				response: { id: "r", status: "failed", output: [], error: { code: PLAIN_ENV, message: PLANTED } },
			} as never;
		})();
		const output = {
			role: "assistant",
			content: [],
			api: "openai-responses",
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
			stopReason: "pending",
			timestamp: 0,
		} as AssistantMessage;
		let thrown: unknown;
		try {
			await processResponsesStream(failed, output, new AssistantMessageEventStream(), model("openai-responses"));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ProviderDataError);
		const error = thrown as Error;
		expect(error.cause).toBeUndefined();
		expectPrivate(
			`${error.message}\n${String(error.stack)}\n${inspect(error, { depth: 10 })}\n${JSON.stringify(error)}`,
		);
	});

	it("a directly built ProviderDataError keeps its text out of message, stack and inspect", () => {
		const error = new ProviderDataError(PLANTED, 503);
		expect(error.message).toBe("Provider request failed");
		expect(error.status).toBe(503);
		expectPrivate(`${String(error.stack)}\n${inspect(error, { depth: 10 })}\n${JSON.stringify(error)}`);
	});
});
