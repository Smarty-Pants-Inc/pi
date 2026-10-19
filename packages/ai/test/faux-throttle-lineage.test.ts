import { describe, expect, it } from "vitest";
import { createModels } from "../src/models.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";
import type { AssistantMessage } from "../src/types.ts";
import { recordedThrottledLimitWait } from "../src/utils/recovery.ts";
import { recordThrottledLimitWait, THROTTLED_LIMIT_WAIT_MESSAGE, throttledLimitWait } from "../src/utils/retry.ts";

const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };

describe.each(["supplied", "missing"] as const)("faux throttle lineage with %s usage", (usage) => {
	// #3155: usage estimation must retain private waits without deriving them from public fields.
	it.each(["recorded throttle", "unrecorded throttle", "ordinary response"] as const)(
		"preserves the expected wait for a %s through complete",
		async (kind) => {
			const ordinary = kind === "ordinary response";
			let scripted = fauxAssistantMessage(ordinary ? "done" : "", {
				stopReason: ordinary ? "stop" : "error",
				...(ordinary ? {} : { errorMessage: THROTTLED_LIMIT_WAIT_MESSAGE }),
				timestamp: 1,
			});
			if (!ordinary) scripted.diagnostics = [{ type: "provider_limit", timestamp: 1 }];
			if (usage === "supplied") {
				scripted.usage = {
					input: 99,
					output: 88,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 187,
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
				};
			} else {
				const { usage: _usage, ...withoutUsage } = scripted;
				// Exercise cloneMessage's fallback for a scripted response without runtime usage.
				scripted = withoutUsage as AssistantMessage;
			}
			if (kind === "recorded throttle") recordThrottledLimitWait(scripted, 0);

			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			faux.setResponses([scripted]);
			const result = await models.complete(faux.getModel(), context);

			expect(result).not.toBe(scripted);
			expect(result.stopReason).toBe(ordinary ? "stop" : "error");
			expect(result.content).toEqual(scripted.content);
			expect(result.errorMessage).toBe(scripted.errorMessage);
			expect(result.api).toBe(faux.api);
			expect(result.provider).toBe(faux.provider.id);
			expect(result.model).toBe(faux.getModel().id);
			expect(result.usage).toEqual({
				input: 3,
				output: ordinary ? 1 : 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: ordinary ? 4 : 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			});
			expect(recordedThrottledLimitWait(result)).toBe(kind === "recorded throttle" ? 0 : undefined);
			expect(throttledLimitWait(result)).toEqual(
				kind === "recorded throttle" ? { delayMs: 0, waitMessage: THROTTLED_LIMIT_WAIT_MESSAGE } : undefined,
			);
			expect(Object.getOwnPropertySymbols(result)).toEqual([]);
			expect(result).not.toHaveProperty("retryAfterSeconds");
			expect(result).not.toHaveProperty("throttledLimitWait");
			expect(result).not.toHaveProperty("waitMessage");
			expect(faux.state.callCount).toBe(1);
			expect(faux.getPendingResponseCount()).toBe(0);
		},
	);
});
