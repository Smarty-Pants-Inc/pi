import { describe, expect, it, vi } from "vitest";
import { lazyApi, lazyStream } from "../src/api/lazy.ts";
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

it("keeps a setup failure observed before abort while terminal publication is pending", async () => {
	const controller = new AbortController();
	const response = lazyStream(
		model,
		async () => {
			throw new Error("real setup failure");
		},
		controller.signal,
	);
	// The setup rejection continuation runs first; publication's outer catch runs
	// after this microtask. A later abort must not replace the original failure.
	queueMicrotask(() => controller.abort());
	expect(await response.result()).toMatchObject({
		stopReason: "error",
		errorMessage: "real setup failure",
	});
});

// pi#298 / smarty-dev#14950: settlement, not delayed continuation time, owns the outcome.
it("keeps a lazy setup rejection settled before a synchronous abort", async () => {
	const controller = new AbortController();
	const response = lazyStream(
		model,
		async () => {
			throw new Error("real setup failure settled before abort");
		},
		controller.signal,
	);
	controller.abort();
	expect(await response.result()).toMatchObject({
		stopReason: "error",
		errorMessage: "real setup failure settled before abort",
	});
});

// pi#298 / smarty-dev#14950: a real failure may also be the later abort reason.
it.each(["throw", "reject"] as const)("keeps a setup %s when abort uses the same error", async (settlement) => {
	const controller = new AbortController();
	const failure = new Error("real setup failure settled before abort");
	const response = lazyStream(
		model,
		() => {
			if (settlement === "throw") throw failure;
			return Promise.reject(failure);
		},
		controller.signal,
	);
	controller.abort(failure);
	expect(await response.result()).toMatchObject({
		stopReason: "error",
		errorMessage: failure.message,
	});
	const events = [];
	for await (const event of response) events.push(event);
	expect(events).toMatchObject([{ type: "error", reason: "error", error: { errorMessage: failure.message } }]);
});

// pi#298 / smarty-dev#14950: the inner result race must preserve the same distinction.
it("keeps an inner result rejection when abort uses the same error", async () => {
	const controller = new AbortController();
	const failure = new Error("real inner failure settled before abort");
	const innerResult = Promise.withResolvers<AssistantMessage>();
	const observed = Promise.withResolvers<void>();
	const inner = {
		async *[Symbol.asyncIterator]() {},
		result() {
			observed.resolve();
			return innerResult.promise;
		},
	};
	const response = lazyStream(model, async () => inner, controller.signal);
	await observed.promise;
	innerResult.reject(failure);
	controller.abort(failure);
	expect(await response.result()).toMatchObject({
		stopReason: "error",
		errorMessage: failure.message,
	});
	const events = [];
	for await (const event of response) events.push(event);
	expect(events).toMatchObject([{ type: "error", reason: "error", error: { errorMessage: failure.message } }]);
});

it("keeps an already-completed lazy inner stream across a synchronous abort", async () => {
	const controller = new AbortController();
	const inner = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "completed before abort" }],
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
	inner.push({ type: "done", reason: "stop", message });
	const response = lazyStream(model, async () => inner, controller.signal);
	controller.abort();
	expect(await response.result()).toMatchObject({ stopReason: "stop", content: message.content });
	const events = [];
	for await (const event of response) events.push(event);
	expect(events).toMatchObject([{ type: "done", reason: "stop" }]);
});

it("keeps a setup rejection caused by abort classified as aborted", async () => {
	const controller = new AbortController();
	const setup = Promise.withResolvers<ReturnType<typeof createAssistantMessageEventStream>>();
	const response = lazyStream(model, () => setup.promise, controller.signal);
	controller.abort();
	setup.reject(new Error("setup failed after abort"));
	expect(await response.result()).toMatchObject({
		stopReason: "aborted",
		errorMessage: "Operation aborted",
	});
	const events = [];
	for await (const event of response) events.push(event);
	expect(events).toMatchObject([{ type: "error", reason: "aborted" }]);
});

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
