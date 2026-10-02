import { describe, expect, it } from "vitest";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 0 }] });
const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test model",
	provider: "local-test",
	api: "openai-responses",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
	contextWindow: 100000,
	maxTokens: 4096,
};
// Synthetic, non-secret token: the local fetch stub never contacts an authenticated service.
const codexToken = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local-test" } })).toString("base64")}.test`;

// smarty-dev#3200: exercise terminal SSE -> adapter -> AssistantMessage -> retry classifier.
describe("Responses terminal usage replay barrier", () => {
	it.each([
		{ api: "responses", terminal: "failed", outputTokens: 1 },
		{ api: "codex", terminal: "failed", outputTokens: 1 },
		{ api: "responses", terminal: "incomplete", outputTokens: 1 },
		{ api: "codex", terminal: "incomplete", outputTokens: 1 },
		{ api: "responses", terminal: "failed", outputTokens: 0 },
		{ api: "codex", terminal: "failed", outputTokens: 0 },
	])("retains $api $terminal usage (output_tokens: $outputTokens)", async ({ api, terminal, outputTokens }) => {
		let calls = 0;
		const fetchStub: typeof fetch = async () => {
			calls++;
			return new Response(
				`data: ${JSON.stringify({
					type: `response.${terminal}`,
					sequence_number: 0,
					response: {
						id: "resp_failed_usage",
						status: terminal,
						output: [],
						error: { code: "server_error", message: "503 overloaded" },
						incomplete_details: terminal === "incomplete" ? { reason: "server_error" } : null,
						usage: {
							input_tokens: 20,
							output_tokens: outputTokens,
							total_tokens: 20 + outputTokens,
							input_tokens_details: { cached_tokens: 3 },
							output_tokens_details: { reasoning_tokens: outputTokens },
						},
					},
				})}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		const result = await retryAssistantCall(
			async () =>
				api === "codex"
					? streamCodex({ ...model, api: "openai-codex-responses" }, context, {
							apiKey: codexToken,
							transport: "sse",
							fetch: fetchStub,
						}).result()
					: streamResponses(model, context, { apiKey: "local-dummy", fetch: fetchStub }).result(),
			{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
			undefined,
		);
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
		expect(calls).toBe(outputTokens > 0 ? 1 : 3);
		expect(result.responseId).toBe("resp_failed_usage");
		expect(result.rawStopReason).toBe(terminal === "incomplete" ? "incomplete.server_error" : "failed");
		expect(result.usage).toMatchObject({
			input: 17,
			cacheRead: 3,
			output: outputTokens,
			reasoning: outputTokens,
			totalTokens: 20 + outputTokens,
		});
		expect(result.usage.cost.input).toBeGreaterThan(0);
		expect(isRetryableAssistantError(result)).toBe(outputTokens === 0);
	});
});
