import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { isRetryableAssistantError, throttledLimitWait } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	requestOptions: [] as unknown[],
	requestErrors: [] as Error[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (_params: unknown, options: unknown) => {
					mockState.requestOptions.push(options);
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: { content: "ok" } }],
							};
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => {
						const error = mockState.requestErrors.shift();
						if (error) throw error;
						return {
							data: stream,
							response: { status: 200, headers: new Headers() },
						};
					};
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
});

async function consume(options?: { maxRetries?: number; maxRetryDelayMs?: number }) {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test", ...options });
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

describe("openai-completions provider retries", () => {
	beforeEach(() => {
		mockState.requestOptions = [];
		mockState.requestErrors = [];
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("disables SDK retries by default", async () => {
		await consume();
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ maxRetries: 0 })]);
	});

	it("honors provider retries while keeping SDK retries disabled", async () => {
		vi.useFakeTimers();
		mockState.requestErrors = [
			Object.assign(new Error("rate limited"), {
				status: 429,
				headers: new Headers({ "retry-after-ms": "100" }),
			}),
			Object.assign(new Error("server error"), {
				status: 500,
				headers: new Headers({ "retry-after-ms": "100" }),
			}),
		];

		const result = consume({ maxRetries: 2, maxRetryDelayMs: 100 });
		await vi.advanceTimersByTimeAsync(0);
		expect(mockState.requestOptions).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(99);
		expect(mockState.requestOptions).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(mockState.requestOptions).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(99);
		expect(mockState.requestOptions).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		await result;

		expect(mockState.requestOptions).toEqual([
			expect.objectContaining({ maxRetries: 0 }),
			expect.objectContaining({ maxRetries: 0 }),
			expect.objectContaining({ maxRetries: 0 }),
		]);
	});

	it("fails immediately when a provider-requested retry delay exceeds the limit", async () => {
		mockState.requestErrors = [
			Object.assign(new Error("rate limited"), {
				status: 429,
				headers: new Headers({ "retry-after": "277403" }),
			}),
		];

		const result = await consume({ maxRetries: 2, maxRetryDelayMs: 1000 });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Server requested 277403s retry delay (max: 1s)");
		expect(result.errorMessage).toContain("rate limited");
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ maxRetries: 0 })]);
	});

	// smarty-dev#1723: the Node gateway's plan-limit 429. The message with and without the credit URL, so the
	// "billing" text pattern cannot be what stops the retry.
	it.each([
		"Your 5-hour limit is used up. More at 14:32Z, or add credit: https://billing.smartypants.ai/checkout",
		"Your 5-hour limit is used up. More at 14:32Z.",
	])("does not retry the smarty_limit 429 and shows its message as-is: %s", async (message) => {
		// The body the gateway sends; the openai SDK puts `body.error` in `error.error`.
		const body = {
			error: {
				type: "smarty_limit",
				code: "smarty_limit",
				message,
				window: "5h",
				throttled: false,
				resets_at: "2026-09-28T14:32:00Z",
			},
		};
		mockState.requestErrors = [
			Object.assign(new Error(`429 ${message}`), {
				status: 429,
				headers: new Headers({ "retry-after": "1" }),
				error: body.error,
			}),
		];

		const result = await consume({ maxRetries: 2 });

		expect(mockState.requestOptions).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(message);
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	// smarty-net#136: a throttled smarty_limit with a short Retry-After carries a one-shot wait for the agent.
	// The provider itself still makes one request and the generic retry still refuses it.
	it.each([
		{ throttled: true, retryAfter: "10", message: "Flash runs one request at a time.", wait: 10_000 },
		{ throttled: true, retryAfter: "10", message: "", wait: 10_000 },
		{ throttled: true, retryAfter: "30", message: "busy", wait: 30_000 },
		{ throttled: true, retryAfter: "31", message: "busy", wait: undefined },
		{ throttled: true, retryAfter: undefined, message: "busy", wait: undefined },
		{ throttled: true, retryAfter: "2.5", message: "busy", wait: undefined },
		{ throttled: true, retryAfter: "Wed, 21 Oct 2026 07:28:00 GMT", message: "busy", wait: undefined },
		{ throttled: false, retryAfter: "10", message: "Your 5-hour limit is used up.", wait: undefined },
	])(
		"marks the throttled smarty_limit wait only for a short integer Retry-After: %o",
		async ({ throttled, retryAfter, message, wait }) => {
			mockState.requestErrors = [
				Object.assign(new Error(`429 ${message}`), {
					status: 429,
					headers: new Headers(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
					error: { type: "smarty_limit", code: "smarty_limit", message, throttled, window: "5h", resets_at: null },
				}),
			];

			const result = await consume({ maxRetries: 2 });

			expect(mockState.requestOptions).toHaveLength(1);
			expect(result.errorMessage).toBe(message || "smarty_limit");
			expect(isRetryableAssistantError(result)).toBe(false);
			expect(throttledLimitWait(result)).toEqual(
				wait === undefined
					? undefined
					: { delayMs: wait, waitMessage: message || "Flash runs one request at a time" },
			);
		},
	);
});
