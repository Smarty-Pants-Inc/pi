import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	normalizeContext,
	type RetryPolicy,
	type TranscriptContext,
	Type,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { compact, completeSummarization } from "../src/core/compaction/compaction.ts";

const model: Model<"openai-responses"> = {
	id: "summary-test",
	name: "Summary test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};
const retry: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 0 };
const context = normalizeContext({ systemPrompt: "Summarize", messages: [] });
const eof = "OpenAI Responses stream ended before a terminal response event";

function failure(
	content: AssistantMessage["content"],
	errorMessage: string,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	const response = fauxAssistantMessage(content, { stopReason: "error", errorMessage });
	return {
		...response,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...response.usage, input: 11, output: 9, totalTokens: 20 },
		...overrides,
	};
}

function scriptedStream(responses: AssistantMessage[]) {
	const contexts: TranscriptContext[] = [];
	const requestThinkingLevels: Array<ThinkingLevel | undefined> = [];
	const streamFn = vi.fn<StreamFn>((_model, requestContext, options) => {
		contexts.push(structuredClone(requestContext));
		requestThinkingLevels.push(options?.reasoning);
		const response = responses[Math.min(contexts.length - 1, responses.length - 1)];
		const stream = createAssistantMessageEventStream();
		if (response.stopReason === "pending") {
			throw new Error("Scripted summary response has no terminal stop reason");
		}
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			stream.push({ type: "error", reason: response.stopReason, error: response });
		} else {
			stream.push({ type: "start", partial: response });
			stream.push({ type: "done", reason: response.stopReason, message: response });
		}
		stream.end();
		return stream;
	});
	return { streamFn, contexts, requestThinkingLevels };
}

