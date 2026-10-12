// pi#202 round 2 P1-C and P1-D (smarty-dev#5822): raw provider fields stay private. A credential-shaped value and
// a plain environment value that no pattern can match are planted in each raw field: the provider message, body,
// parsed error, OpenRouter `metadata.raw`, finish reason, and an observer's thrown value with its cause. None may
// appear in the published message (the UI text), its JSON (the session entry), the events or the thrown error.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { formatProviderError, normalizeProviderError } from "../src/utils/error-body.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { notifyProviderStreamEvent } from "../src/utils/provider-observation.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const CREDENTIAL = "sk-or-v1-synthetic5822roundtwoCCCCCCCCCCCCCCCCCCCC";
const PLAIN_ENV = "corp-eu-west-7-tenant-plum";
const PRIVATE = [CREDENTIAL, PLAIN_ENV];
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

function model<TApi extends "openai-completions" | "mistral-conversations">(api: TApi): Model<TApi> {
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

async function collect(
	stream: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> },
): Promise<{ result: AssistantMessage; published: string }> {
	const events: string[] = [];
	for await (const event of stream) events.push(JSON.stringify(event));
	const result = await stream.result();
	return { result, published: [result.errorMessage ?? "", JSON.stringify(result), ...events].join("\n") };
}

function expectPrivate(published: string): void {
	for (const value of PRIVATE) expect(published).not.toContain(value);
}

function sse(chunks: unknown[]): Response {
	return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("P1-C: raw provider fields stay private (smarty-dev#5822)", () => {
	it("Completions: message, body and OpenRouter metadata.raw never reach the published message", async () => {
		const body = {
			error: {
				message: `denied for ${PLAIN_ENV} with ${CREDENTIAL}`,
				code: PLAIN_ENV,
				metadata: { raw: `upstream ${CREDENTIAL} ${PLAIN_ENV}` },
			},
		};
		const { result, published } = await collect(
			streamCompletions(model("openai-completions"), context, {
				apiKey: "k",
				maxRetries: 0,
				fetch: async () => Response.json(body, { status: 403, statusText: PLAIN_ENV }),
			}),
		);
		expect(result.errorMessage).toBe("Provider request failed (403)");
		expectPrivate(published);
	});

	it("Completions: an unknown finish_reason is published as a closed value", async () => {
		const { result, published } = await collect(
			streamCompletions(model("openai-completions"), context, {
				apiKey: "k",
				fetch: async () =>
					sse([
						{ id: "c", choices: [{ index: 0, delta: { content: "x" } }] },
						{ id: "c", choices: [{ index: 0, delta: {}, finish_reason: `${PLAIN_ENV}_${CREDENTIAL}` }] },
					]),
			}),
		);
		expect(result.rawStopReason).toBe("other");
		expect(result.errorMessage).toBe("Provider finish_reason: other");
		expectPrivate(published);
	});

	it("Mistral: status code and body never reach the published message", async () => {
		const { result, published } = await collect(
			streamMistral(model("mistral-conversations"), context, {
				apiKey: "k",
				fetch: async () =>
					new Response(`{"message":"tenant ${PLAIN_ENV} key ${CREDENTIAL}"}`, {
						status: 401,
						statusText: PLAIN_ENV,
					}),
			}),
		);
		expect(result.errorMessage).toBe("Mistral API error (401)");
		expectPrivate(published);
	});

	it("formatProviderError never renders a provider message, body or parsed error", () => {
		const error = Object.assign(new Error(`${CREDENTIAL} ${PLAIN_ENV}`), {
			status: 500,
			body: `${CREDENTIAL} ${PLAIN_ENV}`,
			error: { detail: PLAIN_ENV },
		});
		const norm = normalizeProviderError(error, "custom-5822", `${CREDENTIAL} ${PLAIN_ENV}`);
		expectPrivate(`${formatProviderError(norm)}\n${JSON.stringify(norm)}`);
	});

	it("the projector publishes rawStopReason only from the closed list", async () => {
		const stream = createAssistantMessageEventStream();
		stream.end({
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
			stopReason: "stop",
			rawStopReason: `${PLAIN_ENV}.${CREDENTIAL}`,
			timestamp: Date.now(),
		});
		const result = await stream.result();
		expect(result.rawStopReason).toBe("other");
		expectPrivate(JSON.stringify(result));
	});
});

describe("P1-D: observer rejections keep no thrown value (smarty-dev#5822)", () => {
	it("the wrapper error, its cause and its stack do not contain the observer's values", async () => {
		const output = { diagnostics: undefined } as unknown as AssistantMessage;
		let thrown: unknown;
		try {
			await notifyProviderStreamEvent(
				{
					onProviderStreamEvent: () => {
						throw new Error(`observer ${CREDENTIAL} ${PLAIN_ENV}`, {
							cause: { key: CREDENTIAL, env: PLAIN_ENV },
						});
					},
				},
				output,
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		const error = thrown as Error;
		expect(error.message).toBe("Provider stream observer failed");
		expect(error.cause).toBeUndefined();
		expectPrivate(`${inspect(error, { depth: 10 })}\n${String(error.stack)}\n${JSON.stringify(error)}`);
	});
});
