import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { runToolCall } from "../src/agent-loop.ts";
import type { AgentTool, AgentToolCall } from "../src/types.ts";

// PR #131 P1-2 / A12: explicit structured null is redaction, not omission.
it.each([false, true])("preserves public structured-null redaction (text replacement=%s)", async (replaceText) => {
	const tool: AgentTool = {
		name: "protected",
		label: "protected",
		description: "Private result",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: "private" }],
			details: {},
			structuredContent: { secret: true },
		}),
	};
	const call: AgentToolCall = { type: "toolCall", id: "protected-1", name: "protected", arguments: {} };
	const outcome = await runToolCall(call, {
		tools: [tool],
		assistantMessage: fauxAssistantMessage([call], { stopReason: "toolUse" }),
		context: { tools: [tool], messages: [] },
		afterToolCall: async () => ({
			structuredContent: null,
			...(replaceText ? { content: [{ type: "text", text: "redacted" }] } : {}),
		}),
	});
	expect(outcome.isError).toBe(false);
	expect(outcome.result.structuredContent).toBeNull();
	expect(outcome.result.content).toEqual([{ type: "text", text: replaceText ? "redacted" : "private" }]);
});
