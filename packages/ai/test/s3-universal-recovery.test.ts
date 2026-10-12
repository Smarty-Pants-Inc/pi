// T-C3 (smarty-dev#5822, S3 of #5443): every source is classified from its original error before any text
// can be suppressed, and the owned decision rides on `AssistantMessage.recovery`. API-key and custom-provider
// sources get the same structured decision OAuth had; retry, overflow and premature-stream checks read it.
import { describe, expect, it } from "vitest";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import type { AssistantMessage, Model, StopReason } from "../src/types.ts";
import { normalizeProviderError } from "../src/utils/error-body.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { isPrematureStreamError, isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const RETRYABLE = { recovery: "retryable", retryable: true };
const OVERFLOW = { recovery: "context_length_exceeded", retryable: false };
const PREMATURE = { recovery: "premature_stream", retryable: true };
const FINAL = { retryable: false };

function model<TApi extends "openai-completions" | "openai-responses" | "pi-messages">(
	api: TApi,
	provider = "custom-5822",
): Model<TApi> {
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

function message(errorMessage: string, provider = "custom-5822", stopReason: StopReason = "error"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider,
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function sse(events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function jsonError(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A model-less stream: the universal fallback must classify before publication. */
async function published(source: AssistantMessage): Promise<AssistantMessage> {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "error", reason: "error", error: source });
	return stream.result();
}

describe("T-C3: universal pre-suppression recovery (smarty-dev#5822)", () => {
	it.each([
		["503 / network retry", "503 Service Unavailable: upstream connect error", RETRYABLE],
		["context overflow", "This model's maximum context length is 8192 tokens", OVERFLOW],
		["premature EOF", "stream ended before message_stop", PREMATURE],
		["quota refusal", "429 insufficient_quota: check your plan and billing details", FINAL],
		// Not overflow. Main's text rule does not outer-retry a bare Bedrock throttle; that behavior is unchanged.
		["Bedrock throttle that says too many tokens", "Throttling error: Too many tokens, please wait", FINAL],
		["Bedrock throttle with retry guidance", "Throttling error: Too many tokens. Try your request again.", RETRYABLE],
	])("model-less stream classifies %s before publication", async (_name, errorMessage, decision) => {
		const result = await published(message(errorMessage));
		expect(result.recovery).toEqual(decision);
		expect(isRetryableAssistantError(result)).toBe(decision.retryable);
		expect(isContextOverflow(result)).toBe(decision === OVERFLOW);
		expect(isPrematureStreamError(result)).toBe(decision === PREMATURE);
	});

	it("classifies Cerebras's bodyless 400 as overflow only for the trusted request provider", async () => {
		const cerebras = normalizeProviderError(Object.assign(new Error(""), { status: 400 }), "cerebras");
		expect(cerebras.recovery).toEqual(OVERFLOW);
		const other = normalizeProviderError(Object.assign(new Error(""), { status: 400 }), "custom-5822");
		expect(other.recovery).toEqual(FINAL);
		expect((await published(message("400 status code (no body)", "cerebras"))).recovery).toEqual(OVERFLOW);
	});

	it.each([
		["Mistral statusCode/body", { statusCode: 503, body: "upstream unavailable" }, RETRYABLE],
		["Bedrock $metadata", { $metadata: { httpStatusCode: 502 } }, RETRYABLE],
		[
			"Bedrock $response body",
			{ $response: { statusCode: 400, body: "input is too long for requested model" } },
			OVERFLOW,
		],
		["openai parsed error body", { status: 400, error: { message: "Prompt is too long" } }, OVERFLOW],
	])("normalizeProviderError classifies the private %s fields", (_name, fields, decision) => {
		const norm = normalizeProviderError(Object.assign(new Error("request failed"), fields), "custom-5822");
		expect(norm.recovery).toEqual(decision);
	});

	it("never treats a numeric error code as an HTTP status", () => {
		const norm = normalizeProviderError(Object.assign(new Error("request failed"), { code: 503 }), "custom-5822");
		expect(norm.status).toBeUndefined();
		expect(norm.recovery).toEqual(FINAL);
	});

	it("an API-key Completions 503 carries a retryable decision and retries into the next success", async () => {
		let requests = 0;
		const result = await retryAssistantCall(
			async () => {
				requests++;
				const failure = requests === 1;
				const output = await streamCompletions(model("openai-completions"), context, {
					apiKey: "k",
					maxRetries: 0,
					fetch: async () =>
						failure
							? jsonError(503, { error: { message: "backend unavailable" } })
							: sse([
									{ id: "c", choices: [{ index: 0, delta: { content: "ok" } }] },
									{ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
								]),
				}).result();
				if (failure) expect(output.recovery).toEqual(RETRYABLE);
				return output;
			},
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
			undefined,
		);
		expect(requests).toBe(2);
		expect(result.stopReason).toBe("stop");
	});

	it("an API-key Completions overflow is a context-overflow decision, not a generic retry", async () => {
		const result = await streamCompletions(model("openai-completions"), context, {
			apiKey: "k",
			maxRetries: 0,
			fetch: async () =>
				jsonError(400, { error: { message: "This model's maximum context length is 8192 tokens" } }),
		}).result();
		expect(result.recovery).toEqual(OVERFLOW);
		expect(isContextOverflow(result)).toBe(true);
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	it("a mid-stream Responses failure is classified before the error is published", async () => {
		const result = await streamResponses(model("openai-responses"), context, {
			apiKey: "k",
			fetch: async () =>
				sse([
					{ type: "response.created", sequence_number: 0, response: { id: "r", status: "in_progress" } },
					{ type: "error", sequence_number: 1, code: "server_error", message: "The server is overloaded" },
				]),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.recovery).toEqual(RETRYABLE);
	});

	it("a pi-messages HTTP failure is classified from status and body for an API key", async () => {
		const result = await streamPiMessages(model("pi-messages"), context, {
			apiKey: "k",
			fetch: async () => jsonError(429, { error: { code: "quota", message: "insufficient_quota" } }),
		}).result();
		expect(result.recovery).toEqual(FINAL);
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	it("a pi-messages premature end is a premature-stream decision", async () => {
		const result = await streamPiMessages(model("pi-messages"), context, {
			apiKey: "k",
			fetch: async () => sse([{ type: "start" }]),
		}).result();
		expect(result.recovery).toEqual(PREMATURE);
	});

	it("keeps the first owned decision across repeated projection", async () => {
		const first = await published(message("503 Service Unavailable"));
		const repeated = await published({ ...first, errorMessage: "Provider request failed" });
		expect(repeated.recovery).toEqual(RETRYABLE);
	});

	it("a direct retryAssistantCall producer gets the decision on its returned message", async () => {
		const result = await retryAssistantCall(
			async () => message("400 invalid request"),
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
			undefined,
		);
		expect(result.recovery).toEqual(FINAL);
	});
});
