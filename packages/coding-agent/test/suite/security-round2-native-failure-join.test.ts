import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import {
	type AgentTool,
	type AgentToolCallOutcome,
	runToolCall,
	type ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../src/core/tools/atomic-write.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

interface FixtureOptions {
	mode?: ToolExecutionMode;
	sequentialTool?: boolean;
	parentThrows?: boolean;
	siblingThrows?: boolean;
	waitForChild?: boolean;
	updateCount?: number;
	holdSecondUpdate?: boolean;
	holdCallback?: boolean;
	holdNativeEnd?: boolean;
}

async function createFixture(options: FixtureOptions = {}) {
	const writeEntered = Promise.withResolvers<void>();
	const releaseWrite = Promise.withResolvers<void>();
	const hookEntered = Promise.withResolvers<void>();
	const releaseHook = Promise.withResolvers<void>();
	const updateEntered = Promise.withResolvers<void>();
	const releaseUpdate = Promise.withResolvers<void>();
	const secondUpdateEntered = Promise.withResolvers<void>();
	const releaseSecondUpdate = Promise.withResolvers<void>();
	const callbackEntered = Promise.withResolvers<void>();
	const releaseCallback = Promise.withResolvers<void>();
	const nativeEndEntered = Promise.withResolvers<void>();
	const releaseNativeEnd = Promise.withResolvers<void>();
	const trace: string[] = [];
	let child: Promise<AgentToolCallOutcome> | undefined;
	let childSignal: AbortSignal | undefined;
	const harness = await createHarness({
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
		tools: [
			createWriteTool("", {
				operations: {
					mkdir: async (path) => {
						await mkdir(path, { recursive: true });
					},
					writeFile: async (path, content) => {
						trace.push("write-start");
						writeEntered.resolve();
						await releaseWrite.promise;
						await writeFileAtomic(path, content);
						trace.push("write-done");
					},
				},
			}),
		],
		initialActiveToolNames: ["write", "P", "Q"],
		extensionFactories: [
			(pi) => {
				pi.on("tool_execution_end", async (event) => {
					if (event.toolName !== "P" || !options.holdNativeEnd) return;
					trace.push("extension:P-end");
					nativeEndEntered.resolve();
					await releaseNativeEnd.promise;
					trace.push("extension-done:P-end");
				});
				pi.on("tool_execution_update", async (event) => {
					if (event.toolName !== "Q") return;
					const update = getMessageText(event.partialResult);
					trace.push(`extension:${update}`);
					if (update === "U1" && options.updateCount === 2) {
						updateEntered.resolve();
						await releaseUpdate.promise;
					}
					if (update === "U2" && options.holdSecondUpdate) {
						secondUpdateEntered.resolve();
						await releaseSecondUpdate.promise;
					}
					trace.push(`extension-done:${update}`);
				});
				pi.registerTool({
					name: "P",
					label: "P",
					description: "Accept an unawaited child",
					executionMode: options.sequentialTool ? "sequential" : "parallel",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						trace.push("P-callback");
						child = ctx.executeTool("write", { path: join(ctx.cwd, "owned.txt"), content: "new" });
						if (options.parentThrows) throw new Error("P callback failed");
						return { content: [], details: {} };
					},
				});
				pi.registerTool({
					name: "Q",
					label: "Q",
					description: "Independent native sibling",
					executionMode: "parallel",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, update) => {
						trace.push("Q-callback");
						if (options.waitForChild !== false) await writeEntered.promise;
						for (let index = 1; index <= (options.updateCount ?? 0); index++) {
							update?.({ content: [{ type: "text", text: `U${index}` }], details: {} });
						}
						callbackEntered.resolve();
						if (options.holdCallback) await releaseCallback.promise;
						if (options.siblingThrows) throw new Error("Q callback failed");
						return { content: [], details: {} };
					},
				});
			},
		],
	});
	harnesses.push(harness);
	harness.session.agent.toolExecution = options.mode ?? "parallel";
	const path = join(harness.tempDir, "owned.txt");
	await writeFile(path, "old");
	const before = harness.session.agent.beforeToolCall;
	harness.session.agent.beforeToolCall = async (context, signal) => {
		trace.push(`before:${context.toolCall.name}`);
		if (context.toolCall.name === "write") childSignal = signal;
		return before?.(context, signal);
	};
	const after = harness.session.agent.afterToolCall;
	harness.session.agent.afterToolCall = async (context, signal) => {
		const result = await after?.(context, signal);
		trace.push(`after:${context.toolCall.name}`);
		if (context.toolCall.name === "write") {
			hookEntered.resolve();
			await releaseHook.promise;
			trace.push("hook-done");
		}
		return result;
	};
	harness.session.subscribe((event) => {
		if (event.type === "tool_execution_end") trace.push(`end:${event.toolName}`);
		if (event.type === "agent_end" || event.type === "agent_settled") trace.push(event.type);
	});
	return {
		harness,
		path,
		trace,
		writeEntered,
		releaseWrite,
		hookEntered,
		releaseHook,
		updateEntered,
		releaseUpdate,
		secondUpdateEntered,
		releaseSecondUpdate,
		callbackEntered,
		releaseCallback,
		nativeEndEntered,
		releaseNativeEnd,
		getChild: () => child,
		getChildSignal: () => childSignal,
		respond: (names: string[] = ["P", "Q"]) => {
			harness.setResponses([
				fauxAssistantMessage(
					names.map((name) => fauxToolCall(name, {}, { id: name })),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
		},
	};
}

function expectJoinedTerminal(harness: Harness, trace: string[]) {
	expect(harness.eventsOfType("agent_end")).toHaveLength(1);
	expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	expect(trace.indexOf("hook-done")).toBeLessThan(trace.indexOf("end:write"));
	expect(trace.indexOf("end:write")).toBeLessThan(trace.indexOf("agent_end"));
	expect(trace.indexOf("agent_end")).toBeLessThan(trace.indexOf("agent_settled"));
	const terminal = harness.events.findIndex((event) => event.type === "agent_end");
	expect(harness.events.slice(terminal + 1).filter((event) => event.type.startsWith("tool_execution_"))).toEqual([]);
	expect(harness.session.isIdle).toBe(true);
	expect(harness.session.agent.signal).toBeUndefined();
}

// #2241 R2-ASTRA-1: an event sink failure must join every already-started native entry.
describe("native parallel failure retirement", () => {
	it.each(["failure", "abort", "second failure"] as const)(
		"joins accepted atomic writes and public after-hooks before %s settlement",
		async (scenario) => {
			const fixture = await createFixture();
			const { harness, path, trace, writeEntered, releaseWrite, hookEntered, releaseHook } = fixture;
			const failed = Promise.withResolvers<void>();
			const original = new Error("Q native end listener failed");
			let thrown = false;
			harness.session.subscribe((event) => {
				if (event.type !== "tool_execution_end" || event.parentToolCallId) return;
				if (event.toolName === "Q" && !thrown) {
					thrown = true;
					failed.resolve();
					throw original;
				}
				if (event.toolName === "P" && scenario === "second failure") {
					throw new Error("P later native end listener failed");
				}
			});
			fixture.respond();
			let promptDone = false;
			let agentIdle = false;
			let sessionIdle = false;
			let abortDone = false;
			let abort: Promise<void> | undefined;
			const running = harness.session.prompt("go").then(() => {
				promptDone = true;
			});
			try {
				await failed.promise;
				await writeEntered.promise;
				const agentWait = harness.session.agent.waitForIdle().then(() => {
					agentIdle = true;
				});
				const sessionWait = harness.session.waitForIdle().then(() => {
					sessionIdle = true;
				});
				// Give failure handling a turn while both owned gates remain closed.
				await setTimeout(20);
				const duringWrite = {
					promptDone,
					agentIdle,
					sessionIdle,
					idle: harness.session.isIdle,
					activeSignal: harness.session.agent.signal !== undefined,
					ends: harness.eventsOfType("agent_end").length,
					settled: harness.eventsOfType("agent_settled").length,
				};
				if (scenario === "abort") {
					abort = harness.session.abort().then(() => {
						abortDone = true;
					});
					await setImmediate();
				}
				const abortWhileWriting = { done: abortDone, cancelled: fixture.getChildSignal()?.aborted };
				expect(await readFile(path, "utf8")).toBe("old");
				releaseWrite.resolve();
				await hookEntered.promise;
				await setImmediate();
				const duringHook = {
					promptDone,
					agentIdle,
					sessionIdle,
					abortDone,
					idle: harness.session.isIdle,
					ends: harness.eventsOfType("agent_end").length,
					settled: harness.eventsOfType("agent_settled").length,
				};
				expect(await readFile(path, "utf8")).toBe("new");
				releaseHook.resolve();
				await Promise.all([running, agentWait, sessionWait, abort, fixture.getChild()]);
				await setImmediate();
				expect(duringWrite).toEqual({
					promptDone: false,
					agentIdle: false,
					sessionIdle: false,
					idle: false,
					activeSignal: true,
					ends: 0,
					settled: 0,
				});
				expect(duringHook).toEqual({
					promptDone: false,
					agentIdle: false,
					sessionIdle: false,
					abortDone: false,
					idle: false,
					ends: 0,
					settled: 0,
				});
				if (scenario === "abort") expect(abortWhileWriting).toEqual({ done: false, cancelled: true });
				expect((await fixture.getChild())?.isError).toBe(scenario === "abort");
				expect(harness.session.agent.state.errorMessage).toBe(original.message);
				expect(harness.eventsOfType("agent_settled")[0].outcome).toBe(scenario === "abort" ? "aborted" : "error");
				expect(trace).toContain("after:P");
				expect(trace).toContain("after:Q");
				expectJoinedTerminal(harness, trace);
			} finally {
				releaseWrite.resolve();
				releaseHook.resolve();
				await Promise.all([running, abort, fixture.getChild()]);
				await setImmediate();
			}
		},
		10_000,
	);
});

// #2241: ordinary callback errors remain normalized results, with child draining and hooks intact.
it.each(["parent", "sibling"] as const)(
	"preserves parallel %s callback throw behavior",
	async (thrower) => {
		const fixture = await createFixture({ parentThrows: thrower === "parent", siblingThrows: thrower === "sibling" });
		const { harness, path, trace, writeEntered, releaseWrite, hookEntered, releaseHook } = fixture;
		fixture.respond();
		const running = harness.session.prompt("go");
		try {
			await writeEntered.promise;
			await setImmediate();
			expect(harness.session.isIdle).toBe(false);
			releaseWrite.resolve();
			await hookEntered.promise;
			await setImmediate();
			expect(harness.eventsOfType("agent_end")).toHaveLength(0);
		} finally {
			releaseWrite.resolve();
			releaseHook.resolve();
			await running;
		}
		expect(await readFile(path, "utf8")).toBe("new");
		expect((await fixture.getChild())?.isError).toBe(false);
		expect(getToolResult(harness, "P").isError).toBe(thrower === "parent");
		expect(getToolResult(harness, "Q").isError).toBe(thrower === "sibling");
		expect(getMessageText(getToolResult(harness, thrower === "parent" ? "P" : "Q"))).toContain("callback failed");
		expect(getToolResult(harness, "P").nestedCalls?.complete).toBe(true);
		expect(getToolResult(harness, "P").nestedCalls?.calls[0].status).toBe("ok");
		expect(trace).toContain("after:P");
		expect(trace).toContain("after:Q");
		expect(harness.session.agent.state.errorMessage).toBeUndefined();
		expect(
			harness
				.eventsOfType("message_end")
				.flatMap((event) => (event.message.role === "toolResult" ? [event.message.toolCallId] : [])),
		).toEqual(["P", "Q"]);
		expectJoinedTerminal(harness, trace);
	},
	10_000,
);

// #2241: sequential batches have no started sibling to drain; never start the suffix after sink failure.
it.each(["configuration", "descriptor"] as const)("preserves %s-driven sequential failure ordering", async (source) => {
	const fixture = await createFixture({
		mode: source === "configuration" ? "sequential" : "parallel",
		sequentialTool: source === "descriptor",
		waitForChild: false,
	});
	const { harness, trace } = fixture;
	harness.session.subscribe((event) => {
		if (event.type === "tool_execution_end" && event.toolName === "Q") throw new Error("sequential sink failed");
	});
	fixture.respond(["Q", "P"]);
	await harness.session.prompt("go");
	expect(trace).toContain("after:Q");
	expect(trace).not.toContain("before:P");
	expect(trace).not.toContain("P-callback");
	expect(trace).not.toContain("write-start");
	expect(fixture.getChild()).toBeUndefined();
	expect(harness.session.agent.state.errorMessage).toBe("sequential sink failed");
	expect(harness.eventsOfType("agent_settled")[0].outcome).toBe("error");
	expect(harness.session.isIdle).toBe(true);
	expect(await readFile(fixture.path, "utf8")).toBe("old");
});

// #2241: sequential callback errors still join their own children, then execute the next entry.
it("keeps sequential callback failure draining and continuation", async () => {
	const fixture = await createFixture({ mode: "sequential", parentThrows: true });
	const { harness, trace, writeEntered, releaseWrite, hookEntered, releaseHook } = fixture;
	fixture.respond();
	const running = harness.session.prompt("go");
	try {
		await writeEntered.promise;
		await setImmediate();
		expect(trace).not.toContain("Q-callback");
		releaseWrite.resolve();
		await hookEntered.promise;
		await setImmediate();
		expect(trace).not.toContain("Q-callback");
		expect(harness.session.isIdle).toBe(false);
	} finally {
		releaseWrite.resolve();
		releaseHook.resolve();
		await running;
	}
	expect(getToolResult(harness, "P").isError).toBe(true);
	expect(getToolResult(harness, "P").nestedCalls?.complete).toBe(true);
	expect(getToolResult(harness, "Q").isError).toBe(false);
	expect(trace.indexOf("end:P")).toBeLessThan(trace.indexOf("Q-callback"));
	expectJoinedTerminal(harness, trace);
}, 10_000);

// #2241 R1b-C1: first pipeline observation must survive another entry rejecting before the update drain.
it.each(["update first", "undefined first", "end first", "reversed source order"] as const)(
	"preserves cross-entry first cause: %s",
	async (scenario) => {
		const endFirst = scenario === "end first";
		const fixture = await createFixture({ updateCount: 2, holdCallback: true, holdSecondUpdate: endFirst });
		const { harness, trace } = fixture;
		const updateFailed = Promise.withResolvers<void>();
		const endFailed = Promise.withResolvers<void>();
		const updateError = scenario === "undefined first" ? undefined : new Error("Q update FIRST");
		const endError = new Error("P native end failure");
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_update" && event.toolName === "Q") {
				const update = getMessageText(event.partialResult);
				trace.push(`cross-public:${update}`);
				if (update === "U2") {
					trace.push("Q-update-failed");
					updateFailed.resolve();
					throw updateError;
				}
			}
			if (event.type === "tool_execution_end" && event.toolName === "P" && !event.parentToolCallId) {
				trace.push("P-end-failed");
				endFailed.resolve();
				throw endError;
			}
		});
		fixture.respond(scenario === "reversed source order" ? ["Q", "P"] : ["P", "Q"]);
		let promptDone = false;
		let agentIdle = false;
		let sessionIdle = false;
		const running = harness.session.prompt("go").then(() => {
			promptDone = true;
		});
		let agentWait: Promise<void> | undefined;
		let sessionWait: Promise<void> | undefined;
		try {
			await Promise.all([fixture.updateEntered.promise, fixture.callbackEntered.promise]);
			agentWait = harness.session.agent.waitForIdle().then(() => {
				agentIdle = true;
			});
			sessionWait = harness.session.waitForIdle().then(() => {
				sessionIdle = true;
			});
			if (!endFirst) {
				await updateFailed.promise;
				await setImmediate();
			}
			fixture.releaseCallback.resolve();
			fixture.releaseWrite.resolve();
			await fixture.hookEntered.promise;
			fixture.releaseHook.resolve();
			await Promise.all([fixture.getChild(), endFailed.promise]);
			await setImmediate();
			if (endFirst) {
				fixture.releaseSecondUpdate.resolve();
				await updateFailed.promise;
				await setImmediate();
			}
			expect(await readFile(fixture.path, "utf8")).toBe("new");
			expect(trace).toContain("write-done");
			expect(trace).toContain("hook-done");
			expect(trace.indexOf("hook-done")).toBeLessThan(trace.indexOf("P-end-failed"));
			expect(trace).not.toContain("cross-public:U1");
			expect({ promptDone, agentIdle, sessionIdle, idle: harness.session.isIdle }).toEqual({
				promptDone: false,
				agentIdle: false,
				sessionIdle: false,
				idle: false,
			});
			expect(harness.session.agent.signal).toBeDefined();
			expect(harness.eventsOfType("agent_end")).toHaveLength(0);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
			const first = endFirst ? "P-end-failed" : "Q-update-failed";
			const second = endFirst ? "Q-update-failed" : "P-end-failed";
			expect(trace.indexOf(first)).toBeLessThan(trace.indexOf(second));
			fixture.releaseUpdate.resolve();
			await Promise.all([running, agentWait, sessionWait]);
			expect(trace).toContain("extension-done:U1");
			expect(trace).toContain("cross-public:U1");
			expect(trace).toContain("after:P");
			expect(trace).not.toContain("after:Q");
			expectJoinedTerminal(harness, trace);
			expect(harness.session.agent.state.errorMessage).toBe(
				endFirst ? endError.message : updateError instanceof Error ? updateError.message : "undefined",
			);
		} finally {
			fixture.releaseCallback.resolve();
			fixture.releaseWrite.resolve();
			fixture.releaseHook.resolve();
			fixture.releaseUpdate.resolve();
			fixture.releaseSecondUpdate.resolve();
			await Promise.all([running, agentWait, sessionWait, fixture.getChild()]);
		}
	},
	10_000,
);

