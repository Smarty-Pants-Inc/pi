import { Agent, type AgentTool, runToolCall, ToolCallQueue } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { NestedToolCallRunner } from "../src/core/nested-tool-calls.ts";

const model: Model<"openai-completions"> = {
	id: "synthetic",
	name: "Synthetic",
	provider: "audit",
	api: "openai-completions",
	baseUrl: "https://mock.invalid",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};
const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call", name: "native", arguments: {} }],
	provider: "audit",
	model: "synthetic",
	api: "openai-completions",
	timestamp: 0,
	stopReason: "toolUse",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function native(execute: () => void): AgentTool {
	return {
		name: "native",
		label: "Native",
		description: "Synthetic native tool",
		parameters: Type.Object({}),
		execute: async () => {
			execute();
			return { content: [{ type: "text", text: "native effect" }], details: {} };
		},
	};
}

// pi#141 / A11: pinning implementation bytes must not pin authority past revocation.
describe.each(["start", "authorization", "queue"] as const)("callable revocation after %s", (phase) => {
	it("refuses an ordinary tool after deactivation or replacement", async () => {
		let executions = 0;
		const tool = native(() => {
			executions++;
		});
		const agent = new Agent({
			initialState: { model, tools: [tool] },
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "toolUse", message: structuredClone(assistant) });
				return stream;
			},
		});
		agent.finishTurn = async () => ({ action: "end" });
		const started = gate();
		const blockerStarted = gate();
		const blockerRelease = gate();
		const blocker =
			phase === "queue"
				? agent.toolCallQueue.run({ id: "blocker", exclusive: true }, async () => {
						blockerStarted.resolve();
						await blockerRelease.promise;
					})
				: Promise.resolve();
		if (phase === "queue") await blockerStarted.promise;
		agent.subscribe(async (event) => {
			if (event.type === "tool_execution_start") {
				if (phase === "start") agent.state.tools = [];
				started.resolve();
			}
		});
		if (phase === "authorization")
			agent.beforeToolCall = async () => {
				agent.state.tools = [
					native(() => {
						executions++;
					}),
				];
				return undefined;
			};
		const operation = agent.prompt("synthetic request");
		try {
			await started.promise;
			if (phase === "queue") {
				agent.state.tools = [];
				blockerRelease.resolve();
			}
			await operation;
			expect(executions).toBe(0);
			expect(agent.state.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
		} finally {
			blockerRelease.resolve();
			await blocker;
			await operation;
		}
	});

	it("refuses a nested pinned registration after its current callable exposure retires", async () => {
		let executions = 0;
		let tools: AgentTool[] = [
			native(() => {
				executions++;
			}),
		];
		const started = gate();
		const blockerStarted = gate();
		const blockerRelease = gate();
		const queue = new ToolCallQueue();
		const blocker =
			phase === "queue"
				? queue.run({ id: "blocker", exclusive: true }, async () => {
						blockerStarted.resolve();
						await blockerRelease.promise;
					})
				: Promise.resolve();
		if (phase === "queue") await blockerStarted.promise;
		const runner = new NestedToolCallRunner({
			queue,
			getTools: () => tools,
			isSequential: () => false,
			emit: async (event) => {
				if (event.type === "tool_execution_start") {
					if (phase === "start") tools = [];
					started.resolve();
				}
			},
			runToolCall: (toolCall, _parent, signal, onUpdate, pinned) =>
				runToolCall(toolCall, {
					tools: pinned,
					context: { messages: [], tools: [...pinned] },
					assistantMessage: assistant,
					signal,
					onUpdate,
					beforeToolCall: async () => {
						if (phase === "authorization")
							tools = [
								native(() => {
									executions++;
								}),
							];
						return undefined;
					},
				}),
		});
		runner.open("parent");
		const operation = runner.execute("parent", "native", {});
		try {
			await started.promise;
			if (phase === "queue") {
				tools = [];
				blockerRelease.resolve();
			}
			const outcome = await operation;
			expect(outcome.isError).toBe(true);
			expect(executions).toBe(0);
		} finally {
			blockerRelease.resolve();
			await blocker;
			await operation;
			await runner.clear();
		}
	});
});
