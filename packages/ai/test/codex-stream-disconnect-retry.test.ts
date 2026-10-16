import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "../src/providers/faux.ts";
import type { AssistantMessage } from "../src/types.ts";
import { isRetryableAssistantError, isRetryableCodexStreamDisconnect } from "../src/utils/retry.ts";

const disconnect = "stream error: stream disconnected before completion: stream closed before response.completed";

describe("Codex stream-disconnect retry classification", () => {
	// smarty-dev#11900: Codex may disconnect after emitting partial output, which must be discarded before retry.
	it("recognizes only the exact Codex disconnect wording", () => {
		expect(
			isRetryableCodexStreamDisconnect(
				fauxAssistantMessage([fauxText("partial")], {
					stopReason: "error",
					errorMessage: disconnect,
				}),
			),
		).toBe(true);
		expect(
			isRetryableCodexStreamDisconnect(
				fauxAssistantMessage("partial", {
					stopReason: "error",
					errorMessage: `APIError: ${disconnect} (request id: 123)`,
				}),
			),
		).toBe(true);
		expect(
			isRetryableCodexStreamDisconnect(
				fauxAssistantMessage("partial", {
					stopReason: "error",
					errorMessage: "stream disconnected before completion",
				}),
			),
		).toBe(false);
		expect(
			isRetryableCodexStreamDisconnect(
				fauxAssistantMessage("partial", {
					stopReason: "error",
					errorMessage:
						"stream error: stream disconnected before completion: stream closed before response.complete",
				}),
			),
		).toBe(false);
		expect(
			isRetryableCodexStreamDisconnect(
				fauxAssistantMessage("partial", {
					stopReason: "stop",
					errorMessage: disconnect,
				}),
			),
		).toBe(false);
	});

	// smarty-dev#11900: leave the generic classifier's no-replay default and permanent diagnostics intact.
	it("does not change generic retries or bypass permanent diagnostic exclusions", () => {
		const partial = (diagnostics?: AssistantMessage["diagnostics"]): AssistantMessage => ({
			...fauxAssistantMessage("partial", { stopReason: "error", errorMessage: disconnect }),
			...(diagnostics === undefined ? {} : { diagnostics }),
		});

		const ordinary = partial();
		expect(isRetryableAssistantError(ordinary)).toBe(false);
		expect(isRetryableCodexStreamDisconnect(ordinary)).toBe(true);
		expect(isRetryableCodexStreamDisconnect(partial([{ type: "provider_limit", timestamp: Date.now() }]))).toBe(
			false,
		);
		expect(
			isRetryableCodexStreamDisconnect(partial([{ type: "provider_stream_observer_error", timestamp: Date.now() }])),
		).toBe(false);
		expect(
			isRetryableCodexStreamDisconnect({
				...partial(),
				recovery: { recovery: "retryable", retryable: false },
			}),
		).toBe(false);
		expect(
			isRetryableCodexStreamDisconnect(
				fauxAssistantMessage("partial", {
					stopReason: "error",
					errorMessage: `quota exceeded: ${disconnect}`,
				}),
			),
		).toBe(false);
	});
});
