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
		expect(result).not.toHaveProperty("responseId");
		expect(result.rawStopReason).toBe(terminal === "incomplete" ? "unknown" : "failed");
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
	// smarty-dev#3200 / PR #114 round 3: a rejecting observer cannot erase reported generation.
	it.each([
		{ api: "responses", terminal: "failed" },
		{ api: "codex", terminal: "failed" },
		{ api: "responses", terminal: "incomplete" },
		{ api: "codex", terminal: "incomplete" },
		{ api: "responses", terminal: "completed" },
		{ api: "codex", terminal: "completed" },
		{ api: "codex", terminal: "done" },
	])("retains $api $terminal usage when the raw observer rejects", async ({ api, terminal }) => {
		let calls = 0;
		const fetchStub: typeof fetch = async () => {
			calls++;
			return new Response(
				`data: ${JSON.stringify({
					type: `response.${terminal}`,
					sequence_number: 0,
					response: {
						id: "resp_observer_usage",
						status: terminal === "done" ? "completed" : terminal,
						output: [],
						error: { code: "server_error", message: "503 overloaded" },
						usage: {
							input_tokens: 20,
							output_tokens: 1,
							total_tokens: 21,
							input_tokens_details: { cached_tokens: 3 },
							output_tokens_details: { reasoning_tokens: 1 },
						},
					},
				})}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		const onProviderStreamEvent = async () => {
			await Promise.resolve();
			throw new Error("fetch failed");
		};
		const result = await retryAssistantCall(
			async () =>
				api === "codex"
					? streamCodex({ ...model, api: "openai-codex-responses" }, context, {
							apiKey: codexToken,
							transport: "sse",
							fetch: fetchStub,
							onProviderStreamEvent,
						}).result()
					: streamResponses(model, context, {
							apiKey: "local-dummy",
							fetch: fetchStub,
							onProviderStreamEvent,
						}).result(),
			{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
			undefined,
		);
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(api === "codex" ? "oauth_request_failed" : "fetch failed");
		expect(result.content).toEqual([]);
		expect(result).not.toHaveProperty("responseId");
		expect(result.usage).toMatchObject({ input: 17, cacheRead: 3, output: 1, reasoning: 1, totalTokens: 21 });
		expect(result.usage.cost.output).toBeGreaterThan(0);
		expect(isRetryableAssistantError(result)).toBe(false);
	});
	// smarty-dev#3200 / PR #114 round 4: rejecting first nonterminal output must not look like transport failure.
	it.each(
		["responses", "codex"].flatMap((api) =>
			["text", "reasoning-summary", "reasoning-text", "function", "custom"].map((shape) => ({ api, shape })),
		),
	)("does not regenerate after $api observer rejects first $shape output", async ({ api, shape }) => {
		const item =
			shape === "function"
				? { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" }
				: shape === "custom"
					? { type: "custom_tool_call", id: "ct_1", call_id: "call_1", name: "read", input: "" }
					: shape === "text"
						? { type: "message", id: "msg_1", role: "assistant", content: [], status: "in_progress" }
						: { type: "reasoning", id: "rs_1", summary: [] };
		const rejectType =
			shape === "text"
				? "response.output_text.delta"
				: shape === "reasoning-summary"
					? "response.reasoning_summary_text.delta"
					: shape === "reasoning-text"
						? "response.reasoning_text.delta"
						: "response.output_item.added";
		const events = [
			{ type: "response.created", response: { id: "resp_observer", status: "in_progress", output: [] } },
			{ type: "response.output_item.added", output_index: 0, item },
			{
				type: rejectType,
				output_index: 0,
				item_id: item.id,
				content_index: 0,
				summary_index: 0,
				delta: "generated",
			},
		];
		let calls = 0;
		const fetchStub: typeof fetch = async () => {
			calls++;
			return new Response(
				events
					.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
					.join(""),
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		};
		let rejections = 0;
		let observations = 0;
		const rejectAt = shape === "function" || shape === "custom" ? 2 : 3;
		const onProviderStreamEvent = async () => {
			// #5822: the observer now gets an owned notification, not a wire event name.
			if (++observations === rejectAt) {
				rejections++;
				await Promise.resolve();
				throw new Error("fetch failed");
			}
		};
		const result = await retryAssistantCall(
			async () =>
				api === "codex"
					? streamCodex({ ...model, api: "openai-codex-responses" }, context, {
							apiKey: codexToken,
							transport: "sse",
							fetch: fetchStub,
							onProviderStreamEvent,
						}).result()
					: streamResponses(model, context, {
							apiKey: "local-dummy",
							fetch: fetchStub,
							onProviderStreamEvent,
						}).result(),
			{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
			undefined,
		);
		expect(calls).toBe(1);
		expect(rejections).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(api === "codex" ? "oauth_request_failed" : "fetch failed");
		expect(result.usage.output).toBe(0);
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "provider_stream_observer_error" })]),
		);
		expect(isRetryableAssistantError(result)).toBe(false);
	});
});
