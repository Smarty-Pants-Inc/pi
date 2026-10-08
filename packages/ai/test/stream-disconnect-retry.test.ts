import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "../src/providers/faux.ts";
import {
	discardPartialReasoning,
	hasAssistantOutput,
	isPrematureStreamError,
	isRetryableAssistantError,
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

	it.each([`billing: ${disconnect}`, `insufficient_quota: ${disconnect}`])(
		"retains permanent-error exclusions: %s",
		(errorMessage) => {
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
		},
	);
});
