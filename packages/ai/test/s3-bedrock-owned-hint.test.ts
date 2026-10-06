import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	error: new Error("failure") as Error & { $metadata?: { httpStatusCode: number; requestId: string } },
}));
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
	BedrockRuntimeServiceException: class extends Error {},
	BedrockRuntimeClient: class {
		middlewareStack = { add: () => undefined };
		async send() {
			throw state.error;
		}
	},
	ConverseStreamCommand: class {},
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
}));
vi.mock("openai", () => ({
	default: class {
		responses = {
			create: () => ({
				withResponse: async () => {
					throw Object.assign(new Error("subscription_sharing_usage_limit_exceeded synthetic-private"), {
						status: 429,
						error: { code: "subscription_sharing_usage_limit_exceeded" },
					});
				},
			}),
		};
	},
}));

import { stream } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"bedrock-converse-stream"> = {
	id: "bedrock-test",
	name: "Bedrock",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://provider.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
const env = { AWS_ACCESS_KEY_ID: "fake", AWS_SECRET_ACCESS_KEY: "fake", AWS_PROFILE: "", AWS_REGION: "us-east-1" };
const remedy =
	"Configure a supported Bedrock data retention mode. See https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html";
// smarty-dev#5822 / T-C4: retain the existing recognizer and URL, not provider text or request IDs.
describe("T-C4 owned Bedrock remedy", () => {
	it("keeps the separate owned ChatGPT usage hint and quota replay barrier", async () => {
		const result = await streamResponses(
			{ ...model, api: "openai-responses", provider: "openai", compat: undefined },
			context,
			{ apiKey: "sk-fake", maxRetries: 0 },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result).toHaveProperty("diagnosticHint", "chatgpt_usage");
		expect(result.errorMessage).toContain("Check your ChatGPT usage: https://chatgpt.com/settings/usage");
		expect(JSON.stringify(result)).not.toContain("synthetic-private");
		expect(isRetryableAssistantError(result)).toBe(false);
	});
	it.each([false, true])(
		"preserves the remedy without raw details (old diagnostic mode: %s)",
		async (oauthDiagnostics) => {
			state.error = Object.assign(new Error("data retention mode synthetic-private is unsupported"), {
				name: "ValidationException",
				$metadata: { httpStatusCode: 400, requestId: "synthetic-private" },
			});
			const result = await stream(model, context, { env, cacheRetention: "none", oauthDiagnostics }).result();
			expect(result.stopReason).toBe("error");
			expect(result).toHaveProperty("diagnosticHint", "bedrock_data_retention");
			expect(result.errorMessage).toBe(`provider_request_failed (HTTP 400) ${remedy}`);
			expect(result.diagnostics).toEqual([{ type: "bedrock_response_failure", timestamp: expect.any(Number) }]);
			expect(JSON.stringify(result)).not.toContain("synthetic-private");
			expect(JSON.stringify(result)).not.toContain("ValidationException");
			const repeated = createAssistantMessageEventStream();
			repeated.push({ type: "error", reason: "error", error: result });
			repeated.end();
			expect((await repeated.result()).errorMessage).toBe(result.errorMessage);
			expect(await repeated.result()).toHaveProperty("diagnosticHint", "bedrock_data_retention");
		},
	);
	it("does not assign a retention hint to generic validation failure", async () => {
		state.error = Object.assign(new Error("schema mismatch synthetic-private"), {
			name: "ValidationException",
			$metadata: { httpStatusCode: 400, requestId: "synthetic-private" },
		});
		const result = await stream(model, context, { env, cacheRetention: "none" }).result();
		expect(result.stopReason).toBe("error");
		expect(result).not.toHaveProperty("diagnosticHint");
		expect(result.errorMessage).toBe("provider_request_failed (HTTP 400)");
		expect(JSON.stringify(result)).not.toContain("synthetic-private");
	});
});
