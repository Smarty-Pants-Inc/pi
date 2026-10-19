// Per-tier provider regression for issues/provider-error-body-passthrough.
//
// Routes a 403-with-body error through the real provider catch path for one
// representative per tier (Success Criterion 7): a body-blind text provider
// (openai-completions), a status-only provider (openai-responses), and a
// body-blind Bedrock provider. Each asserts the resulting errorMessage carries
// the HTTP status as owned text, never the body reason (smarty-dev#5822). The image-provider tier is covered
// by provider-error-body-passthrough.test.ts; the already-correct happy path
// (no double body / no duplicated status) is asserted via the shared helper in
// error-body.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple as streamSimpleBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";

// openai SDK APIError shape: "<status> status code (no body)" message, the
// parsed body kept on `.error`.
class FakeAPIError extends Error {
	status: number;
	error: unknown;
	constructor(status: number, parsedBody: unknown) {
		super(`${status} status code (no body)`);
		this.name = "PermissionDeniedError";
		this.status = status;
		this.error = parsedBody;
	}
}

const bedrockMock = vi.hoisted(() => ({
	sendError: undefined as unknown,
}));

const openaiMock = vi.hoisted(() => ({
	// Default parsed body; individual tests may override before invoking.
	parsedBody: { error: "blocked by gateway WAF" } as unknown,
}));

vi.mock("openai", () => {
	function throwingCreate() {
		const promise = Promise.resolve(undefined) as unknown as { withResponse: () => Promise<never> };
		promise.withResponse = async () => {
			throw new FakeAPIError(403, openaiMock.parsedBody);
		};
		return promise;
	}
	class FakeOpenAI {
		chat = { completions: { create: throwingCreate } };
		responses = { create: throwingCreate };
	}
	return { default: FakeOpenAI };
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		middlewareStack = { add: () => {} };
		send(): Promise<never> {
			return Promise.reject(bedrockMock.sendError);
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { getModel, normalizeContext } from "../src/compat.ts";

const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
});

const completionsModel: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const responsesModel: Model<"openai-responses"> = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

async function drainResult(stream: {
	[Symbol.asyncIterator](): AsyncIterator<unknown>;
	result(): Promise<{ errorMessage?: string; stopReason?: string }>;
}) {
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

describe("provider error body passthrough (per-tier regression)", () => {
	beforeEach(() => {
		openaiMock.parsedBody = { error: "blocked by gateway WAF" };
	});

	// smarty-dev#5822: status is owned text; the body only classifies.
	it("openai-completions (body-blind text) surfaces the status, not the body", async () => {
		const output = await drainResult(streamOpenAICompletions(completionsModel, context, { apiKey: "test" }));

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toBe("Provider request failed (403)");
	});

	it("openai-completions never publishes the OpenRouter metadata.raw extra", async () => {
		openaiMock.parsedBody = {
			message: "Provider returned error",
			code: 403,
			metadata: { raw: "upstream WAF blocked policy XYZ" },
		};

		const output = await drainResult(streamOpenAICompletions(completionsModel, context, { apiKey: "test" }));

		expect(output.errorMessage).toBe("Provider request failed (403)");
		expect(JSON.stringify(output)).not.toContain("upstream WAF blocked policy XYZ");
	});

	it("openai-responses (status-only) keeps the prefix and the status", async () => {
		const output = await drainResult(streamOpenAIResponses(responsesModel, context, { apiKey: "test" }));

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toBe("OpenAI API error (403)");
	});

	it("bedrock (body-blind) surfaces the status instead of Unknown: UnknownError", async () => {
		bedrockMock.sendError = Object.assign(new Error("UnknownError"), {
			name: "UnknownError",
			$metadata: { httpStatusCode: 403 },
			$response: { statusCode: 403, body: '{"message":"blocked by gateway WAF"}' },
		});

		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
		const output = await drainResult(
			streamSimpleBedrock(model, normalizeContext({ messages: context.messages }), {}),
		);

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toBe("Bedrock request failed (403)");
	});

	// smarty-dev#5822 C4: owned label and status, never SDK message or stream body.
	it("bedrock publishes the owned validation label, not the SDK message or a stream body", async () => {
		bedrockMock.sendError = Object.assign(
			new Error(
				"Invocation of model ID anthropic.claude-opus-5 with on-demand throughput isn't supported. Retry with an inference profile.",
			),
			{
				name: "ValidationException",
				$metadata: { httpStatusCode: 400 },
				$response: {
					statusCode: 400,
					body: { pipe: () => undefined, _readableState: { buffer: [], length: 0 } },
				},
			},
		);

		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5");
		const output = await drainResult(
			streamSimpleBedrock(model, normalizeContext({ messages: context.messages }), {}),
		);

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toBe("Validation error (400)");
	});
});
