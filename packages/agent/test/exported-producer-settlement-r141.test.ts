import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentTool } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "openai-completions",
	provider: "synthetic",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

// PR #141 cut item 2: fire-and-forget exported producers own all rejection paths, retaining completed outcomes.
describe("exported producer rejection", () => {
	for (const continuing of [false, true]) {
		for (const failure of ["conversion", "finish"] as const) {
			it(`settles ${continuing ? "continue" : "prompt"} after ${failure} rejection`, async () => {
				const execute = vi.fn(async () => ({
					content: [{ type: "text" as const, text: "accepted" }],
					details: { receipt: "synthetic" },
				}));
				const tool: AgentTool = {
					name: "synthetic",
					label: "Synthetic",
					description: "Synthetic",
					parameters: Type.Object({}),
					execute,
				};
				const prompt = { role: "user" as const, content: "test", timestamp: 1 };
				const config: AgentLoopConfig = {
					model,
					toolExecution: "sequential",
					convertToLlm: (messages) => {
						if (failure === "conversion") throw new Error("synthetic conversion failure");
						return messages as Message[];
					},
					finishTurn: () => {
						throw new Error("synthetic completion failure");
					},
				};
				const provider = () => {
					const stream = createAssistantMessageEventStream();
					stream.push({
						type: "done",
						reason: "toolUse",
						message: fauxAssistantMessage([{ type: "toolCall", id: "call", name: "synthetic", arguments: {} }], {
							stopReason: "toolUse",
						}),
					});
					return stream;
				};
				const stream = continuing
					? agentLoopContinue({ messages: [prompt], tools: [tool] }, config, undefined, provider)
					: agentLoop([prompt], { messages: [], tools: [tool] }, config, undefined, provider);
				const events: AgentEvent[] = [];
				let terminal = false;
				const consuming = (async () => {
					for await (const event of stream) events.push(event);
					terminal = true;
				})();
				await new Promise((resolve) => setTimeout(resolve, 30));
				expect(terminal).toBe(true);
				await consuming;
				const messages = await stream.result();
				expect(messages.at(-1)).toMatchObject({
					role: "assistant",
					stopReason: "error",
					errorMessage: "Agent loop failed",
				});
				expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
				if (failure === "finish") {
					expect(execute).toHaveBeenCalledOnce();
					expect(messages.find((message) => message.role === "toolResult")).toMatchObject({
						details: { receipt: "synthetic" },
						isError: false,
					});
				} else expect(execute).not.toHaveBeenCalled();
			});
		}
	}
});
