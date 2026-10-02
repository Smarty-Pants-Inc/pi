import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "../src/providers/faux.ts";
import {
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
		{ content: [fauxThinking("partial")] },
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
