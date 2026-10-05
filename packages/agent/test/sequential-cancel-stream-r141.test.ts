import { createAssistantMessageEventStream, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue } from "../src/agent-loop.ts";
import { ToolCallQueue } from "../src/tool-call-queue.ts";
import type { AgentEvent, AgentLoopConfig, AgentTool } from "../src/types.ts";

// PR #141 cut item 2: exported streams own admission cancellation and terminal settlement.
describe("sequential exported stream cancellation", () => {
	for (const continuing of [false, true]) {
		it(`settles ${continuing ? "continue" : "prompt"} with cancelled results without native execution`, async () => {
			const queue = new ToolCallQueue();
			let release!: () => void;
			let admitted!: () => void;
			const reached = new Promise<void>((resolve) => {
				admitted = resolve;
			});
			const blocker = queue.run({ id: "blocker", exclusive: true }, async () => {
				admitted();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			});
			await reached;
			const execute = vi.fn(async () => ({ content: [], details: {} }));
			const tool: AgentTool = {
				name: "synthetic",
				label: "Synthetic",
				description: "Synthetic",
				parameters: Type.Object({}),
				execute,
			};
			const controller = new AbortController();
			const prompt = { role: "user" as const, content: "test", timestamp: 1 };
			const config: AgentLoopConfig = {
				model: {
					id: "synthetic",
					name: "Synthetic",
					api: "faux",
					provider: "faux",
					baseUrl: "https://example.invalid",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
				},
				toolExecution: "sequential",
				toolCallQueue: queue,
				convertToLlm: (messages) => messages as Message[],
			};
			const provider = () => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() =>
					stream.push({
						type: "done",
						reason: "toolUse",
						message: fauxAssistantMessage([{ type: "toolCall", id: "call", name: "synthetic", arguments: {} }], {
							stopReason: "toolUse",
						}),
					}),
				);
				return stream;
			};
			const stream = continuing
				? agentLoopContinue({ messages: [prompt], tools: [tool] }, config, controller.signal, provider)
				: agentLoop([prompt], { messages: [], tools: [tool] }, config, controller.signal, provider);
			const events: AgentEvent[] = [];
			let terminal = false;
			const consuming = (async () => {
				for await (const event of stream) {
					events.push(event);
					if (event.type === "message_end" && event.message.role === "assistant") {
						// Yield once so sequential admission is queued behind the blocker.
						await Promise.resolve();
						controller.abort(new Error("synthetic cancellation"));
						release();
					}
				}
				terminal = true;
			})();
			await blocker;
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(terminal).toBe(true);
			await consuming;
			const results = (await stream.result()).filter((message) => message.role === "toolResult");
			expect(execute).not.toHaveBeenCalled();
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ isError: true, content: [{ type: "text", text: "Operation aborted" }] });
			expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		});
	}
});
