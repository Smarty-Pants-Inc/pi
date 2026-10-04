import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runToolCall } from "../src/agent-loop.ts";
import type { AgentTool, RunToolCallOptions } from "../src/index.ts";

const inner: AgentTool = {
	name: "inner",
	label: "Inner",
	description: "Returns private structured data",
	parameters: Type.Object({}),
	async execute() {
		return { content: [{ type: "text", text: "original" }], details: {}, structuredContent: { secret: true } };
	},
};

describe("nested hook structured replacement", () => {
	// smarty-dev#3535 / pi#137 A8: null is a replacement, not an absent hook field.
	it.each([false, true])("preserves explicit null with content replacement=%s", async (replaceContent) => {
		const options: RunToolCallOptions = {
			tools: [inner],
			assistantMessage: {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
			},
			context: { messages: [] },
			afterToolCall: async () => ({
				structuredContent: null,
				...(replaceContent ? { content: [{ type: "text", text: "redacted" }] } : {}),
			}),
		};
		const outer: AgentTool = {
			name: "outer",
			label: "Outer",
			description: "Calls inner",
			parameters: Type.Object({}),
			async execute() {
				const nested = await runToolCall(
					{ type: "toolCall", id: "inner-call", name: "inner", arguments: {} },
					options,
				);
				return nested.result;
			},
		};
		const outcome = await runToolCall(
			{ type: "toolCall", id: "outer-call", name: "outer", arguments: {} },
			{ ...options, tools: [outer], afterToolCall: undefined },
		);
		expect(outcome.isError).toBe(false);
		expect(outcome.result).toHaveProperty("structuredContent", null);
		expect(outcome.result.content).toEqual([{ type: "text", text: replaceContent ? "redacted" : "original" }]);
	});
});