// #2241 R1b-C1: adjacent sink rejections must share an observation boundary, not entry unwind depth.
it.each([
	"end first",
	"undefined end first",
	"reversed end first",
	"reversed undefined end first",
	"update first",
	"undefined update first",
	"reversed update first",
	"reversed undefined update first",
])(
	"preserves adjacent public first cause: %s",
	async (scenario) => {
		const endFirst = scenario.includes("end first");
		const undefinedFirst = scenario.includes("undefined");
		const fixture = await createFixture({
			updateCount: 2,
			holdCallback: true,
			holdSecondUpdate: true,
			holdNativeEnd: true,
		});
		const { harness, trace } = fixture;
		const endError = endFirst && undefinedFirst ? undefined : new Error("P adjacent end failure");
		const updateError = !endFirst && undefinedFirst ? undefined : new Error("Q adjacent update failure");
		const endFailed = Promise.withResolvers<void>();
		const updateFailed = Promise.withResolvers<void>();
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "P" && !event.parentToolCallId) {
				trace.push("adjacent-public:P");
				endFailed.resolve();
				throw endError;
			}
			if (event.type === "tool_execution_update" && event.toolName === "Q") {
				const update = getMessageText(event.partialResult);
				trace.push(`adjacent-public:${update}`);
				if (update === "U2") {
					updateFailed.resolve();
					throw updateError;
				}
			}
		});
		fixture.respond(scenario.includes("reversed") ? ["Q", "P"] : ["P", "Q"]);
		let promptDone = false;
		let agentIdle = false;
		let sessionIdle = false;
		const running = harness.session.prompt("go").then(() => {
			promptDone = true;
		});
		let agentWait: Promise<void> | undefined;
		let sessionWait: Promise<void> | undefined;
		try {
			await Promise.all([
				fixture.updateEntered.promise,
				fixture.secondUpdateEntered.promise,
				fixture.callbackEntered.promise,
			]);
			agentWait = harness.session.agent.waitForIdle().then(() => {
				agentIdle = true;
			});
			sessionWait = harness.session.waitForIdle().then(() => {
				sessionIdle = true;
			});
			fixture.releaseCallback.resolve();
			fixture.releaseWrite.resolve();
			await fixture.hookEntered.promise;
			fixture.releaseHook.resolve();
			await Promise.all([fixture.getChild(), fixture.nativeEndEntered.promise]);
			expect(trace).toContain("extension:U1");
			expect(trace).toContain("extension:U2");
			expect(trace).toContain("extension:P-end");
			expect(trace.filter((entry) => entry.startsWith("adjacent-public:"))).toEqual([]);
			// Release both awaited receivers in one continuation: no yield between releases.
			if (endFirst) {
				fixture.releaseNativeEnd.resolve();
				fixture.releaseSecondUpdate.resolve();
			} else {
				fixture.releaseSecondUpdate.resolve();
				fixture.releaseNativeEnd.resolve();
			}
			await Promise.all([endFailed.promise, updateFailed.promise]);
			await setImmediate();
			expect(trace.filter((entry) => entry.startsWith("adjacent-public:"))).toEqual(
				endFirst ? ["adjacent-public:P", "adjacent-public:U2"] : ["adjacent-public:U2", "adjacent-public:P"],
			);
			expect(await readFile(fixture.path, "utf8")).toBe("new");
			expect(trace).toContain("write-done");
			expect(trace.indexOf("hook-done")).toBeLessThan(trace.indexOf("adjacent-public:P"));
			expect(trace).not.toContain("extension-done:U1");
			expect({ promptDone, agentIdle, sessionIdle, idle: harness.session.isIdle }).toEqual({
				promptDone: false,
				agentIdle: false,
				sessionIdle: false,
				idle: false,
			});
			expect(harness.session.agent.signal).toBeDefined();
			expect(harness.eventsOfType("agent_end")).toHaveLength(0);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
			fixture.releaseUpdate.resolve();
			await Promise.all([running, agentWait, sessionWait]);
			expect(trace).toContain("extension-done:U1");
			expect(trace).toContain("adjacent-public:U1");
			expect(trace).toContain("after:P");
			expect(trace).not.toContain("after:Q");
			expectJoinedTerminal(harness, trace);
			const firstError = endFirst ? endError : updateError;
			expect(harness.session.agent.state.errorMessage).toBe(
				firstError instanceof Error ? firstError.message : "undefined",
			);
		} finally {
			fixture.releaseCallback.resolve();
			fixture.releaseWrite.resolve();
			fixture.releaseHook.resolve();
			fixture.releaseNativeEnd.resolve();
			fixture.releaseSecondUpdate.resolve();
			fixture.releaseUpdate.resolve();
			await Promise.all([running, agentWait, sessionWait, fixture.getChild()]);
		}
	},
	10_000,
);

