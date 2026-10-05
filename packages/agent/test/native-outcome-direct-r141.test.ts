import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { runToolCall } from "../src/agent-loop.ts";
import type { AgentTool, AgentToolCall } from "../src/types.ts";

// pi#141 / P2-AUDIT-NATIVE: exported direct execution reports publication failure without erasing effects.
it.each(["update", "afterToolCall", "mutatingAfterToolCall"] as const)(
	"retains direct native result after %s failure",
	async (phase) => {
		const failure = new Error("synthetic publication failure");
		const result = {
			content: [{ type: "text" as const, text: "accepted" }],
			details: { receipt: "synthetic-receipt" },
			usage: {
				input: 7,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 9,
				cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
			},
		};
		let executions = 0;
		const tool: AgentTool = {
			name: "native",
			label: "Native",
			description: "Synthetic",
			parameters: Type.Object({}),
			execute: async (_id, _args, _signal, update) => {
				executions++;
				update?.({ content: [], details: {} });
				return structuredClone(result);
			},
		};
		const call: AgentToolCall = { type: "toolCall", id: "owned", name: "native", arguments: {} };
		const outcome = await runToolCall(call, {
			tools: [tool],
			context: { messages: [], tools: [tool] },
			assistantMessage: fauxAssistantMessage([call], { stopReason: "toolUse" }),
			onUpdate:
				phase === "update"
					? async () => {
							throw failure;
						}
					: undefined,
			afterToolCall:
				phase === "afterToolCall" || phase === "mutatingAfterToolCall"
					? async ({ result: working }) => {
							if (phase === "mutatingAfterToolCall") {
								working.content.length = 0;
								(working.details as { receipt: string }).receipt = "changed-by-rejected-hook";
								if (working.usage) {
									working.usage.input = 0;
									working.usage.cost.total = 0;
								}
							}
							throw failure;
						}
					: undefined,
		});
		expect(executions).toBe(1);
		expect(outcome.isError).toBe(true);
		expect(outcome.result).toMatchObject({
			details: result.details,
			usage: result.usage,
			content: [{ type: "text", text: failure.message }],
		});
		expect(outcome.completedResult).toEqual(result);
		expect(outcome.publicationFailure?.error).toBe(failure);
	},
);
