import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "../src/providers/faux.ts";
import { isQuotaRefusal, isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";

// smarty-dev#3200: quota recovery belongs to the agent's one-shot path, not the generic retry budget.
describe("quota refusal classification", () => {
	it.each([
		"insufficient_quota",
		'429: {"code":"insufficient_quota","type":"insufficient_quota"}',
		"Quota exceeded",
		"out of budget",
		"Billing limit reached",
		"insufficient_quota: stream disconnected before completion",
	])("detects a pre-output quota refusal without making it transient: %s", (errorMessage) => {
		const message = fauxAssistantMessage([], { stopReason: "error", errorMessage });
		expect(isQuotaRefusal(message)).toBe(true);
		expect(isRetryableAssistantError(message)).toBe(false);
	});

	it.each([
		"401 invalid_api_key",
		"403 forbidden",
		"400 invalid request",
		"GoUsageLimitError: quota exceeded",
		"FreeUsageLimitError: billing",
		"Monthly usage limit reached: quota exceeded",
		"Enable available balance: billing limit reached",
		"503 overloaded",
	])("does not reclassify other failures: %s", (errorMessage) => {
		expect(isQuotaRefusal(fauxAssistantMessage([], { stopReason: "error", errorMessage }))).toBe(false);
	});

	it.each([[{ type: "text" as const, text: "partial" }], [fauxThinking("partial")], [fauxToolCall("write", {})]])(
		"refuses to replay output: %j",
		(content) => {
			expect(
				isQuotaRefusal(fauxAssistantMessage(content, { stopReason: "error", errorMessage: "insufficient_quota" })),
			).toBe(false);
		},
	);

	it("treats empty reasoning metadata as no output, but reported output tokens as output", () => {
		const message = fauxAssistantMessage([{ ...fauxThinking(""), thinkingSignature: "encrypted metadata" }], {
			stopReason: "error",
			errorMessage: "insufficient_quota",
		});
		expect(isQuotaRefusal(message)).toBe(true);
		expect(isQuotaRefusal({ ...message, usage: { ...message.usage, output: 1 } })).toBe(false);
	});

	it("keeps marked plan limits and non-error messages final", () => {
		const message = fauxAssistantMessage([], { stopReason: "error", errorMessage: "quota exceeded" });
		expect(isQuotaRefusal({ ...message, diagnostics: [{ type: "provider_limit", timestamp: 0 }] })).toBe(false);
		expect(isQuotaRefusal({ ...message, stopReason: "aborted" })).toBe(false);
		expect(isQuotaRefusal({ ...message, stopReason: "stop" })).toBe(false);
		expect(isQuotaRefusal({ ...message, errorMessage: undefined })).toBe(false);
	});

	it("does not add a quota retry to summarization or other generic retry callers", async () => {
		let calls = 0;
		const message = await retryAssistantCall(
			async () => {
				calls++;
				return fauxAssistantMessage([], { stopReason: "error", errorMessage: "insufficient_quota" });
			},
			{ enabled: true, maxRetries: 10, baseDelayMs: 0 },
			undefined,
		);
		expect(calls).toBe(1);
		expect(message.errorMessage).toBe("insufficient_quota");
	});
});