// #2241 R2-ASTRA-1b: accepted native update deliveries must drain even after a sibling update rejects.
describe("native update delivery drain", () => {
	// #2241 R1b-C1: direct calls retain their local failure and skip the after-hook only after draining.
	it.each([false, true])("preserves direct runToolCall async failure: undefined=%s", async (undefinedFailure) => {
		const release = Promise.withResolvers<void>();
		const failure = undefinedFailure ? undefined : new Error("direct async update failed");
		const trace: string[] = [];
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "direct",
			label: "direct",
			description: "direct",
			parameters: schema,
			execute: async (_id, _args, _signal, update) => {
				update?.({ content: [], details: {} });
				update?.({ content: [], details: {} });
				return { content: [], details: {} };
			},
		};
		let count = 0;
		let done = false;
		const running = runToolCall(fauxToolCall("direct", {}), {
			tools: [tool],
			context: { messages: [], tools: [tool] },
			assistantMessage: fauxAssistantMessage("issuer"),
			onUpdate: () =>
				++count === 1
					? release.promise.then(() => {
							trace.push("update-done");
						})
					: Promise.reject(failure),
			afterToolCall: async () => {
				trace.push("after");
				return undefined;
			},
		}).then(
			() => {
				done = true;
				return { rejected: false, error: undefined };
			},
			(error: unknown) => {
				done = true;
				return { rejected: true, error };
			},
		);
		try {
			await setImmediate();
			expect(done).toBe(false);
			expect(trace).toEqual([]);
		} finally {
			release.resolve();
		}
		expect(await running).toEqual({ rejected: true, error: failure });
		expect(trace).toEqual(["update-done"]);
	});

	// #2241: synchronous sink throws remain callback errors; normalization and hooks follow accepted joins.
	it.each(["sink", "callback"] as const)("drains before normalizing a synchronous %s throw", async (thrower) => {
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const trace: string[] = [];
		const failure = {
			toString: () => {
				trace.push("normalize");
				return "ordinary failure";
			},
		};
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "ordinary",
			label: "ordinary",
			description: "ordinary",
			parameters: schema,
			execute: async (_id, _args, _signal, update) => {
				update?.({ content: [], details: {} });
				if (thrower === "sink") update?.({ content: [], details: {} });
				throw failure;
			},
		};
		let count = 0;
		let done = false;
		const running = runToolCall(fauxToolCall("ordinary", {}, { id: "ordinary" }), {
			tools: [tool],
			context: { messages: [], tools: [tool] },
			assistantMessage: fauxAssistantMessage("issuer"),
			onUpdate: () => {
				if (++count === 2) throw failure;
				entered.resolve();
				return release.promise.then(() => {
					trace.push("update-done");
				});
			},
			afterToolCall: async ({ isError }) => {
				expect(isError).toBe(true);
				trace.push("after");
				return undefined;
			},
		}).then((outcome) => {
			done = true;
			return outcome;
		});
		try {
			await entered.promise;
			await setImmediate();
			expect(done).toBe(false);
			expect(trace).toEqual([]);
		} finally {
			release.resolve();
		}
		const outcome = await running;
		expect(outcome.isError).toBe(true);
		expect(getMessageText(outcome.result)).toBe("ordinary failure");
		expect(trace).toEqual(["update-done", "normalize", "after"]);
	});

	it.each(["failure", "abort", "later failure", "undefined failure"] as const)(
		"retains custody through held U1 after U2 %s",
		async (scenario) => {
			const fixture = await createFixture({ updateCount: 2, holdCallback: true });
			const { harness, trace } = fixture;
			const failed = Promise.withResolvers<void>();
			const original = scenario === "undefined failure" ? undefined : new Error("U2 public listener failed");
			let thrown = false;
			harness.session.subscribe((event) => {
				if (event.type !== "tool_execution_update" || event.toolName !== "Q") return;
				const update = getMessageText(event.partialResult);
				trace.push(`public:${update}`);
				if (update === "U2" && !thrown) {
					thrown = true;
					failed.resolve();
					throw original;
				}
				if (update === "U1" && (scenario === "later failure" || scenario === "undefined failure")) {
					throw new Error("U1 later public listener failed");
				}
			});
			fixture.respond();
			let promptDone = false;
			let agentIdle = false;
			let sessionIdle = false;
			let abortDone = false;
			let abort: Promise<void> | undefined;
			const running = harness.session.prompt("go").then(() => {
				promptDone = true;
			});
			try {
				await Promise.all([fixture.updateEntered.promise, failed.promise, fixture.callbackEntered.promise]);
				// U2 rejects while the callback is still live: it must already have a rejection observer.
				await setTimeout(20);
				fixture.releaseCallback.resolve();
				const agentWait = harness.session.agent.waitForIdle().then(() => {
					agentIdle = true;
				});
				const sessionWait = harness.session.waitForIdle().then(() => {
					sessionIdle = true;
				});
				fixture.releaseWrite.resolve();
				await fixture.hookEntered.promise;
				fixture.releaseHook.resolve();
				await fixture.getChild();
				await setTimeout(20);
				const held = {
					promptDone,
					agentIdle,
					sessionIdle,
					idle: harness.session.isIdle,
					activeSignal: harness.session.agent.signal !== undefined,
					ends: harness.eventsOfType("agent_end").length,
					settled: harness.eventsOfType("agent_settled").length,
				};
				if (scenario === "abort") {
					abort = harness.session.abort().then(() => {
						abortDone = true;
					});
					await setImmediate();
				}
				const heldAbort = {
					abortDone,
					owned: harness.session.agent.signal !== undefined,
					aborted: harness.session.agent.signal?.aborted,
				};
				expect(await readFile(fixture.path, "utf8")).toBe("new");
				fixture.releaseUpdate.resolve();
				await Promise.all([running, agentWait, sessionWait, abort]);
				await setImmediate();
				expect(held).toEqual({
					promptDone: false,
					agentIdle: false,
					sessionIdle: false,
					idle: false,
					activeSignal: true,
					ends: 0,
					settled: 0,
				});
				if (scenario === "abort") expect(heldAbort).toEqual({ abortDone: false, owned: true, aborted: true });
				expect(trace).toContain("extension:U1");
				expect(trace).toContain("extension-done:U1");
				expect(trace).toContain("public:U1");
				expect(trace).toContain("public:U2");
				expect(
					harness.eventsOfType("tool_execution_update").filter((event) => event.toolName === "Q"),
				).toHaveLength(2);
				expect(trace.indexOf("public:U1")).toBeLessThan(trace.indexOf("agent_end"));
				expect(trace).toContain("after:P");
				expect(trace).not.toContain("after:Q");
				expect(harness.session.agent.state.errorMessage).toBe(
					original instanceof Error ? original.message : "undefined",
				);
				expectJoinedTerminal(harness, trace);
			} finally {
				fixture.releaseCallback.resolve();
				fixture.releaseWrite.resolve();
				fixture.releaseHook.resolve();
				fixture.releaseUpdate.resolve();
				await Promise.all([running, abort, fixture.getChild()]);
				await setImmediate();
			}
		},
		10_000,
	);

	it.each([false, true])(
		"drains successful updates before normal callback-error normalization: throw=%s",
		async (throws) => {
			const fixture = await createFixture({ updateCount: 2, siblingThrows: throws });
			const { harness, trace } = fixture;
			fixture.respond();
			const running = harness.session.prompt("go");
			try {
				await fixture.updateEntered.promise;
				fixture.releaseWrite.resolve();
				await fixture.hookEntered.promise;
				fixture.releaseHook.resolve();
				await fixture.getChild();
				await setTimeout(20);
				expect(harness.session.isIdle).toBe(false);
				expect(trace).not.toContain("after:Q");
			} finally {
				fixture.releaseWrite.resolve();
				fixture.releaseHook.resolve();
				fixture.releaseUpdate.resolve();
				await running;
			}
			expect(getToolResult(harness, "Q").isError).toBe(throws);
			if (throws) expect(getMessageText(getToolResult(harness, "Q"))).toContain("Q callback failed");
			expect(trace).toContain("after:Q");
			expect(harness.eventsOfType("tool_execution_update").filter((event) => event.toolName === "Q")).toHaveLength(
				2,
			);
			expect(harness.session.agent.state.errorMessage).toBeUndefined();
			expectJoinedTerminal(harness, trace);
		},
	);

	it("propagates a single failed update without pending peers", async () => {
		const fixture = await createFixture({ updateCount: 1 });
		const { harness, trace } = fixture;
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_update" && event.toolName === "Q") throw new Error("single update failed");
		});
		fixture.respond();
		const running = harness.session.prompt("go");
		fixture.releaseWrite.resolve();
		await fixture.hookEntered.promise;
		fixture.releaseHook.resolve();
		await running;
		expect(harness.session.agent.state.errorMessage).toBe("single update failed");
		expect(trace).not.toContain("after:Q");
		expectJoinedTerminal(harness, trace);
	});

	it("retains U1 failure when U2 rejects later", async () => {
		const fixture = await createFixture({ updateCount: 2, holdSecondUpdate: true });
		const { harness, trace } = fixture;
		const first = Promise.withResolvers<void>();
		harness.session.subscribe((event) => {
			if (event.type !== "tool_execution_update" || event.toolName !== "Q") return;
			const update = getMessageText(event.partialResult);
			if (update === "U1") first.resolve();
			throw new Error(`${update} failed`);
		});
		fixture.respond();
		const running = harness.session.prompt("go");
		try {
			await Promise.all([fixture.updateEntered.promise, fixture.secondUpdateEntered.promise]);
			fixture.releaseUpdate.resolve();
			await first.promise;
			await setImmediate();
			fixture.releaseWrite.resolve();
			await fixture.hookEntered.promise;
			fixture.releaseHook.resolve();
			await fixture.getChild();
			await setTimeout(20);
			expect(harness.session.isIdle).toBe(false);
		} finally {
			fixture.releaseWrite.resolve();
			fixture.releaseHook.resolve();
			fixture.releaseUpdate.resolve();
			fixture.releaseSecondUpdate.resolve();
			await running;
		}
		expect(harness.session.agent.state.errorMessage).toBe("U1 failed");
		expect(trace).not.toContain("after:Q");
		expectJoinedTerminal(harness, trace);
	});
});