// smarty-dev#17478: summaries discard failed text/thinking, unlike ordinary assistant turns.
describe("summary-only partial-output retry", () => {
	it.each([
		{ name: "partial text EOF", content: [{ type: "text", text: "FAILED PARTIAL" }], error: eof },
		{
			name: "partial thinking overload",
			content: [{ type: "thinking", thinking: "FAILED PARTIAL", thinkingSignature: "discard-me" }],
			error: "overloaded_error",
		},
		{ name: "partial text overload", content: [{ type: "text", text: "FAILED PARTIAL" }], error: "503 overloaded" },
	] satisfies { name: string; content: AssistantMessage["content"]; error: string }[])(
		"returns only the successful checkpoint after $name",
		async ({ content, error }) => {
			const failed = failure(content, error);
			const success = fauxAssistantMessage("COMPLETE CHECKPOINT");
			const { streamFn, contexts } = scriptedStream([failed, success]);
			const onRetryScheduled = vi.fn();
			const onRetryAttemptStart = vi.fn();
			const onRetryFinished = vi.fn();
			const result = await compact(
				{
					firstKeptEntryId: "keep",
					messagesToSummarize: [{ role: "user", content: "original conversation", timestamp: 1 }],
					turnPrefixMessages: [],
					isSplitTurn: false,
					tokensBefore: 100,
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
					settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
				},
				model,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				streamFn,
				undefined,
				retry,
				{ onRetryScheduled, onRetryAttemptStart, onRetryFinished },
			);
			expect(result.summary).toBe("COMPLETE CHECKPOINT");
			expect(result.usage).toEqual(success.usage);
			expect(result.summary).not.toContain("FAILED PARTIAL");
			expect(contexts).toHaveLength(2);
			expect(contexts[1]).toEqual(contexts[0]);
			expect(JSON.stringify(contexts)).not.toContain("FAILED PARTIAL");
			expect(failed.content).toEqual(content);
			expect(failed.usage.output).toBe(9);
			expect(onRetryScheduled).toHaveBeenCalledWith(1, 2, 0, error);
			expect(onRetryAttemptStart).toHaveBeenCalledOnce();
			expect(onRetryFinished).toHaveBeenCalledWith(true, 1);
		},
	);

	// smarty-dev#17478: the initial history-summary path lowers only its retry request.
	it("retries an xhigh history summary at medium without changing the caller's level", async () => {
		const originalThinkingLevel: ThinkingLevel = "xhigh";
		const failed = failure([{ type: "text", text: "partial history" }], eof);
		const { streamFn, requestThinkingLevels } = scriptedStream([failed, fauxAssistantMessage("COMPLETE HISTORY")]);
		const result = await compact(
			{
				firstKeptEntryId: "keep",
				messagesToSummarize: [{ role: "user", content: "original history", timestamp: 1 }],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
			},
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			originalThinkingLevel,
			streamFn,
			undefined,
			retry,
		);

		expect(result.summary).toBe("COMPLETE HISTORY");
		expect(requestThinkingLevels).toEqual(["xhigh", "medium"]);
		expect(originalThinkingLevel).toBe("xhigh");
	});

	it("preserves the final error, content and usage after exhausting the existing retry loop", async () => {
		const first = failure([{ type: "text", text: "first partial" }], eof);
		const final = failure([{ type: "text", text: "last partial" }], "503 overloaded: final provider detail", {
			usage: { ...first.usage, input: 31, output: 17, totalTokens: 48 },
		});
		const { streamFn } = scriptedStream([first, final]);
		const onRetryFinished = vi.fn();
		const result = await completeSummarization(model, context, {}, streamFn, retry, { onRetryFinished });
		expect(streamFn).toHaveBeenCalledTimes(3);
		expect(result.content).toEqual(final.content);
		expect(result.usage).toEqual(final.usage);
		expect(result.errorMessage).toBe(final.errorMessage);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 2, final.errorMessage);
	});

	it.each([undefined, { ...retry, enabled: false }, { ...retry, maxRetries: 0 }])(
		"keeps partial errors terminal without an enabled retry allowance: %j",
		async (policy) => {
			const failed = failure([{ type: "text", text: "partial" }], eof);
			const { streamFn } = scriptedStream([failed]);
			const result = await completeSummarization(model, context, {}, streamFn, policy);
			expect(result.errorMessage).toBe(eof);
			expect(result.usage).toEqual(failed.usage);
			expect(streamFn).toHaveBeenCalledOnce();
		},
	);

	it.each([
		{ name: "quota", overrides: { errorMessage: "insufficient_quota: overloaded_error" } },
		{ name: "billing", overrides: { errorMessage: "billing: overloaded_error" } },
		{ name: "context", overrides: { errorMessage: "maximum context length exceeded: overloaded_error" } },
		{ name: "abort", overrides: { stopReason: "aborted" } },
		{ name: "length", overrides: { stopReason: "length" } },
		{ name: "permanent request error", overrides: { errorMessage: "400 invalid request" } },
		{
			name: "observer",
			overrides: { diagnostics: [{ type: "provider_stream_observer_error", timestamp: 1 }] },
		},
		{ name: "provider limit", overrides: { diagnostics: [{ type: "provider_limit", timestamp: 1 }] } },
		{
			name: "dedicated Anthropic fallback",
			overrides: { recovery: { recovery: "anthropic_mid_output_fallback", retryable: true } },
		},
		{ name: "owned refusal", overrides: { recovery: { retryable: false } } },
	] satisfies { name: string; overrides: Partial<AssistantMessage> }[])(
		"does not widen $name failures",
		async ({ overrides }) => {
			const failed = failure([{ type: "text", text: "partial" }], "overloaded_error", overrides);
			const { streamFn } = scriptedStream([failed, fauxAssistantMessage("must not be reached")]);
			const onRetryScheduled = vi.fn();
			const result = await completeSummarization(model, context, {}, streamFn, retry, { onRetryScheduled });
			expect(result.stopReason).toBe(failed.stopReason);
			expect(result.errorMessage).toBe(failed.errorMessage);
			expect(result.content).toEqual(failed.content);
			expect(result.usage).toEqual(failed.usage);
			expect(streamFn).toHaveBeenCalledOnce();
			expect(onRetryScheduled).not.toHaveBeenCalled();
		},
	);

	it("does not retry a returned partial tool call", async () => {
		const failed = failure([{ type: "toolCall", id: "partial", name: "write", arguments: {} }], eof);
		const { streamFn } = scriptedStream([failed]);
		const result = await completeSummarization(model, context, {}, streamFn, retry);
		expect(result.content).toEqual(failed.content);
		expect(result.errorMessage).toBe(eof);
		expect(streamFn).toHaveBeenCalledOnce();
	});

	it.each([
		normalizeContext({
			messages: [],
			tools: [{ name: "write", description: "Write", parameters: Type.Object({}) }],
		}),
		normalizeContext({
			messages: [fauxAssistantMessage([{ type: "toolCall", id: "old", name: "write", arguments: {} }])],
		}),
		normalizeContext({
			messages: [
				{ role: "toolResult", toolCallId: "old", toolName: "write", content: [], isError: false, timestamp: 1 },
			],
		}),
	])("does not grant partial-output replay to a tool-bearing context: %j", async (toolContext) => {
		const failed = failure([{ type: "text", text: "partial" }], eof);
		const { streamFn } = scriptedStream([failed]);
		const result = await completeSummarization(model, toolContext, {}, streamFn, retry);
		expect(result.content).toEqual(failed.content);
		expect(result.errorMessage).toBe(eof);
		expect(streamFn).toHaveBeenCalledOnce();
	});

	it("cancels summary backoff without starting another request", async () => {
		const controller = new AbortController();
		const failed = failure([{ type: "thinking", thinking: "partial" }], "overloaded_error");
		const { streamFn } = scriptedStream([failed]);
		const onRetryFinished = vi.fn();
		const result = await completeSummarization(model, context, { signal: controller.signal }, streamFn, retry, {
			onRetryScheduled: () => controller.abort(),
			onRetryFinished,
		});
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBeUndefined();
		expect(result.usage).toEqual(failed.usage);
		expect(streamFn).toHaveBeenCalledOnce();
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1, "overloaded_error");
	});
});
