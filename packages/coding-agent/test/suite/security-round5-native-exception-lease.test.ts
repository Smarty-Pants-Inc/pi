import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay, setImmediate } from "node:timers/promises";
import { type AgentTool, type AgentToolCallOutcome, runToolCall } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { writeFileAtomic } from "../../src/core/tools/atomic-write.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const empty = () => ({ content: [], details: {} });

async function fixture(fails: boolean, failure: unknown, replaceRequestHook: boolean, hookThrows = false) {
	const callbackEntered = Promise.withResolvers<void>();
	const releaseCallback = Promise.withResolvers<void>();
	const childEntered = Promise.withResolvers<void>();
	const releaseChild = Promise.withResolvers<void>();
	const childHookEntered = Promise.withResolvers<void>();
	const releaseChildHook = Promise.withResolvers<void>();
	const updateEntered = Promise.withResolvers<void>();
	const releaseUpdate = Promise.withResolvers<void>();
	const updateFailed = Promise.withResolvers<void>();
	const attempted = Promise.withResolvers<void>();
	const writerEntered = Promise.withResolvers<void>();
	const readerHookEntered = Promise.withResolvers<void>();
	const releaseReaderHook = Promise.withResolvers<void>();
	const writerHookEntered = Promise.withResolvers<void>();
	const releaseWriterHook = Promise.withResolvers<void>();
	const trace: string[] = [];
	let child: Promise<AgentToolCallOutcome> | undefined;
	const harness = await createHarness({
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
		tools: [
			createWriteTool("", {
				operations: {
					mkdir: async (path) => {
						await mkdir(path, { recursive: true });
					},
					writeFile: async (path, content) => {
						if (path.endsWith("child.txt")) {
							trace.push("child-entered");
							childEntered.resolve();
							await releaseChild.promise;
						} else {
							trace.push("writer-entered");
							writerEntered.resolve();
						}
						await writeFileAtomic(path, content);
						trace.push(path.endsWith("child.txt") ? "child-written" : "writer-written");
					},
				},
			}),
		],
		initialActiveToolNames: ["write", "reader", "branch"],
		extensionFactories: [
			(pi) => {
				pi.on("tool_execution_update", async (event) => {
					if (event.toolName !== "reader" || getMessageText(event.partialResult) !== "held") return;
					updateEntered.resolve();
					await releaseUpdate.promise;
					trace.push("update-drained");
				});
				pi.registerTool({
					name: "reader",
					label: "reader",
					description: "Native shared effect with owned work",
					executionMode: "parallel",
					executionKind: "effect",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, update, ctx) => {
						trace.push(`read:${await readFile(join(ctx.cwd, "effect.txt"), "utf8")}`);
						child = ctx.executeTool("write", { path: join(ctx.cwd, "child.txt"), content: "owned" });
						await childEntered.promise;
						update?.({ content: [{ type: "text", text: "held" }], details: {} });
						update?.({ content: [{ type: "text", text: "fail" }], details: {} });
						callbackEntered.resolve();
						await releaseCallback.promise;
						trace.push("callback-drained");
						return empty();
					},
				});
				pi.registerTool({
					name: "branch",
					label: "branch",
					description: "Parallel orchestration awaiting unrelated exclusive writer",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						await callbackEntered.promise;
						const writing = ctx.executeTool("write", { path: join(ctx.cwd, "effect.txt"), content: "new" });
						attempted.resolve();
						const outcome = await writing;
						expect(outcome.isError).toBe(false);
						return outcome.result;
					},
				});
			},
		],
	});
	harnesses.push(harness);
	await writeFile(join(harness.tempDir, "effect.txt"), "old");
	if (replaceRequestHook) {
		harness.session.agent.prepareRequest = (request) => ({
			context: { ...request.context, tools: harness.session.agent.state.tools },
		});
	}
	const after = harness.session.agent.afterToolCall;
	harness.session.agent.afterToolCall = async (context, signal) => {
		const result = await after?.(context, signal);
		if (context.toolCall.name === "reader") {
			trace.push("reader-hook");
			readerHookEntered.resolve();
			await releaseReaderHook.promise;
			trace.push("reader-hook-drained");
			if (hookThrows) throw new Error("ordinary after-hook failed");
		} else if (context.toolCall.name === "write") {
			if (context.toolCall.id.startsWith("reader/")) {
				childHookEntered.resolve();
				await releaseChildHook.promise;
				trace.push("child-hook-drained");
			} else {
				writerHookEntered.resolve();
				await releaseWriterHook.promise;
				trace.push("writer-hook-drained");
			}
		}
		return result;
	};
	harness.session.subscribe((event) => {
		if (event.type === "tool_execution_update" && event.toolName === "reader") {
			if (fails && getMessageText(event.partialResult) === "fail") {
				trace.push("first-update-failure");
				updateFailed.resolve();
				throw failure;
			}
		}
		if (event.type === "tool_execution_end") {
			trace.push(`end:${event.toolCallId}`);
			if (fails && event.toolName === "branch") throw new Error("later sibling end failure");
		}
		if (event.type === "agent_end" || event.type === "agent_settled") trace.push(event.type);
	});
	return {
		harness,
		trace,
		callbackEntered,
		releaseCallback,
		childEntered,
		releaseChild,
		childHookEntered,
		releaseChildHook,
		updateEntered,
		releaseUpdate,
		updateFailed,
		attempted,
		writerEntered,
		readerHookEntered,
		releaseReaderHook,
		writerHookEntered,
		releaseWriterHook,
		getChild: () => child,
	};
}

