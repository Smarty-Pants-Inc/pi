import { setImmediate } from "node:timers/promises";
import {
	type AgentTool,
	type AgentToolResult,
	runToolCall,
	type ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { NestedToolCallRunner } from "../src/core/nested-tool-calls.ts";
import { createToolDefinitionFromAgentTool } from "../src/core/tools/tool-definition-wrapper.ts";
import { createCodemodeExtension } from "../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult } from "./suite/harness.ts";

const emptyResult = (): AgentToolResult<unknown> => ({ content: [], details: {} });

function tool(
	name: string,
	mode: ToolExecutionMode,
	execute: (id: string) => Promise<AgentToolResult<unknown>>,
): AgentTool {
	return { name, label: name, description: name, parameters: Type.Object({}), executionMode: mode, execute };
}

function runnerFor(
	tools: AgentTool[],
	phases: string[],
	sequential = false,
	after?: (name: string) => Promise<void>,
): NestedToolCallRunner {
	return new NestedToolCallRunner({
		getTools: () => tools,
		isSequential: () => sequential,
		runToolCall: (toolCall, _parent, signal, onUpdate) =>
			runToolCall(toolCall, {
				tools,
				assistantMessage: fauxAssistantMessage(fauxToolCall("caller", {}, { id: "root" })),
				context: { messages: [], tools },
				signal,
				onUpdate,
				beforeToolCall: async ({ toolCall: call }) => {
					phases.push(`before:${call.name}`);
					return undefined;
				},
				afterToolCall: async ({ toolCall: call }) => {
					phases.push(`after:${call.name}`);
					if (after) await after(call.name);
					return undefined;
				},
			}),
		emit: async () => {},
	});
}

describe("nested tool scheduling through the real tool pipeline", () => {
	// smarty-dev#2241 A11: a sequential sibling excludes parallel calls in either arrival order.
	it.each(["parallel", "sequential"] as const)("excludes mixed siblings with %s first", async (firstMode) => {
		const phases: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = tool("first", firstMode, async () => {
			phases.push("execute:first");
			entered.resolve();
			await release.promise;
			return emptyResult();
		});
		const second = tool("second", firstMode === "parallel" ? "sequential" : "parallel", async () => {
			phases.push("execute:second");
			return emptyResult();
		});
		const runner = runnerFor([first, second], phases);
		const calls = Promise.all([runner.execute("root", "first", {}), runner.execute("root", "second", {})]);
		try {
			await entered.promise;
			await setImmediate();
			expect(phases).toEqual(["before:first", "execute:first"]);
		} finally {
			release.resolve();
		}
		expect((await calls).every((outcome) => !outcome.isError)).toBe(true);
		expect(phases).toEqual([
			"before:first",
			"execute:first",
			"after:first",
			"before:second",
			"execute:second",
			"after:second",
		]);
		expect(runner.takeRecord("root")?.calls?.complete).toBe(true);
	});

	// smarty-dev#2241 A11: later readers cannot pass an already waiting exclusive sibling.
	it("keeps reader/writer/reader arrival order including hooks", async () => {
		const phases: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const tools = [
			tool("read1", "parallel", async () => {
				entered.resolve();
				await release.promise;
				return emptyResult();
			}),
			tool("write", "sequential", async () => emptyResult()),
			tool("read2", "parallel", async () => emptyResult()),
		];
		const runner = runnerFor(tools, phases);
		const calls = Promise.all(tools.map((entry) => runner.execute("root", entry.name, {})));
		try {
			await entered.promise;
			await setImmediate();
			expect(phases).toEqual(["before:read1"]);
		} finally {
			release.resolve();
		}
		await calls;
		expect(phases).toEqual([
			"before:read1",
			"after:read1",
			"before:write",
			"after:write",
			"before:read2",
			"after:read2",
		]);
	});

	// smarty-dev#2241 A11: shared leases must not serialize independent parallel calls.
	it.each([false, true])("keeps parallel siblings concurrent (different roots: %s)", async (differentRoots) => {
		const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const release = Promise.withResolvers<void>();
		let active = 0;
		let peak = 0;
		const tools = started.map((gate, index) =>
			tool(`parallel${index}`, "parallel", async () => {
				peak = Math.max(peak, ++active);
				gate.resolve();
				await release.promise;
				active--;
				return emptyResult();
			}),
		);
		const runner = runnerFor(tools, []);
		const calls = Promise.all(
			tools.map((entry, index) => runner.execute(differentRoots ? `root${index}` : "root", entry.name, {})),
		);
		try {
			await Promise.all(started.map((gate) => gate.promise));
			expect(peak).toBe(2);
		} finally {
			release.resolve();
		}
		await calls;
	});

	// smarty-dev#2241 A11: an exclusive ancestor is not carte blanche for sequential descendants.
	it.each([false, true])("serializes recursive descendants (global sequential: %s)", async (sequential) => {
		const phases: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const tools: AgentTool[] = [];
		const runner = runnerFor(tools, phases, sequential);
		tools.push(
			tool("parent", "sequential", async (id) => {
				await Promise.all([
					runner.execute(id, "middle", {}),
					runner.execute(id, "second", {}),
					runner.execute(id, "parallelChild", {}),
				]);
				return emptyResult();
			}),
			tool("middle", "sequential", async (id) => {
				await runner.execute(id, "leaf", {});
				return emptyResult();
			}),
			tool("leaf", "sequential", async () => {
				entered.resolve();
				await release.promise;
				return emptyResult();
			}),
			tool("second", "sequential", async () => emptyResult()),
			tool("parallelChild", "parallel", async () => emptyResult()),
		);
		const call = runner.execute("root", "parent", {});
		try {
			await entered.promise;
			await setImmediate();
			expect(phases).toEqual(["before:parent", "before:middle", "before:leaf"]);
		} finally {
			release.resolve();
		}
		expect((await call).isError).toBe(false);
		expect(phases).toEqual([
			"before:parent",
			"before:middle",
			"before:leaf",
			"after:leaf",
			"after:middle",
			"before:second",
			"after:second",
			"before:parallelChild",
			"after:parallelChild",
			"after:parent",
		]);
	});

	// smarty-dev#2241 A11: a waiting writer cannot deadlock the active parallel parent's sequential child.
	it("lets descendants drain before a writer blocked by their parallel ancestor", async () => {
		const phases: string[] = [];
		const parentEntered = Promise.withResolvers<void>();
		const allowChild = Promise.withResolvers<void>();
		const tools: AgentTool[] = [];
		const runner = runnerFor(tools, phases);
		tools.push(
			tool("parent", "parallel", async (id) => {
				parentEntered.resolve();
				await allowChild.promise;
				await runner.execute(id, "child", {});
				return emptyResult();
			}),
			tool("writer", "sequential", async () => emptyResult()),
			tool("child", "sequential", async () => emptyResult()),
		);
		const parent = runner.execute("root", "parent", {});
		await parentEntered.promise;
		const writer = runner.execute("other-root", "writer", {});
		try {
			await setImmediate();
			expect(phases).toEqual(["before:parent"]);
		} finally {
			allowChild.resolve();
		}
		await Promise.all([parent, writer]);
		expect(phases).toEqual([
			"before:parent",
			"before:child",
			"after:child",
			"after:parent",
			"before:writer",
			"after:writer",
		]);
	});

	// smarty-dev#2241 A11: parallel composites remain live, but their sequential children never overlap.
	it.each([false, true])(
		"serializes cousin writers (exclusive grandparent: %s)",
		async (grandparent) => {
			const phases: string[] = [];
			const parentsEntered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			const allowChildren = Promise.withResolvers<void>();
			let active = 0;
			let peak = 0;
			const effects: string[] = [];
			const tools: AgentTool[] = [];
			const runner = runnerFor(tools, phases);
			for (let index = 0; index < 2; index++) {
				tools.push(
					tool(`parent${index}`, "parallel", async (id) => {
						parentsEntered[index].resolve();
						await allowChildren.promise;
						const outcome = await runner.execute(id, `child${index}`, {});
						expect(outcome.isError).toBe(false);
						return emptyResult();
					}),
					tool(`child${index}`, "sequential", async () => {
						peak = Math.max(peak, ++active);
						effects.push(`start:${index}`);
						entered[index].resolve();
						await release[index].promise;
						effects.push(`end:${index}`);
						active--;
						return emptyResult();
					}),
				);
			}
			tools.push(
				tool("grandparent", "sequential", async (id) => {
					const outcomes = await Promise.all([
						runner.execute(id, "parent0", {}),
						runner.execute(id, "parent1", {}),
					]);
					expect(outcomes.map((outcome) => outcome.isError)).toEqual([false, false]);
					return emptyResult();
				}),
			);
			const calls = grandparent
				? Promise.all([runner.execute("root", "grandparent", {})])
				: Promise.all([runner.execute("root", "parent0", {}), runner.execute("root", "parent1", {})]);
			try {
				await Promise.all(parentsEntered.map((gate) => gate.promise));
				allowChildren.resolve();
				await entered[0].promise;
				await setImmediate();
				expect(effects).toEqual(["start:0"]);
				expect(phases.filter((phase) => phase.includes("child"))).toEqual(["before:child0"]);
				release[0].resolve();
				await entered[1].promise;
				expect(effects).toEqual(["start:0", "end:0", "start:1"]);
				expect(phases.filter((phase) => phase.includes("child"))).toEqual([
					"before:child0",
					"after:child0",
					"before:child1",
				]);
			} finally {
				allowChildren.resolve();
				for (const gate of release) gate.resolve();
			}
			expect((await calls).map((outcome) => outcome.isError)).toEqual(grandparent ? [false] : [false, false]);
			expect(effects).toEqual(["start:0", "end:0", "start:1", "end:1"]);
			expect(peak).toBe(1);
			expect(active).toBe(0);
			expect(runner.takeRecord("root")?.calls?.complete).toBe(true);
		},
		5000,
	);

	// smarty-dev#2241 A11: a queued unrelated writer must not deadlock its blocking ancestor's awaited child.
	it("lets an ancestor reenter ahead of a blocked unrelated writer", async () => {
		const phases: string[] = [];
		const entered = Promise.withResolvers<void>();
		const allowChild = Promise.withResolvers<void>();
		const tools: AgentTool[] = [];
		const runner = runnerFor(tools, phases);
		tools.push(
			tool("branch", "parallel", async (id) => {
				expect((await runner.execute(id, "ancestor", {})).isError).toBe(false);
				return emptyResult();
			}),
			tool("ancestor", "sequential", async (id) => {
				entered.resolve();
				await allowChild.promise;
				expect((await runner.execute(id, "descendant", {})).isError).toBe(false);
				return emptyResult();
			}),
			tool("otherBranch", "parallel", async (id) => {
				expect((await runner.execute(id, "unrelated", {})).isError).toBe(false);
				return emptyResult();
			}),
			tool("laterBranch", "parallel", async (id) => {
				expect((await runner.execute(id, "laterWriter", {})).isError).toBe(false);
				return emptyResult();
			}),
			tool("unrelated", "sequential", async () => emptyResult()),
			tool("laterWriter", "sequential", async () => emptyResult()),
			tool("descendant", "sequential", async () => emptyResult()),
		);
		const branch = runner.execute("root", "branch", {});
		await entered.promise;
		const other = runner.execute("root", "otherBranch", {});
		const later = runner.execute("root", "laterBranch", {});
		try {
			await setImmediate();
			expect(phases).toEqual(["before:branch", "before:ancestor", "before:otherBranch", "before:laterBranch"]);
		} finally {
			allowChild.resolve();
		}
		expect((await Promise.all([branch, other, later])).map((outcome) => outcome.isError)).toEqual([
			false,
			false,
			false,
		]);
		expect(phases.filter((phase) => !phase.includes("Branch") && !phase.endsWith(":branch"))).toEqual([
			"before:ancestor",
			"before:descendant",
			"after:descendant",
			"after:ancestor",
			"before:unrelated",
			"after:unrelated",
			"before:laterWriter",
			"after:laterWriter",
		]);
	}, 5000);

	// smarty-dev#2241 A11: cancellation at global admission must skip hooks/effects without letting a follower pass.
	it("cancels a cross-branch writer without late effects or a follower bypass", async () => {
		const phases: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const cancelledDone = Promise.withResolvers<void>();
		const controller = new AbortController();
		const tools: AgentTool[] = [];
		const runner = runnerFor(tools, phases);
		tools.push(
			tool("holdingBranch", "parallel", async (id) => {
				expect((await runner.execute(id, "holder", {})).isError).toBe(false);
				return emptyResult();
			}),
			tool("holder", "sequential", async () => {
				entered.resolve();
				await release.promise;
				return emptyResult();
			}),
			tool("waitingBranch", "parallel", async (id) => {
				const cancelled = runner.execute(id, "cancelled", {}, { signal: controller.signal });
				const follower = runner.execute(id, "follower", {});
				const outcome = await cancelled;
				expect(outcome.isError).toBe(true);
				expect(outcome.result.content).toEqual([{ type: "text", text: "Operation aborted" }]);
				cancelledDone.resolve();
				expect((await follower).isError).toBe(false);
				return emptyResult();
			}),
			tool("cancelled", "sequential", async () => emptyResult()),
			tool("follower", "sequential", async () => emptyResult()),
		);
		const holding = runner.execute("root", "holdingBranch", {});
		await entered.promise;
		const waiting = runner.execute("root", "waitingBranch", {});
		try {
			await setImmediate();
			expect(phases).toEqual(["before:holdingBranch", "before:holder", "before:waitingBranch"]);
			controller.abort();
			await cancelledDone.promise;
			await setImmediate();
			expect(phases).toEqual(["before:holdingBranch", "before:holder", "before:waitingBranch"]);
		} finally {
			controller.abort();
			release.resolve();
		}
		expect((await Promise.all([holding, waiting])).map((outcome) => outcome.isError)).toEqual([false, false]);
		expect(phases.filter((phase) => !phase.includes("Branch"))).toEqual([
			"before:holder",
			"after:holder",
			"before:follower",
			"after:follower",
		]);
		expect(runner.takeRecord("root")?.calls?.calls.find((call) => call.name === "cancelled")?.status).toBe("error");
	}, 5000);

	// smarty-dev#2241 A11: a branch's writer lease survives both unawaited child joins and awaited after hooks.
	it.each(["child", "hook"] as const)(
		"retains the global parent lease when %s finishes first",
		async (first) => {
			const phases: string[] = [];
			const childEntered = Promise.withResolvers<void>();
			const hookEntered = Promise.withResolvers<void>();
			const releaseChild = Promise.withResolvers<void>();
			const releaseHook = Promise.withResolvers<void>();
			const tools: AgentTool[] = [];
			const runner = runnerFor(tools, phases, false, async (name) => {
				if (name !== "parent") return;
				hookEntered.resolve();
				await releaseHook.promise;
				phases.push("joined:parent-hook");
			});
			tools.push(
				tool("branch", "parallel", async (id) => {
					expect((await runner.execute(id, "parent", {})).isError).toBe(false);
					return emptyResult();
				}),
				tool("parent", "sequential", async (id) => {
					void runner.execute(id, "child", {});
					return emptyResult();
				}),
				tool("child", "parallel", async () => {
					childEntered.resolve();
					await releaseChild.promise;
					return emptyResult();
				}),
				tool("otherBranch", "parallel", async (id) => {
					expect((await runner.execute(id, "writer", {})).isError).toBe(false);
					return emptyResult();
				}),
				tool("writer", "sequential", async () => emptyResult()),
			);
			let parentSettled = false;
			const branch = runner.execute("root", "branch", {}).then((outcome) => {
				parentSettled = true;
				return outcome;
			});
			await Promise.all([childEntered.promise, hookEntered.promise]);
			const other = runner.execute("root", "otherBranch", {});
			try {
				await setImmediate();
				expect(phases).toContain("before:otherBranch");
				expect(phases).not.toContain("before:writer");
				(first === "child" ? releaseChild : releaseHook).resolve();
				await setImmediate();
				expect(phases).toContain(first === "child" ? "after:child" : "joined:parent-hook");
				expect(phases).not.toContain("before:writer");
				expect(parentSettled).toBe(false);
			} finally {
				releaseChild.resolve();
				releaseHook.resolve();
			}
			expect((await Promise.all([branch, other])).map((outcome) => outcome.isError)).toEqual([false, false]);
			expect(phases.indexOf("before:writer")).toBeGreaterThan(phases.indexOf("after:child"));
			expect(phases.indexOf("before:writer")).toBeGreaterThan(phases.indexOf("joined:parent-hook"));
			expect(runner.takeRecord("root")?.calls?.complete).toBe(true);
		},
		5000,
	);

	// smarty-dev#2241 A11: cancelling a queued call skips its hooks/execution and retains earlier exclusive barriers.
	it.each(["parallel", "sequential"] as const)("cancels a queued %s waiter without late dispatch", async (mode) => {
		const phases: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		const tools = [
			tool("blocker", "sequential", async () => {
				entered.resolve();
				await release.promise;
				return emptyResult();
			}),
			tool("cancelled", mode, async () => emptyResult()),
			tool("follower", "parallel", async () => emptyResult()),
		];
		const runner = runnerFor(tools, phases);
		const blocker = runner.execute("root", "blocker", {});
		await entered.promise;
		const cancelled = runner.execute("root", "cancelled", {}, { signal: controller.signal });
		const follower = runner.execute("root", "follower", {});
		controller.abort();
		try {
			const outcome = await cancelled;
			expect(outcome.isError).toBe(true);
			expect(outcome.result.content).toEqual([{ type: "text", text: "Operation aborted" }]);
			await setImmediate();
			expect(phases).toEqual(["before:blocker"]);
		} finally {
			release.resolve();
		}
		await Promise.all([blocker, follower]);
		expect(phases).toEqual(["before:blocker", "after:blocker", "before:follower", "after:follower"]);
		expect(runner.takeRecord("root")?.calls?.calls.find((call) => call.name === "cancelled")?.status).toBe("error");
	});

	// smarty-dev#2241 A11: retain a sequential parent's outer lease and recorder until accepted unawaited children join.
	it("joins accepted children before releasing parent exclusion", async () => {
		const phases: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const tools: AgentTool[] = [];
		const runner = runnerFor(tools, phases);
		tools.push(
			tool("parent", "sequential", async (id) => {
				void runner.execute(id, "child", {});
				return emptyResult();
			}),
			tool("child", "parallel", async () => {
				entered.resolve();
				await release.promise;
				return emptyResult();
			}),
			tool("outside", "parallel", async () => emptyResult()),
		);
		let parentSettled = false;
		const parent = runner.execute("root", "parent", {}).then((outcome) => {
			parentSettled = true;
			return outcome;
		});
		const outside = runner.execute("other-root", "outside", {});
		try {
			await entered.promise;
			await setImmediate();
			expect(parentSettled).toBe(false);
			expect(phases).not.toContain("before:outside");
		} finally {
			release.resolve();
		}
		await Promise.all([parent, outside]);
		expect(phases.indexOf("before:outside")).toBeGreaterThan(phases.indexOf("after:child"));
		expect(runner.takeRecord("root")?.calls?.complete).toBe(true);
	});
});

describe("AgentSession native and real Codemode tool contracts", () => {
	// smarty-dev#2241 A11: native mixed batches retain whole-batch, source-order execution.
	it("keeps the native whole batch atomic when one call is sequential", async () => {
		const phases: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const tools = [
			tool("first", "parallel", async () => {
				phases.push("first");
				entered.resolve();
				await release.promise;
				return emptyResult();
			}),
			tool("writer", "sequential", async () => {
				phases.push("writer");
				return emptyResult();
			}),
			tool("last", "parallel", async () => {
				phases.push("last");
				return emptyResult();
			}),
		];
		const harness = await createHarness({ tools, initialActiveToolNames: tools.map((entry) => entry.name) });
		harness.setResponses([
			fauxAssistantMessage(
				tools.map((entry) => fauxToolCall(entry.name, {})),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const running = harness.session.prompt("go");
		try {
			await entered.promise;
			await setImmediate();
			expect(phases).toEqual(["first"]);
		} finally {
			release.resolve();
			await running;
			harness.cleanup();
		}
		expect(phases).toEqual(["first", "writer", "last"]);
	});

	// smarty-dev#2241 A11: actual sandbox dispatch must not let a read observe an unfinished write.
	it("excludes real Codemode mixed siblings through SDK before/after hooks", async () => {
		const phases: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let written = false;
		const tools = [
			tool("write", "sequential", async () => {
				phases.push("execute:write");
				entered.resolve();
				await release.promise;
				written = true;
				return emptyResult();
			}),
			tool("read", "parallel", async () => {
				phases.push(`execute:read:${written}`);
				return { content: [{ type: "text", text: String(written) }], details: {} };
			}),
		];
		const harness = await createHarness({
			tools: [],
			initialActiveToolNames: ["codemode", "write", "read"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi) => {
					for (const entry of tools) pi.registerTool(createToolDefinitionFromAgentTool(entry));
				},
			],
		});
		const agent = harness.session.agent;
		const before = agent.beforeToolCall;
		const after = agent.afterToolCall;
		agent.beforeToolCall = async (context, signal) => {
			if (context.parentToolCallId) phases.push(`before:${context.toolCall.name}`);
			return before?.(context, signal);
		};
		agent.afterToolCall = async (context, signal) => {
			if (context.parentToolCallId) phases.push(`after:${context.toolCall.name}`);
			return after?.(context, signal);
		};
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"codemode",
					{ code: "const values = await Promise.all([tools.write({}), tools.read({})]); return values[1];" },
					{ id: "parent" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const running = harness.session.prompt("go");
		try {
			await entered.promise;
			await setImmediate();
			expect(phases).toEqual(["before:write", "execute:write"]);
			release.resolve();
			await running;
			const result = getToolResult(harness, "codemode");
			expect(result.isError).toBe(false);
			expect(getMessageText(result)).toContain("true");
			expect(phases).toEqual([
				"before:write",
				"execute:write",
				"after:write",
				"before:read",
				"execute:read:true",
				"after:read",
			]);
		} finally {
			release.resolve();
			await running;
			harness.cleanup();
		}
	});

	// smarty-dev#2241 A11: actual Codemode parallel composites retain ctx.executeTool ancestry and writer exclusion.
	it("serializes real Codemode cousin writers while both parallel parents are active", async () => {
		const parentsEntered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const allowChildren = Promise.withResolvers<void>();
		const effects: string[] = [];
		let active = 0;
		let peak = 0;
		const harness = await createHarness({
			tools: [],
			initialActiveToolNames: ["codemode", "parent0", "parent1", "child0", "child1"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi) => {
					for (let index = 0; index < 2; index++) {
						pi.registerTool({
							name: `parent${index}`,
							label: `Parent ${index}`,
							description: "Parallel composite",
							parameters: Type.Object({}),
							executionMode: "parallel",
							execute: async (_id, _args, _signal, _update, ctx) => {
								parentsEntered[index].resolve();
								await allowChildren.promise;
								const outcome = await ctx.executeTool(`child${index}`, {});
								expect(outcome.isError).toBe(false);
								return outcome.result;
							},
						});
						pi.registerTool(
							createToolDefinitionFromAgentTool(
								tool(`child${index}`, "sequential", async () => {
									peak = Math.max(peak, ++active);
									effects.push(`start:${index}`);
									entered[index].resolve();
									await release[index].promise;
									effects.push(`end:${index}`);
									active--;
									return emptyResult();
								}),
							),
						);
					}
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"codemode",
					{
						code: "const values = await Promise.all([tools.parent0({}), tools.parent1({})]); return values.length;",
					},
					{ id: "composite" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const running = harness.session.prompt("go");
		try {
			await Promise.all(parentsEntered.map((gate) => gate.promise));
			allowChildren.resolve();
			await entered[0].promise;
			await setImmediate();
			expect(effects).toEqual(["start:0"]);
			release[0].resolve();
			await entered[1].promise;
			expect(effects).toEqual(["start:0", "end:0", "start:1"]);
			release[1].resolve();
			await running;
			const result = getToolResult(harness, "codemode");
			expect(result.isError).toBe(false);
			expect(result.content.at(-1)).toEqual({ type: "text", text: "2" });
			expect(effects).toEqual(["start:0", "end:0", "start:1", "end:1"]);
			expect(peak).toBe(1);
			expect(active).toBe(0);
			expect(result.nestedCalls?.complete).toBe(true);
			expect(
				result.nestedCalls?.calls
					.filter((call) => call.name.startsWith("child"))
					.map((call) => [call.id, call.status]),
			).toEqual([
				["composite/1/1", "ok"],
				["composite/2/1", "ok"],
			]);
		} finally {
			allowChildren.resolve();
			for (const gate of release) gate.resolve();
			await running;
			harness.cleanup();
		}
	}, 10000);

	// smarty-dev#2241 A12: preserve null redaction through extension handlers, public SDK hooks and recursive Codemode calls.
	it.each([false, true])("retains null through the complete nested chain (replace text: %s)", async (replaceText) => {
		const parents: string[] = [];
		const schema = Type.Object({});
		const harness = await createHarness({
			tools: [],
			initialActiveToolNames: ["codemode", "structured", "relay"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi) => {
					pi.registerTool({
						name: "structured",
						label: "Structured",
						description: "Structured",
						parameters: schema,
						outputSchema: Type.Union([Type.Null(), Type.Object({ secret: Type.String() })]),
						execute: async () => ({
							content: [{ type: "text", text: "original" }],
							details: {},
							structuredContent: { secret: "private" },
						}),
					});
					pi.registerTool({
						name: "relay",
						label: "Relay",
						description: "Relay",
						parameters: schema,
						outputSchema: Type.Union([Type.Null(), Type.Object({ secret: Type.String() })]),
						execute: async (_id, _args, _signal, _update, ctx) => {
							const outcome = await ctx.executeTool("structured", {});
							expect(outcome.isError).toBe(false);
							expect(outcome.result.structuredContent).toBeNull();
							return outcome.result;
						},
					});
					pi.on("tool_result", (event) => {
						if (event.toolName !== "structured") return;
						return {
							structuredContent: null,
							...(replaceText ? { content: [{ type: "text" as const, text: "redacted" }] } : {}),
						};
					});
					pi.on("tool_result", (event) => {
						if (event.toolName !== "structured") return;
						expect(event.structuredContent).toBeNull();
						return { details: { audited: true } };
					});
				},
			],
		});
		const installed = harness.session.agent.afterToolCall;
		harness.session.agent.afterToolCall = async (context, signal) => {
			const override = await installed?.(context, signal);
			if (context.toolCall.name === "structured") {
				parents.push(context.parentToolCallId ?? "");
				expect(override?.structuredContent).toBeNull();
			}
			return override;
		};
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("codemode", { code: "return await tools.relay({});" }, { id: "parent" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		try {
			await harness.session.prompt("go");
			const result = getToolResult(harness, "codemode");
			expect(result.isError).toBe(false);
			expect(result.content.at(-1)).toEqual({ type: "text", text: "null" });
			expect(JSON.stringify(result)).not.toContain("private");
			expect(parents).toEqual(["parent/1"]);
			expect(
				harness
					.eventsOfType("tool_execution_end")
					.filter((event) => "parentToolCallId" in event)
					.map((event) => event.result.structuredContent),
			).toEqual([null, null]);
		} finally {
			harness.cleanup();
		}
	});
});
