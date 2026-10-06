import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { runAgentLoop, runToolCall } from "../src/agent-loop.ts";
import type { AgentTool, AgentToolCall, AgentToolResult } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "openai-completions",
	provider: "audit",
	baseUrl: "https://mock.invalid",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};
const usage = {
	input: 7,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 9,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.1 + 0.2 },
};
type NativeFact = (Error | RegExp) & { receipt: { id: string }; completedStatus: string };

// pi#141 / P2-AUDIT-NATIVE-FIDELITY: a rejecting hook cannot erase enumerable completed facts.
for (const kind of ["error", "regexp"] as const) {
	for (const mode of ["direct", "sequential", "parallel"] as const) {
		it.each([false, true])(`retains ${kind} metadata in ${mode} outcomes (mutation: %s)`, async (mutate) => {
			const fact: NativeFact = Object.assign(kind === "error" ? new Error("accepted") : /accepted/g, {
				receipt: { id: "synthetic-completed-receipt" },
				completedStatus: "accepted",
			});
			const result: AgentToolResult<{ fact: NativeFact }> = {
				content: [{ type: "text", text: "accepted" }],
				details: { fact },
				usage,
			};
			const expected = JSON.parse(JSON.stringify(result));
			let executions = 0;
			let hooks = 0;
			const tool: AgentTool = {
				name: "native",
				label: "Native",
				description: "Synthetic",
				parameters: Type.Object({}),
				execute: async () => {
					executions++;
					return result;
				},
			};
			const call: AgentToolCall = { type: "toolCall", id: "native-fidelity", name: "native", arguments: {} };
			const assistantMessage = fauxAssistantMessage([call], { stopReason: "toolUse" });
			const failure = new Error("synthetic publication failure");
			let observedFact: NativeFact | undefined;
			let observedReceipt: unknown;
			const afterToolCall = async ({ result: working }: { result: AgentToolResult<unknown> }) => {
				hooks++;
				const workingFact = (working.details as { fact: NativeFact }).fact;
				observedFact = workingFact;
				observedReceipt = workingFact.receipt && { ...workingFact.receipt };
				if (mutate && workingFact.receipt) {
					workingFact.receipt.id = "changed-by-rejected-hook";
					workingFact.completedStatus = "changed";
				}
				throw failure;
			};
			let retained: AgentToolResult<unknown> | ToolResultMessage | undefined;
			if (mode === "direct") {
				const outcome = await runToolCall(call, {
					tools: [tool],
					context: { messages: [], tools: [tool] },
					assistantMessage,
					afterToolCall,
				});
				expect(outcome.publicationFailure?.error).toMatchObject({
					message: "tool_result_withheld (after_policy_failed)",
				});
				retained = outcome.result;
				expect(outcome).not.toHaveProperty("completedResult");
			} else {
				const journal: ToolResultMessage[] = [];
				await expect(
					runAgentLoop(
						[],
						{ messages: [], tools: [tool] },
						{
							model,
							convertToLlm: () => [],
							toolExecution: mode,
							afterToolCall,
						},
						(event) => {
							if (event.type === "message_end" && event.message.role === "toolResult") {
								journal.push(JSON.parse(JSON.stringify(event.message)) as ToolResultMessage);
							}
						},
						undefined,
						() => {
							const stream = createAssistantMessageEventStream();
							stream.push({ type: "done", reason: "toolUse", message: assistantMessage });
							return stream;
						},
					),
				).rejects.toThrow("tool_result_withheld (after_policy_failed)");
				expect(journal).toHaveLength(1);
				expect(journal[0].isError).toBe(true);
				retained = journal[0];
			}
			expect(executions).toBe(1);
			expect(hooks).toBe(1);
			// Check hook observations outside the production catch boundary.
			expect(observedFact).toBeInstanceOf(kind === "error" ? Error : RegExp);
			expect(observedReceipt).toEqual(fact.receipt);
			expect(observedFact).not.toBe(fact);
			expect(observedFact?.receipt).not.toBe(fact.receipt);
			// smarty-dev#5822: publication is withheld, while source facts and isolated hook observations remain intact.
			expect(retained?.details).toBeUndefined();
			expect(retained?.usage).toEqual(usage);
			expect(retained?.content).toEqual([{ type: "text", text: "tool_result_withheld (after_policy_failed)" }]);
			expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
		});
	}
}

