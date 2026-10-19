import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { runAgentLoop, runToolCall } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool, ToolExecutionMode } from "../src/types.ts";

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		stopReason,
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
}

function results(messages: readonly AgentMessage[]): ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function call(id: string, name = id): Extract<AssistantMessage["content"][number], { type: "toolCall" }> {
	return { type: "toolCall", id, name, arguments: {} };
}

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((fulfill) => {
		resolve = fulfill;
	});
	return { promise, resolve };
}

function fixture(
	tools: AgentTool[],
	calls: AssistantMessage["content"],
	toolExecution: ToolExecutionMode = "parallel",
	stopReason: AssistantMessage["stopReason"] = "toolUse",
) {
	const capture: { context?: AgentContext; newMessages?: AgentMessage[] } = {};
	const events: AgentEvent[] = [];
	let requests = 0;
	const agent = new Agent({
		initialState: { tools },
		toolExecution,
		prepareRequest: (request) => {
			capture.context = request.context;
		},
		finishTurn: (turn) => {
			capture.newMessages = turn.newMessages;
			if (requests === 1) return { action: "continue" };
		},
		streamFn: (_model, _context, options) => {
			if (++requests > 3) throw new Error("Unexpected replay after tool settlement");
			const stream = createAssistantMessageEventStream();
			if (options?.signal?.aborted) {
				stream.push({ type: "error", reason: "aborted", error: assistant([], "aborted") });
			} else if (requests === 2) {
				const message = assistant(calls, stopReason);
				stream.push({ type: "done", reason: stopReason === "length" ? "length" : "toolUse", message });
			} else {
				stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text: "done" }]) });
			}
			return stream;
		},
	});
	// Capture actual emitted artifacts before injecting a failing subscriber. Agent subscriber
	// fan-out is unchanged; Session-level healthy-listener delivery is tested by the coding-agent slice.
	agent.subscribe((event) => {
		events.push(event);
	});
	return { agent, capture, events, requests: () => requests };
}

type Fixture = ReturnType<typeof fixture>;
type FailureStage = "tool_execution_start" | "tool_execution_end" | "message_start" | "message_end";

function selected(event: AgentEvent, stage: FailureStage, id: string): boolean {
	if (event.type !== stage) return false;
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") return event.toolCallId === id;
	return (
		(event.type === "message_start" || event.type === "message_end") &&
		event.message.role === "toolResult" &&
		event.message.toolCallId === id
	);
}

function assertCommitted(batch: Fixture, ids: string[]) {
	const { agent, capture, events } = batch;
	if (!capture.context || !capture.newMessages) throw new Error("Probe turn did not capture loop-owned arrays");
	expect(capture.context.messages).not.toBe(agent.state.messages);
	expect(capture.newMessages).not.toBe(agent.state.messages);
	const canonical = results(agent.state.messages);
	expect(canonical.map((message) => message.toolCallId)).toEqual(ids);
	for (const messages of [capture.context.messages, capture.newMessages]) {
		expect(results(messages)).toEqual(canonical);
	}
	for (const type of ["message_start", "message_end"] as const) {
		const messages = events.flatMap((event) => (event.type === type ? [event.message] : []));
		expect(results(messages)).toEqual(canonical);
	}
	expect(agent.state.pendingToolCalls.size).toBe(0);
	expect(agent.state.isStreaming).toBe(false);
	return canonical;
}

function effectTool(execute: AgentTool["execute"], executionMode?: ToolExecutionMode): AgentTool {
	return {
		name: "effect",
		label: "effect",
		description: "in-memory effect",
		parameters: Type.Object({}),
		execute,
		executionMode,
	};
}

const parallelCases = (["success", "throw", "cancel"] as const).flatMap((outcome) =>
	(
		[
			{ stage: undefined, target: "effect" },
			{ stage: "tool_execution_end", target: "effect" },
			{ stage: "tool_execution_end", target: "sibling" },
			{ stage: "message_start", target: "effect" },
			{ stage: "message_start", target: "sibling" },
			{ stage: "message_end", target: "effect" },
			{ stage: "message_end", target: "sibling" },
		] as const
	).map(({ stage, target }) => ({ outcome, stage, target })),
);

