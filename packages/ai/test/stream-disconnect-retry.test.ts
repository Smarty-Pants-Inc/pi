import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "../src/providers/faux.ts";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types.ts";
import {
	createAssistantStreamObservation,
	discardPartialReasoning,
	hasAssistantOutput,
	isPrematureStreamError,
	isReasoningOnlyPrematureStream,
	isRetryableAssistantError,
	observeAssistantStreamEvent,
	retryAssistantCall,
} from "../src/utils/retry.ts";

const disconnect = "stream error: stream disconnected before completion: stream closed before response.completed";

// smarty-dev#3200: exact gateway wording and empty encrypted reasoning from the incident.
describe("premature stream retry classification", () => {
	it.each([
		disconnect,
		"stream closed before response.completed",
		"OpenAI Responses stream ended before a terminal response event",
	])("classifies %s as transient with empty reasoning", (errorMessage) => {
		const message = fauxAssistantMessage(
			[{ ...fauxThinking(""), thinkingSignature: "encrypted metadata" }, fauxThinking("")],
			{ stopReason: "error", errorMessage },
		);
		expect(hasAssistantOutput(message)).toBe(false);
		expect(isPrematureStreamError(message)).toBe(true);
		expect(isRetryableAssistantError(message)).toBe(true);
	});

	it.each([
		{ content: [fauxToolCall("write", {})] },
		{ content: [{ type: "text" as const, text: " " }] },
		// smarty-dev#6730: reasoning followed by any answer output or tool call stays final.
		{ content: [fauxThinking("partial"), { type: "text" as const, text: "answer" }] },
		{ content: [fauxThinking("partial"), fauxToolCall("write", {})] },
	])("does not replay output $content", async ({ content }) => {
		let calls = 0;
		const message = await retryAssistantCall(
			async () => {
				calls++;
				return fauxAssistantMessage(content, { stopReason: "error", errorMessage: disconnect });
			},
			{ enabled: true, maxRetries: 2, baseDelayMs: 1 },
			undefined,
		);
		expect(message.stopReason).toBe("error");
		expect(calls).toBe(1);
	});

	// smarty-dev#6730: Luna streams reasoning summaries before its answer.
	it("restarts a reasoning-only close and drops its partial thinking", async () => {
		const partial = fauxAssistantMessage([{ ...fauxThinking("planning"), thinkingSignature: "rs_1" }], {
			stopReason: "error",
			errorMessage: "stream closed before response.completed",
		});
		partial.usage = { ...partial.usage, output: 42 };
		expect(hasAssistantOutput(partial)).toBe(true);
		expect(isRetryableAssistantError(partial)).toBe(true);
		const discarded = discardPartialReasoning(partial);
		expect(discarded.content).toEqual([{ type: "thinking", thinking: "" }]);
		expect(isRetryableAssistantError(discarded)).toBe(true);

		const responses = [partial, fauxAssistantMessage([fauxThinking("fresh"), { type: "text", text: "answer" }])];
		let calls = 0;
		const message = await retryAssistantCall(
			async () => responses[calls++]!,
			{ enabled: true, maxRetries: 2, baseDelayMs: 1 },
			undefined,
		);
		expect(calls).toBe(2);
		expect(message.stopReason).toBe("stop");
		expect(JSON.stringify(message.content)).not.toContain("planning");
	});

	it.each(["400 invalid_request_error: bad input", "503 overloaded"])(
		"keeps the output rule for reasoning-only non-premature errors: %s",
		async (errorMessage) => {
			let calls = 0;
			const message = await retryAssistantCall(
				async () => {
					calls++;
					return fauxAssistantMessage([fauxThinking("partial")], { stopReason: "error", errorMessage });
				},
				{ enabled: true, maxRetries: 2, baseDelayMs: 1 },
				undefined,
			);
			expect(isRetryableAssistantError(message)).toBe(false);
			expect(calls).toBe(1);
		},
	);

	it("does not replay reported output tokens when content is absent", () => {
		const message = fauxAssistantMessage([], { stopReason: "error", errorMessage: disconnect });
		message.usage = { ...message.usage, output: 1 };
		expect(isRetryableAssistantError(message)).toBe(false);
	});

	// smarty-dev#6730: the terminal message can drop what the stream showed; the caller's observation decides.
	describe("stream observation", () => {
		const partial = fauxAssistantMessage([], { stopReason: "pending" });
		const observe = (...events: AssistantMessageEvent[]) =>
			events.reduce(observeAssistantStreamEvent, createAssistantStreamObservation());
		const closed = (content: AssistantMessage["content"], output = 9) => {
			const message = fauxAssistantMessage(content, { stopReason: "error", errorMessage: disconnect });
			message.usage = { ...message.usage, output };
			return message;
		};
		const reasoning = observe(
			{ type: "thinking_start", contentIndex: 0, partial },
			{ type: "thinking_delta", contentIndex: 0, delta: "plan", partial },
		);
		const text = observe(
			{ type: "thinking_delta", contentIndex: 0, delta: "plan", partial },
			{ type: "text_delta", contentIndex: 1, delta: "answer", partial },
		);
		const toolCall = observe(
			{ type: "thinking_delta", contentIndex: 0, delta: "plan", partial },
			{ type: "toolcall_start", contentIndex: 1, partial },
		);

		it("records reasoning, answer text and tool calls", () => {
			expect(reasoning).toEqual({ reasoning: true, answer: false });
			expect(text).toEqual({ reasoning: true, answer: true });
			expect(toolCall).toEqual({ reasoning: true, answer: true });
			expect(observe({ type: "text_start", contentIndex: 0, partial })).toEqual({ reasoning: false, answer: false });
		});

		it.each([
			{ name: "text", observed: text },
			{ name: "tool call", observed: toolCall },
		])("does not replay a streamed $name whose terminal message kept only thinking", ({ observed }) => {
			const message = closed([fauxThinking("plan")]);
			expect(isRetryableAssistantError(message)).toBe(true);
			expect(isRetryableAssistantError(message, observed)).toBe(false);
			expect(isReasoningOnlyPrematureStream(message, observed)).toBe(false);
		});

		it("restarts a reasoning-only stream whose terminal message dropped its content", () => {
			const message = closed([]);
			expect(isRetryableAssistantError(message)).toBe(false);
			expect(isRetryableAssistantError(message, reasoning)).toBe(true);
			expect(isRetryableAssistantError(message, text)).toBe(false);
		});

		it("does not replay observed reasoning on a non-premature error", () => {
			const message = fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 overloaded" });
			expect(isRetryableAssistantError(message)).toBe(true);
			expect(isRetryableAssistantError(message, reasoning)).toBe(false);
		});
	});

	it.each([`billing: ${disconnect}`, `insufficient_quota: ${disconnect}`])(
		"retains permanent-error exclusions: %s",
		(errorMessage) => {
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
		},
	);
});
