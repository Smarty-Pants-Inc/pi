import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import * as recovery from "../src/utils/recovery.ts";
import * as retry from "../src/utils/retry.ts";

// pi#280: Durable's lean entry must share the public retry bindings and no-replay rules.
describe("pure recovery retry exports", () => {
	it("retains the same public helper bindings", () => {
		expect(retry.createAssistantStreamObservation).toBe(recovery.createAssistantStreamObservation);
		expect(retry.DEFAULT_MAX_AGENT_RETRY_DELAY_MS).toBe(recovery.DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
		expect(retry.discardPartialReasoning).toBe(recovery.discardPartialReasoning);
		expect(retry.hasAssistantAnswerOutput).toBe(recovery.hasAssistantAnswerOutput);
		expect(retry.hasAssistantOutput).toBe(recovery.hasAssistantOutput);
		expect(retry.isPrematureStreamError).toBe(recovery.isPrematureStreamError);
		expect(retry.isReasoningOnlyPrematureStream).toBe(recovery.isReasoningOnlyPrematureStream);
		expect(retry.isRetryableAssistantError).toBe(recovery.isRetryableAssistantError);
		expect(retry.isRetryableCodexStreamDisconnect).toBe(recovery.isRetryableCodexStreamDisconnect);
		expect(retry.observeAssistantMessage).toBe(recovery.observeAssistantMessage);
		expect(retry.observeAssistantStreamEvent).toBe(recovery.observeAssistantStreamEvent);
		expect(retry.recordThrottledLimitWait).toBe(recovery.recordThrottledLimitWait);
		expect(retry.retryDelayMs).toBe(recovery.retryDelayMs);
		expect(retry.THROTTLED_LIMIT_WAIT_MESSAGE).toBe(recovery.THROTTLED_LIMIT_WAIT_MESSAGE);
		expect(retry.throttledLimitWait).toBe(recovery.throttledLimitWait);
		expect(retry.transferThrottledLimitWait).toBe(recovery.transferThrottledLimitWait);
	});

	it("classifies transient failures without broadening quota or output replay", () => {
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" });
		expect(recovery.isRetryableAssistantError(message)).toBe(true);
		expect(recovery.isRetryableAssistantError({ ...message, stopReason: "aborted" })).toBe(false);
		expect(recovery.isRetryableAssistantError({ ...message, errorMessage: "quota exceeded: 503 overloaded" })).toBe(
			false,
		);
		expect(
			recovery.isRetryableAssistantError({ ...message, content: [{ type: "text", text: "partial answer" }] }),
		).toBe(false);
		expect(
			recovery.isRetryableAssistantError({
				...message,
				diagnostics: [{ type: "provider_limit", timestamp: 0 }],
			}),
		).toBe(false);
	});

	it("shares private wait lineage and bounded delays across both entries", () => {
		const message = fauxAssistantMessage("", { stopReason: "error" });
		const copy = { ...message };
		retry.recordThrottledLimitWait(message, 3);
		recovery.transferThrottledLimitWait(message, copy);
		expect(retry.throttledLimitWait(copy)).toEqual({
			delayMs: 3000,
			waitMessage: recovery.THROTTLED_LIMIT_WAIT_MESSAGE,
		});
		expect(recovery.retryDelayMs({ baseDelayMs: 2000 }, 6)).toBe(60_000);
		expect(recovery.retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 0 }, 6)).toBe(0);
		expect(recovery.retryDelayMs({ baseDelayMs: 2000 }, 1024)).toBe(60_000);
	});
});