// pi#274 / smarty-dev#10068: refit the two functional settlement commits at the core boundary.
// No native owner fixture, filesystem cleanup, provider API, or paid token is involved.
describe("tool batch settlement", () => {
	it.each(["tool_execution_start", "tool_execution_end", "message_start", "message_end"] as const)(
		"sequential settlement commits the current result before a %s listener failure",
		async (stage) => {
			let effects = 0;
			let siblings = 0;
			const effect = effectTool(async () => {
				effects++;
				return { content: [{ type: "text", text: "effect completed" }], details: { effects } };
			}, "sequential");
			const sibling: AgentTool = {
				name: "sibling",
				label: "sibling",
				description: "must not run",
				parameters: Type.Object({}),
				execute: async () => {
					siblings++;
					return { content: [], details: undefined };
				},
			};
			const batch = fixture([effect, sibling], [call("effect"), call("sibling")]);
			const failure = new Error(`sequential ${stage} listener failed`);
			batch.agent.subscribe((event) => {
				if (selected(event, stage, "effect")) throw failure;
			});
			await batch.agent.prompt("run");
			expect(effects).toBe(stage === "tool_execution_start" ? 0 : 1);
			expect(siblings).toBe(0);
			const committed = assertCommitted(batch, ["effect"]);
			expect(committed[0].isError).toBe(stage === "tool_execution_start");
			if (effects) expect(committed[0].content).toEqual([{ type: "text", text: "effect completed" }]);
			expect(batch.agent.state.errorMessage).toBe(failure.message);
			expect(batch.requests()).toBe(2);
		},
	);

	it("commits results before a persistent listener rejects failure publication", async () => {
		const batch = fixture(
			[effectTool(async () => ({ content: [], details: { completed: true } }))],
			[call("effect")],
		);
		const failure = new Error("persistent subscriber failure");
		let failing = false;
		batch.agent.subscribe((event) => {
			if (event.type === "tool_execution_end") failing = true;
			if (failing) throw failure;
		});
		await expect(batch.agent.prompt("run")).rejects.toBe(failure);
		assertCommitted(batch, ["effect"]);
	});

	it.each(parallelCases)(
		"settles a late parallel $outcome sibling with $stage listener failure for $target",
		async ({ outcome, stage, target }) => {
			const effectEnded = deferred();
			let effects = 0;
			let siblingSettled = false;
			const effect = effectTool(async () => {
				effects++;
				return { content: [{ type: "text", text: "effect completed" }], details: { effects } };
			});
			const sibling: AgentTool = {
				name: "sibling",
				label: "sibling",
				description: "late sibling",
				parameters: Type.Object({}),
				execute: async () => {
					await effectEnded.promise;
					siblingSettled = true;
					if (outcome === "cancel") batch.agent.abort();
					if (outcome !== "success")
						throw new Error(outcome === "cancel" ? "Operation aborted" : "late sibling failure");
					return { content: [{ type: "text", text: "sibling completed" }], details: undefined };
				},
			};
			// Source order deliberately differs from completion order.
			const batch = fixture([effect, sibling], [call("sibling"), call("effect")]);
			const failure = new Error(`${target} ${stage} listener failed`);
			batch.agent.subscribe((event) => {
				if (event.type === "tool_execution_end" && event.toolCallId === "effect") effectEnded.resolve();
				if (stage && selected(event, stage, target)) throw failure;
			});
			await batch.agent.prompt("run");
			expect(effects).toBe(1);
			expect(siblingSettled).toBe(true);
			const committed = assertCommitted(batch, ["sibling", "effect"]);
			expect(committed[0].isError).toBe(outcome !== "success");
			expect(committed[1].isError).toBe(false);
			expect(
				batch.events.filter((event) => event.type === "tool_execution_end").map((event) => event.toolCallId),
			).toEqual(["effect", "sibling"]);
			if (stage) expect(batch.agent.state.errorMessage).toBe(failure.message);
			// #280: a late sibling may abort while settlement is unwinding. #298 forbids
			// the obsolete third physical replay; success/throw remain counterexamples
			// where an already-settled result still permits the continuation request.
			const expectedRequests = stage !== undefined || outcome === "cancel" ? 2 : 3;
			expect(batch.requests()).toBe(expectedRequests);
		},
	);

	it.each([
		{ order: "unknown-first", stage: "tool_execution_end", target: "unknown" },
		{ order: "prepared-first", stage: "tool_execution_end", target: "unknown" },
		{ order: "unknown-first", stage: "tool_execution_start", target: "effect" },
		{ order: "prepared-first", stage: "tool_execution_start", target: "unknown" },
		{ order: "prepared-first", stage: "tool_execution_start", target: "effect" },
	] as const)(
		"pairs published preflight starts without running effects: $order/$stage/$target",
		async ({ order, stage, target }) => {
			let effects = 0;
			const effect = effectTool(async () => {
				effects++;
				return { content: [], details: undefined };
			});
			const calls =
				order === "unknown-first"
					? [call("unknown", "missing"), call("effect")]
					: [call("effect"), call("unknown", "missing")];
			const batch = fixture([effect], calls);
			batch.agent.subscribe((event) => {
				if (selected(event, stage, target)) throw new Error("preflight publication failed");
			});
			await batch.agent.prompt("run");
			expect(effects).toBe(0);
			const startedIds = calls
				.slice(0, calls.findIndex((entry) => entry.id === target) + 1)
				.map((entry) => entry.id);
			const committed = assertCommitted(batch, startedIds);
			expect(committed.every((message) => message.isError)).toBe(true);
			const endedIds = batch.events
				.filter((event) => event.type === "tool_execution_end")
				.map((event) => event.toolCallId);
			expect([...endedIds].sort()).toEqual([...startedIds].sort());
		},
	);

	it.each(["tool_execution_start", "tool_execution_end", "message_start", "message_end"] as const)(
		"commits the complete truncated batch despite a %s failure",
		async (stage) => {
			let effects = 0;
			const batch = fixture(
				[
					effectTool(async () => {
						effects++;
						return { content: [], details: undefined };
					}),
				],
				[call("first", "effect"), call("second", "effect")],
				"parallel",
				"length",
			);
			batch.agent.subscribe((event) => {
				if (selected(event, stage, "second")) throw new Error("truncated publication failed");
			});
			await batch.agent.prompt("run");
			expect(effects).toBe(0);
			const committed = assertCommitted(batch, ["first", "second"]);
			expect(committed.every((message) => message.isError)).toBe(true);
			expect(committed.every((message) => JSON.stringify(message.content).includes("output token limit"))).toBe(
				true,
			);
		},
	);

	// #3155 CR-2: this reported sequence used to commit only the healthy sibling.
	it("commits both completed calls and settles a late sibling before a progress failure escapes", async () => {
		const slowStarted = deferred();
		const releaseSlow = deferred();
		const updateFailure = new Error("update sink failed");
		const effects: string[] = [];
		let settled = false;
		const effect = effectTool(async () => {
			slowStarted.resolve();
			await releaseSlow.promise;
			settled = true;
			effects.push("late sibling");
			return { content: [], details: { completed: true } };
		});
		const failing: AgentTool = {
			name: "failing",
			label: "failing",
			description: "unexpected update failure",
			parameters: Type.Object({}),
			execute: async (_id, _args, _signal, onUpdate) => {
				await slowStarted.promise;
				onUpdate?.({ content: [], details: undefined });
				effects.push("effect with rejected progress");
				return {
					content: [{ type: "text", text: "effect with rejected progress completed" }],
					details: { completed: true },
				};
			},
		};
		const batch = fixture([effect, failing], [call("effect"), call("failing")]);
		batch.agent.subscribe((event) => {
			if (event.type === "tool_execution_update") {
				releaseSlow.resolve();
				throw updateFailure;
			}
			if (event.type === "tool_execution_end") throw new Error("completion listener failed");
		});
		await batch.agent.prompt("run");
		expect(settled).toBe(true);
		expect(effects).toEqual(["effect with rejected progress", "late sibling"]);
		const committed = assertCommitted(batch, ["effect", "failing"]);
		expect(committed.every((message) => !message.isError)).toBe(true);
		expect(committed[1].content).toEqual([{ type: "text", text: "effect with rejected progress completed" }]);
		expect(
			batch.events
				.filter((event) => event.type === "tool_execution_end")
				.map((event) => event.toolCallId)
				.sort(),
		).toEqual(["effect", "failing"]);
		expect(batch.agent.state.errorMessage).toBe(updateFailure.message);
	});

	// #3155 CR-2: progress publication and execution have separate outcomes in both schedulers.
	it.each(
		(["sequential", "parallel"] as const).flatMap((mode) =>
			(["success", "throw"] as const).map((outcome) => ({ mode, outcome })),
		),
	)(
		"preserves a $mode execution $outcome despite rejected progress and completion listeners",
		async ({ mode, outcome }) => {
			const effects: string[] = [];
			const updateFailure = new Error("progress publication failed");
			const executionFailure = new Error("real execution failed");
			const published: number[] = [];
			const effect = effectTool(async (_id, _args, _signal, onUpdate) => {
				effects.push("effect");
				onUpdate?.({ content: [], details: { index: 1 } });
				await Promise.resolve();
				onUpdate?.({ content: [], details: { index: 2 } });
				if (outcome === "throw") throw executionFailure;
				return { content: [{ type: "text", text: "completed once" }], details: { effect: 1 } };
			});
			const sibling: AgentTool = {
				name: "sibling",
				label: "sibling",
				description: "in-memory sibling",
				parameters: Type.Object({}),
				execute: async () => {
					effects.push("sibling");
					return { content: [], details: undefined };
				},
			};
			const batch = fixture([effect, sibling], [call("effect"), call("sibling")], mode);
			const finalized: boolean[] = [];
			batch.agent.afterToolCall = async (context) => {
				if (context.toolCall.id === "effect") finalized.push(context.isError);
				return undefined;
			};
			batch.agent.subscribe(async (event) => {
				if (event.type === "tool_execution_update" && event.toolCallId === "effect") {
					published.push(event.partialResult.details.index);
					await Promise.resolve();
					throw updateFailure;
				}
				if (event.type === "tool_execution_end") throw new Error("later completion publication failed");
			});
			await batch.agent.prompt("run");
			expect(effects).toEqual(mode === "sequential" ? ["effect"] : ["effect", "sibling"]);
			expect(published).toEqual([1, 2]);
			expect(finalized).toEqual([outcome === "throw"]);
			const committed = assertCommitted(batch, mode === "sequential" ? ["effect"] : ["effect", "sibling"]);
			expect(committed[0].isError).toBe(outcome === "throw");
			expect(committed[0].content).toEqual([
				{ type: "text", text: outcome === "throw" ? executionFailure.message : "completed once" },
			]);
			expect(batch.agent.state.errorMessage).toBe(updateFailure.message);
			expect(batch.requests()).toBe(2);
		},
	);

	// #3155 CR-2: check original error identity and loop arrays at the low-level failure boundary.
	it("propagates the original progress failure only after committing both loop-owned result arrays", async () => {
		const updateFailure = new Error("original progress rejection");
		const siblingReleased = deferred();
		let siblingSettled = false;
		const effect = effectTool(async (_id, _args, _signal, onUpdate) => {
			onUpdate?.({ content: [], details: undefined });
			return { content: [{ type: "text", text: "effect done" }], details: undefined };
		});
		const sibling: AgentTool = {
			name: "sibling",
			label: "sibling",
			description: "late in-memory sibling",
			parameters: Type.Object({}),
			execute: async () => {
				await siblingReleased.promise;
				siblingSettled = true;
				return { content: [], details: undefined };
			},
		};
		const batch = fixture([effect, sibling], [call("effect"), call("sibling")]);
		await expect(
			runAgentLoop(
				[{ role: "user", content: "run", timestamp: 0 }],
				{ messages: [], tools: [effect, sibling] },
				{
					model: batch.agent.state.model,
					convertToLlm: batch.agent.convertToLlm,
					prepareRequest: batch.agent.prepareRequest,
					finishTurn: batch.agent.finishTurn,
				},
				(event) => {
					batch.events.push(event);
					if (event.type === "tool_execution_update") {
						siblingReleased.resolve();
						throw updateFailure;
					}
					if (event.type === "tool_execution_end") throw new Error("later end rejection");
				},
				undefined,
				batch.agent.streamFunction,
			),
		).rejects.toBe(updateFailure);
		expect(siblingSettled).toBe(true);
		if (!batch.capture.context || !batch.capture.newMessages) throw new Error("Loop arrays were not captured");
		for (const messages of [batch.capture.context.messages, batch.capture.newMessages]) {
			expect(results(messages).map((message) => message.toolCallId)).toEqual(["effect", "sibling"]);
			expect(results(messages).every((message) => !message.isError)).toBe(true);
		}
	});

	// #3155 CR-2: nested execution uses the same helper, but returns outcomes instead of loop events.
	it.each(["success", "throw"] as const)("retains the nested execution %s when onUpdate rejects", async (outcome) => {
		const executionFailure = new Error("nested execution failed");
		const effects: string[] = [];
		const effect = effectTool(async (_id, _args, _signal, onUpdate) => {
			effects.push("nested effect");
			onUpdate?.({ content: [], details: undefined });
			if (outcome === "throw") throw executionFailure;
			return { content: [{ type: "text", text: "nested effect completed" }], details: { count: 1 } };
		});
		let updates = 0;
		const finalized: boolean[] = [];
		const result = await runToolCall(call("nested", "effect"), {
			tools: [effect],
			assistantMessage: assistant([call("nested", "effect")], "toolUse"),
			context: { messages: [] },
			onUpdate: async () => {
				updates++;
				await Promise.resolve();
				throw new Error("nested progress publication failed");
			},
			afterToolCall: async (context) => {
				finalized.push(context.isError);
				return undefined;
			},
		});
		expect(effects).toEqual(["nested effect"]);
		expect(updates).toBe(1);
		expect(finalized).toEqual([outcome === "throw"]);
		expect(result.isError).toBe(outcome === "throw");
		expect(result.result.content).toEqual([
			{ type: "text", text: outcome === "throw" ? executionFailure.message : "nested effect completed" },
		]);
	});
});