// pi#141 / P2-AUDIT-NATIVE-FIDELITY: metadata graphs keep aliases and cycles in isolated snapshots.
it.each(["error", "regexp"] as const)("preserves %s metadata through containers and causes", async (kind) => {
	const fact = Object.assign(kind === "error" ? new Error("accepted") : /accepted/g, {
		receipt: { id: "synthetic-completed-receipt" },
		completedStatus: "accepted",
	});
	const cycle = { fact };
	Object.assign(fact, { cycle });
	Object.defineProperty(fact, "__proto__", { value: { receipt: "own-metadata" }, enumerable: true });
	const details = {
		map: new Map([[fact, new Set([fact])]]),
		cause: new Error("wrapper", { cause: fact }),
		fact,
		cycle,
	};
	const result = { content: [{ type: "text" as const, text: "accepted" }], details };
	const tool: AgentTool = {
		name: "native",
		label: "Native",
		description: "Synthetic",
		parameters: Type.Object({}),
		execute: async () => result,
	};
	const call: AgentToolCall = { type: "toolCall", id: "native-graph", name: "native", arguments: {} };
	let workingDetails: typeof details | undefined;
	const failure = new Error("synthetic publication failure");
	const outcome = await runToolCall(call, {
		tools: [tool],
		context: { messages: [], tools: [tool] },
		assistantMessage: fauxAssistantMessage([call], { stopReason: "toolUse" }),
		afterToolCall: async ({ result: working }) => {
			workingDetails = working.details as typeof details;
			throw failure;
		},
	});
	expect(outcome.publicationFailure?.error).toMatchObject({ message: "tool_result_withheld (after_policy_failed)" });
	expect(outcome).not.toHaveProperty("completedResult");
	expect(outcome.result.details).toBeUndefined();
	for (const copy of [workingDetails]) {
		if (!copy) throw new Error("Missing isolated native detail snapshot");
		expect(copy.fact).toBeInstanceOf(kind === "error" ? Error : RegExp);
		expect(copy.fact.receipt).toEqual(fact.receipt);
		expect(copy.fact.receipt).not.toBe(fact.receipt);
		expect([...copy.map.keys()]).toEqual([copy.fact]);
		expect(copy.map.has(copy.fact)).toBe(true);
		expect(copy.map.get(copy.fact)?.has(copy.fact)).toBe(true);
		expect(copy.cause.cause).toBe(copy.fact);
		expect(copy.cycle.fact).toBe(copy.fact);
		expect((copy.fact as typeof fact & { cycle: typeof cycle }).cycle).toBe(copy.cycle);
		expect(Object.getOwnPropertyDescriptor(copy.fact, "__proto__")?.value).toEqual({ receipt: "own-metadata" });
	}
	expect(workingDetails?.fact).not.toBe(details.fact);
	expect(workingDetails?.fact.receipt).not.toBe(details.fact.receipt);
});

// pi#141: if native metadata cannot be isolated, retain facts and report transformation failure without invoking the hook.
it.each(["error", "regexp"] as const)("refuses lossy %s metadata snapshots", async (kind) => {
	const fact = Object.assign(kind === "error" ? new Error("accepted") : /accepted/g, {
		receipt: "synthetic-completed-receipt",
		completedStatus: "accepted",
		callback: () => "native",
	});
	const result = { content: [{ type: "text" as const, text: "accepted" }], details: { fact }, usage };
	const tool: AgentTool = {
		name: "native",
		label: "Native",
		description: "Synthetic",
		parameters: Type.Object({}),
		execute: async () => result,
	};
	const call: AgentToolCall = { type: "toolCall", id: "native-uncloneable", name: "native", arguments: {} };
	let hooks = 0;
	const outcome = await runToolCall(call, {
		tools: [tool],
		context: { messages: [], tools: [tool] },
		assistantMessage: fauxAssistantMessage([call], { stopReason: "toolUse" }),
		afterToolCall: async () => {
			hooks++;
			throw new Error("synthetic hook failure");
		},
	});
	expect(hooks).toBe(0);
	expect(outcome).not.toHaveProperty("completedResult");
	expect(outcome.publicationFailure).toBeDefined();
	expect(outcome.result.details).toBeUndefined();
	expect(outcome.result.usage).toEqual(usage);
	expect(result.details).toEqual({ fact });
});
