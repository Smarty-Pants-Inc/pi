import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { runToolCall } from "../src/agent-loop.ts";
import type { AgentTool, AgentToolCall } from "../src/types.ts";

// PR #131 P2-2: preparation, classification and execution belong to one pinned callable.
it("pins the callable across an awaited authorization hook", async () => {
	const calls: string[] = [];
	const tool: AgentTool = {
		name: "pinned",
		label: "pinned",
		description: "pinned",
		parameters: Type.Object({}),
		execute: async () => {
			calls.push("authorized");
			return { content: [], details: {} };
		},
	};
	const call: AgentToolCall = { type: "toolCall", id: "pin", name: "pinned", arguments: {} };
	await runToolCall(call, {
		tools: [tool],
		context: { messages: [], tools: [tool] },
		assistantMessage: fauxAssistantMessage([call], { stopReason: "toolUse" }),
		beforeToolCall: async () => {
			await Promise.resolve();
			tool.executionMode = "sequential";
			tool.execute = async () => {
				calls.push("replacement");
				return { content: [], details: {} };
			};
			return undefined;
		},
	});
	expect(calls).toEqual(["authorized"]);
});
