import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { ToolCallQueue } from "../src/tool-call-queue.ts";

// pi#131 / #8935: cancellation before execution still settles an already-started call.
describe("cancelled tool admission", () => {
	it.each(["before", "waiting", "acquired"] as const)("settles once when aborted %s admission", async (when) => {
		const queue = new ToolCallQueue();
		const controller = new AbortController();
		let executions = 0;
		let ends = 0;
		let releaseBlocker = () => {};
		let startedBlocker = () => {};
		const started = new Promise<void>((resolve) => {
			startedBlocker = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			releaseBlocker = resolve;
		});
		const blocker =
			when === "waiting"
				? queue.run({ id: "blocker", exclusive: true }, async () => {
						startedBlocker();
						await blocked;
					})
				: Promise.resolve();
		if (when === "waiting") await started;
		if (when === "before") controller.abort();
		const result = queue.run(
			{ id: "call", exclusive: false, signal: controller.signal },
			async () => {
				executions++;
				return "executed";
			},
			async () => {
				ends++;
				return "aborted";
			},
		);
		if (when !== "before") controller.abort();
		expect(await result).toBe("aborted");
		releaseBlocker();
		await blocker;
		expect(executions).toBe(0);
		expect(ends).toBe(1);
		expect(queue.has("call")).toBe(false);
		expect(await queue.run({ id: "call", exclusive: true }, async () => "next")).toBe("next");
	});

	it("does not mistake an execution or end-observer failure for admission cancellation", async () => {
		const queue = new ToolCallQueue();
		const controller = new AbortController();
		let ends = 0;
		const failure = new Error("end observer failed");
		await expect(
			queue.run(
				{ id: "call", exclusive: false, signal: controller.signal },
				async () => {
					controller.abort();
					throw failure;
				},
				async () => {
					ends++;
				},
			),
		).rejects.toBe(failure);
		expect(ends).toBe(0);
		expect(queue.has("call")).toBe(false);
	});
});

// pi#131: preparation guards belong to the request they prepared, not the next queued turn.
it("delivers queued steering to the aborted provider without re-entering request preparation", async () => {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const signals: boolean[] = [];
	let preparations = 0;
	const agent = new Agent({
		prepareRequest: async (_request, signal) => {
			preparations++;
			signal?.throwIfAborted();
			return undefined;
		},
		streamFn: (_model, context, options) => {
			const aborted = options?.signal?.aborted === true;
			signals.push(aborted);
			if (aborted) expect(context.messages).toContainEqual({ role: "user", content: "steer", timestamp: 2 });
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: { ...message } });
			return stream;
		},
	});
	agent.finishTurn = () => {
		if (signals.length === 1) {
			agent.steer({ role: "user", content: "steer", timestamp: 2 });
			agent.abort();
		}
	};
	await agent.prompt("start");
	expect(signals).toEqual([false, true]);
	expect(preparations).toBe(1);
	expect(agent.hasQueuedMessages()).toBe(false);
});