// #2241 / security round 5: exceptional native completion must retire admission before joining blocked siblings.
it.each([
	[false, false],
	[false, true],
	[true, false],
	[true, true],
] as const)(
	"releases failed native effect after owned work drains (undefined=%s, replaced projection=%s)",
	async (undefinedFailure, replaceRequestHook) => {
		const failure = undefinedFailure ? undefined : new Error("first native update failure");
		const f = await fixture(true, failure, replaceRequestHook);
		const { harness, trace } = f;
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("reader", {}, { id: "reader" }), fauxToolCall("branch", {}, { id: "branch" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		let done = false;
		const running = harness.session.prompt("go").then(() => {
			done = true;
		});
		const watchdog = setTimeout(() => {
			f.releaseCallback.resolve();
			f.releaseChild.resolve();
			f.releaseChildHook.resolve();
			f.releaseUpdate.resolve();
			f.releaseWriterHook.resolve();
			f.releaseReaderHook.resolve();
			void harness.session.abort();
		}, 8_000);
		try {
			await Promise.all([f.attempted.promise, f.updateFailed.promise, f.updateEntered.promise]);
			await setImmediate();
			expect(trace).toContain("read:old");
			expect(trace).not.toContain("writer-entered");
			expect(done).toBe(false);
			f.releaseCallback.resolve();
			f.releaseChild.resolve();
			await f.childHookEntered.promise;
			await setImmediate();
			expect(trace).not.toContain("writer-entered");
			f.releaseChildHook.resolve();
			await f.getChild();
			await setImmediate();
			expect(await readFile(join(harness.tempDir, "child.txt"), "utf8")).toBe("owned");
			expect(trace).toContain("callback-drained");
			expect(trace).not.toContain("writer-entered");
			expect(trace).not.toContain("update-drained");
			f.releaseUpdate.resolve();
			const progressed = await Promise.race([
				f.writerEntered.promise.then(() => true),
				delay(500).then(() => false),
			]);
			expect(trace).toContain("update-drained");
			expect(progressed, "writer blocked after native callback, child hooks and accepted updates drained").toBe(
				true,
			);
			await f.writerHookEntered.promise;
			expect(await readFile(join(harness.tempDir, "effect.txt"), "utf8")).toBe("new");
			expect(done).toBe(false);
			expect(harness.eventsOfType("agent_end")).toHaveLength(0);
			f.releaseWriterHook.resolve();
			await running;
			expect(trace).not.toContain("reader-hook");
			expect(trace).not.toContain("end:reader");
			expect(trace.indexOf("writer-hook-drained")).toBeLessThan(trace.indexOf("agent_end"));
			expect(harness.session.agent.state.errorMessage).toBe(
				undefinedFailure ? "undefined" : "first native update failure",
			);
			expect(harness.eventsOfType("agent_end")).toHaveLength(1);
			expect(harness.eventsOfType("agent_settled")[0].outcome).toBe("error");
			expect(harness.session.isIdle).toBe(true);
		} finally {
			f.releaseCallback.resolve();
			f.releaseChild.resolve();
			f.releaseChildHook.resolve();
			f.releaseUpdate.resolve();
			f.releaseWriterHook.resolve();
			f.releaseReaderHook.resolve();
			if (!done) void harness.session.abort();
			await running;
			clearTimeout(watchdog);
		}
	},
	10_000,
);

// #2241 countercase: successful callbacks and normalized after-hook errors keep normal completion ownership.
it.each([false, true])(
	"retains native admission through normal after-hook (throws=%s)",
	async (hookThrows) => {
		const f = await fixture(false, undefined, false, hookThrows);
		const { harness, trace } = f;
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("reader", {}, { id: "reader" }), fauxToolCall("branch", {}, { id: "branch" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const running = harness.session.prompt("go");
		const watchdog = setTimeout(() => {
			f.releaseCallback.resolve();
			f.releaseChild.resolve();
			f.releaseChildHook.resolve();
			f.releaseUpdate.resolve();
			f.releaseWriterHook.resolve();
			f.releaseReaderHook.resolve();
			void harness.session.abort();
		}, 8_000);
		try {
			await f.attempted.promise;
			f.releaseCallback.resolve();
			f.releaseChild.resolve();
			f.releaseChildHook.resolve();
			f.releaseUpdate.resolve();
			await f.readerHookEntered.promise;
			await setImmediate();
			expect(trace).not.toContain("writer-entered");
			expect(await readFile(join(harness.tempDir, "effect.txt"), "utf8")).toBe("old");
			f.releaseReaderHook.resolve();
			await f.writerHookEntered.promise;
			expect(trace.indexOf("reader-hook-drained")).toBeLessThan(trace.indexOf("writer-entered"));
			f.releaseWriterHook.resolve();
			await running;
			expect(await readFile(join(harness.tempDir, "effect.txt"), "utf8")).toBe("new");
			expect(getToolResult(harness, "reader").isError).toBe(hookThrows);
			expect(harness.session.agent.state.errorMessage).toBeUndefined();
		} finally {
			f.releaseCallback.resolve();
			f.releaseChild.resolve();
			f.releaseChildHook.resolve();
			f.releaseUpdate.resolve();
			f.releaseWriterHook.resolve();
			f.releaseReaderHook.resolve();
			await running;
			clearTimeout(watchdog);
		}
	},
	10_000,
);

// #2241 countercase: a synchronous update sink throw is an ordinary callback error, not exceptional completion.
it("normalizes synchronous update errors only after accepted update deliveries drain", async () => {
	const release = Promise.withResolvers<void>();
	const trace: string[] = [];
	const schema = Type.Object({});
	const tool: AgentTool<typeof schema> = {
		name: "ordinary",
		label: "ordinary",
		description: "ordinary",
		parameters: schema,
		execute: async (_id, _args, _signal, update) => {
			update?.(empty());
			update?.(empty());
			return empty();
		},
	};
	const failure = {
		toString: () => {
			trace.push("normalize");
			return "ordinary update error";
		},
	};
	let updates = 0;
	const running = runToolCall(fauxToolCall("ordinary", {}), {
		tools: [tool],
		context: { messages: [], tools: [tool] },
		assistantMessage: fauxAssistantMessage("issuer"),
		onUpdate: () => {
			if (++updates === 2) throw failure;
			return release.promise.then(() => {
				trace.push("update-drained");
			});
		},
		afterToolCall: async () => {
			trace.push("after");
			return undefined;
		},
	});
	try {
		await setImmediate();
		expect(trace).toEqual([]);
	} finally {
		release.resolve();
	}
	const outcome = await running;
	expect(outcome.isError).toBe(true);
	expect(getMessageText(outcome.result)).toBe("ordinary update error");
	expect(trace).toEqual(["update-drained", "normalize", "after"]);
}, 10_000);
