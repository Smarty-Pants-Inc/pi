import { describe, expect, it, vi } from "vitest";
import { lazyApi } from "../src/api/lazy.ts";
import type { AssistantMessage, Model, ProviderStreams } from "../src/types.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "mock",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

// Smarty-Pants-Inc/smarty-dev#14950: a lazy module load is another asynchronous dispatch boundary.
describe.each(["stream", "streamSimple"] as const)("lazyApi.%s cancellation", (method) => {
	it("does not start loading for an already aborted request", async () => {
		const controller = new AbortController();
		controller.abort();
		const load = vi.fn<() => Promise<ProviderStreams>>();
		const result = await lazyApi(load)
			[method](model, normalizeContext({ messages: [] }), { signal: controller.signal })
			.result();
		expect(load).not.toHaveBeenCalled();
		expect(result).toMatchObject({ stopReason: "aborted", errorMessage: "Operation aborted" });
	});

	it.each([false, true].flatMap((abort) => [false, true].map((fail) => ({ abort, fail }))))(
		"abort=$abort load failure=$fail preserves the terminal classification",
		async ({ abort, fail }) => {
			const controller = new AbortController();
			const loaded = Promise.withResolvers<ProviderStreams>();
			const dispatch = vi.fn(() => {
				const response = createAssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				response.push({ type: "done", reason: "stop", message });
				return response;
			});
			const response = lazyApi(() => loaded.promise)[method](model, normalizeContext({ messages: [] }), {
				signal: controller.signal,
			});
			if (abort) controller.abort();
			if (fail) loaded.reject(new Error("module load failed"));
			else loaded.resolve({ stream: dispatch, streamSimple: dispatch });
			const result = await response.result();
			expect(dispatch).toHaveBeenCalledTimes(abort || fail ? 0 : 1);
			expect(result.stopReason).toBe(abort ? "aborted" : fail ? "error" : "stop");
			if (abort) expect(result.errorMessage).toBe("Operation aborted");
			else if (fail) expect(result.errorMessage).toBe("module load failed");
			const events = [];
			for await (const event of response) events.push(event);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject(
				abort ? { type: "error", reason: "aborted" } : { type: fail ? "error" : "done" },
			);
		},
	);
});
