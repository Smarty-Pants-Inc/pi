import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay, setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
const empty = () => ({ content: [], details: {} });

// #2241 R2-ASTRA-3: registry replacement must not change an already admitted callback's contract.
describe("nested registry snapshot admission", () => {
	it.each(["start", "before", "unchanged"] as const)(
		"pins the admitted instance with replacement at %s",
		async (replacementAt) => {
			const writerEntered = Promise.withResolvers<void>();
			const releaseWriter = Promise.withResolvers<void>();
			const attempted = Promise.withResolvers<void>();
			let writerActive = false;
			let overlap = false;
			let originals = 0;
			let replacements = 0;
			const observations: string[] = [];
			const hookCalls: string[] = [];
			let harness: Harness;
			harness = await createHarness({
				initialActiveToolNames: ["writer", "target", "writer_branch", "target_branch", "root"],
				extensionFactories: [
					(pi) => {
						const replacement: ToolDefinition = {
							name: "target",
							label: "target",
							description: "Replacement effect reader",
							executionMode: "parallel",
							executionKind: "effect",
							parameters: Type.Object({}),
							execute: async (_id, _args, _signal, _update, ctx) => {
								replacements++;
								overlap ||= writerActive;
								observations.push(await readFile(join(ctx.cwd, "effect.txt"), "utf8"));
								return { content: [{ type: "text", text: "private replacement" }], details: {} };
							},
						};
						pi.registerTool({
							...replacement,
							description: "Original orchestration callback",
							executionKind: "orchestration",
							execute: async () => {
								originals++;
								return { content: [{ type: "text", text: "private original" }], details: {} };
							},
						});
						pi.on("tool_execution_start", (event) => {
							if (event.toolName !== "target" || !event.parentToolCallId) return;
							if (replacementAt === "start" && originals + replacements === 0) pi.registerTool(replacement);
							// Public hooks replaced from the observer must still govern this admitted call.
							harness.session.agent.beforeToolCall = async (context) => {
								if (context.toolCall.name === "target") hookCalls.push(`before:${context.parentToolCallId}`);
								return undefined;
							};
							harness.session.agent.afterToolCall = async (context) => {
								if (context.toolCall.name !== "target") return undefined;
								hookCalls.push(`after:${context.parentToolCallId}`);
								return { content: [{ type: "text", text: "redacted" }] };
							};
							attempted.resolve();
						});
						pi.registerTool({
							name: "writer",
							label: "writer",
							description: "Gated exclusive filesystem effect",
							executionMode: "sequential",
							executionKind: "effect",
							parameters: Type.Object({}),
							execute: async (_id, _args, _signal, _update, ctx) => {
								writerActive = true;
								writerEntered.resolve();
								await releaseWriter.promise;
								await writeFile(join(ctx.cwd, "effect.txt"), "new");
								writerActive = false;
								return empty();
							},
						});
						for (const name of ["writer_branch", "target_branch", "root"]) {
							pi.registerTool({
								name,
								label: name,
								description: "Parallel orchestration",
								executionKind: "orchestration",
								parameters: Type.Object({}),
								execute: async (_id, _args, _signal, _update, ctx) => {
									if (name === "writer_branch") return (await ctx.executeTool("writer", {})).result;
									if (name === "target_branch") {
										await writerEntered.promise;
										if (replacementAt === "before") pi.registerTool(replacement);
										const outcome = await ctx.executeTool("target", {});
										expect(outcome.isError).toBe(false);
										expect(getMessageText(outcome.result)).toBe("redacted");
										return outcome.result;
									}
									await Promise.all([
										ctx.executeTool("writer_branch", {}),
										ctx.executeTool("target_branch", {}),
									]);
									return empty();
								},
							});
						}
					},
				],
			});
			harnesses.push(harness);
			await writeFile(join(harness.tempDir, "effect.txt"), "old");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("root", {}, { id: "issuer" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			const running = harness.session.prompt("go");
			try {
				await attempted.promise;
				await delay(25);
				expect(overlap).toBe(false);
				expect(replacements).toBe(0);
				expect(originals).toBe(replacementAt === "before" ? 0 : 1);
			} finally {
				releaseWriter.resolve();
				await running;
			}
			expect(getToolResult(harness, "root").isError).toBe(false);
			expect(getToolResult(harness, "root").nestedCalls?.complete).toBe(true);
			expect(hookCalls).toEqual(["before:issuer/2", "after:issuer/2"]);
			if (replacementAt !== "unchanged") {
				expect(observations).toEqual(replacementAt === "before" ? ["new"] : []);
				// The snapshot is per call, not permanent: subsequent dispatch sees the new registration.
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("target_branch", {}), { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("again");
				expect(observations.at(-1)).toBe("new");
				expect(replacements).toBe(replacementAt === "before" ? 2 : 1);
			}
		},
		5000,
	);
});

// #2241 R2-ASTRA-3: a shared-to-exclusive replacement must not run with its predecessor's shared ticket.
it("pins a shared effect rather than upgrading it beneath an active shared cousin", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const attempted = Promise.withResolvers<void>();
	let readerActive = false;
	let invalidOverlap = false;
	let originalCalls = 0;
	let replacementCalls = 0;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				const target: ToolDefinition = {
					name: "target",
					label: "target",
					description: "Shared effect",
					executionKind: "effect",
					parameters: Type.Object({}),
					execute: async () => {
						originalCalls++;
						return empty();
					},
				};
				pi.registerTool(target);
				pi.on("tool_execution_start", (event) => {
					if (event.toolName !== "target" || !event.parentToolCallId) return;
					pi.registerTool({
						...target,
						executionMode: "sequential",
						execute: async (_id, _args, _signal, _update, ctx) => {
							replacementCalls++;
							invalidOverlap ||= readerActive;
							await writeFile(join(ctx.cwd, "replacement.txt"), "written");
							return empty();
						},
					});
					attempted.resolve();
				});
				pi.registerTool({
					name: "reader",
					label: "reader",
					description: "Shared cousin",
					executionKind: "effect",
					parameters: Type.Object({}),
					execute: async () => {
						readerActive = true;
						entered.resolve();
						await release.promise;
						readerActive = false;
						return empty();
					},
				});
				pi.registerTool({
					name: "branch",
					label: "branch",
					description: "Orchestration",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						await entered.promise;
						return (await ctx.executeTool("target", {})).result;
					},
				});
			},
		],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("reader", {}), fauxToolCall("branch", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const running = harness.session.prompt("go");
	try {
		await attempted.promise;
		await delay(25);
		expect(invalidOverlap).toBe(false);
		expect(originalCalls).toBe(1);
		expect(replacementCalls).toBe(0);
	} finally {
		release.resolve();
		await running;
	}
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("target", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("again");
	expect(replacementCalls).toBe(1);
	expect(await readFile(join(harness.tempDir, "replacement.txt"), "utf8")).toBe("written");
}, 5000);

// #2241 R2-ASTRA-3/F1: pinning code must never pin or bypass dispatch-time permission hooks.
it("honors a permission hook replaced by the start observer before pinned execution", async () => {
	let executions = 0;
	let harness: Harness;
	harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "target",
					label: "target",
					description: "Original",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async () => {
						executions++;
						return empty();
					},
				});
				pi.on("tool_execution_start", (event) => {
					if (event.toolName !== "target" || !event.parentToolCallId) return;
					harness.session.agent.beforeToolCall = async (context) =>
						context.toolCall.name === "target" ? { block: true, reason: "current permission denied" } : undefined;
				});
				pi.registerTool({
					name: "branch",
					label: "branch",
					description: "Orchestration",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => (await ctx.executeTool("target", {})).result,
				});
			},
		],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("branch", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	expect(executions).toBe(0);
	expect(getMessageText(getToolResult(harness, "branch"))).toContain("current permission denied");
	expect(getToolResult(harness, "branch").nestedCalls?.calls[0].status).toBe("error");
});

// #2241 R2-ASTRA-4: bare session-registry execution has no native completion event to release its lease.
describe("direct wrapped-tool completion", () => {
	it.each(["direct", "next prompt"] as const)(
		"read then %s write completes without a leaked ticket",
		async (route) => {
			const harness = await createHarness({ tools: [createReadTool(""), createWriteTool("")] });
			harnesses.push(harness);
			const path = join(harness.tempDir, "effect.txt");
			await writeFile(path, "old");
			const read = harness.session.agent.state.tools.find((tool) => tool.name === "read")!;
			const write = harness.session.agent.state.tools.find((tool) => tool.name === "write")!;
			expect(getMessageText(await read.execute("manual-read", { path }))).toContain("old");
			expect(harness.eventsOfType("tool_execution_end")).toHaveLength(0);
			if (route === "direct") {
				const controller = new AbortController();
				const deadline = setTimeout(() => controller.abort(), 300);
				try {
					await write.execute("manual-write", { path, content: "new" }, controller.signal);
				} finally {
					clearTimeout(deadline);
				}
				expect(controller.signal.aborted).toBe(false);
			} else {
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("write", { path, content: "new" }), { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				const deadline = setTimeout(() => void harness.session.abort(), 300);
				try {
					await harness.session.prompt("write");
				} finally {
					clearTimeout(deadline);
				}
				expect(getToolResult(harness, "write").isError).toBe(false);
			}
			expect(await readFile(path, "utf8")).toBe("new");
			expect(harness.session.isIdle).toBe(true);
			if (route === "direct") {
				// Both bare read and bare write must retire before the next native run.
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("write", { path, content: "next" }), { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				const deadline = setTimeout(() => void harness.session.abort(), 300);
				try {
					await harness.session.prompt("again");
				} finally {
					clearTimeout(deadline);
				}
				expect(getToolResult(harness, "write").isError).toBe(false);
				expect(await readFile(path, "utf8")).toBe("next");
			}
		},
		5000,
	);

	// #2241: direct callback retirement must join accepted children and reject old contexts even with reused ids.
	it("joins direct children before releasing and never revives a retired invocation", async () => {
		const childEntered = Promise.withResolvers<void>();
		const releaseChild = Promise.withResolvers<void>();
		let captured: ExtensionToolContext | undefined;
		const childErrors: boolean[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "child",
						label: "child",
						description: "Gated child",
						executionKind: "effect",
						parameters: Type.Object({}),
						execute: async () => {
							childEntered.resolve();
							await releaseChild.promise;
							return empty();
						},
					});
					pi.registerTool({
						name: "parent",
						label: "parent",
						description: "Direct parent",
						executionKind: "orchestration",
						executionMode: "sequential",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => {
							captured = ctx;
							void ctx.executeTool("child", {}).then((outcome) => childErrors.push(outcome.isError));
							return empty();
						},
					});
				},
			],
		});
		harnesses.push(harness);
		// A real faux turn supplies the issuer required by the public nested pipeline.
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("seed");
		const parent = harness.session.agent.state.tools.find((tool) => tool.name === "parent")!;
		let settled = false;
		const direct = parent.execute("reused", {}).then(() => {
			settled = true;
		});
		await childEntered.promise;
		const writer = harness.session.agent.state.tools.find((tool) => tool.name === "write")!;
		let writerSettled = false;
		const controller = new AbortController();
		const deadline = setTimeout(() => controller.abort(), 1000);
		const writing = writer
			.execute("outside", { path: join(harness.tempDir, "outside.txt"), content: "new" }, controller.signal)
			.then(() => {
				writerSettled = true;
			});
		try {
			await setImmediate();
			expect(settled).toBe(false);
			expect(writerSettled).toBe(false);
		} finally {
			releaseChild.resolve();
			try {
				await Promise.all([direct, writing]);
			} finally {
				clearTimeout(deadline);
			}
		}
		expect(writerSettled).toBe(true);
		const old = captured!;
		await parent.execute("reused", {});
		expect(childErrors).toEqual([false, false]);
		expect(captured).not.toBe(old);
		expect((await old.executeTool("child", {})).isError).toBe(true);
	});
});

// #2241 R2-ASTRA-4: a deferred bare call must not inherit an expired native completion owner, even with a reused id.
it("does not revive native completion ownership in a deferred direct invocation", async () => {
	const release = Promise.withResolvers<void>();
	let deferred: Promise<unknown> | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi) =>
				pi.registerTool({
					name: "spawner",
					label: "spawner",
					description: "Schedule a future bare invocation",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async (id, _args, _signal, _update, ctx) => {
						const reader = ctx.tools.find((tool) => tool.name === "read")!;
						deferred = release.promise.then(() => reader.execute(id, { path: join(ctx.cwd, "effect.txt") }));
						return empty();
					},
				}),
		],
	});
	harnesses.push(harness);
	const path = join(harness.tempDir, "effect.txt");
	await writeFile(path, "old");
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("spawner", {}, { id: "issuer" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	release.resolve();
	await deferred;
	const writer = harness.session.agent.state.tools.find((tool) => tool.name === "write")!;
	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), 300);
	try {
		await writer.execute("manual-write", { path, content: "new" }, controller.signal);
	} finally {
		clearTimeout(deadline);
	}
	expect(controller.signal.aborted).toBe(false);
	expect(await readFile(path, "utf8")).toBe("new");
});

// #2241 countercase: native start/preparation must not acquire an effect ticket before execute.
it("allows a direct writer during native reader preparation", async () => {
	const harness = await createHarness({ tools: [createReadTool(""), createWriteTool("")] });
	harnesses.push(harness);
	const path = join(harness.tempDir, "preparation.txt");
	await writeFile(path, "old");
	harness.session.agent.beforeToolCall = async (context) => {
		if (context.toolCall.name !== "read") return undefined;
		const writer = harness.session.agent.state.tools.find((tool) => tool.name === "write")!;
		await writer.execute("preparation-write", { path, content: "prepared" }, AbortSignal.timeout(300));
		return undefined;
	};
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const deadline = setTimeout(() => void harness.session.abort(), 1000);
	try {
		await harness.session.prompt("go");
	} finally {
		clearTimeout(deadline);
	}
	expect(getToolResult(harness, "read").isError).toBe(false);
	expect(getMessageText(getToolResult(harness, "read"))).toContain("prepared");
});

// #2241 countercase: native callback completion does not retire admission before public after-hooks.
it.each([false, true])(
	"retains native after-hook admission (SDK replaces request hook: %s)",
	async (replaceRequestHook) => {
		const hookEntered = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const writerAttempted = Promise.withResolvers<void>();
		const writes: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "reader",
						label: "reader",
						description: "Effect reader",
						executionKind: "effect",
						parameters: Type.Object({}),
						execute: async () => empty(),
					});
					pi.registerTool({
						name: "writer",
						label: "writer",
						description: "Exclusive writer",
						executionKind: "effect",
						executionMode: "sequential",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => {
							writes.push("write");
							await writeFile(join(ctx.cwd, "effect.txt"), "new");
							return empty();
						},
					});
					pi.registerTool({
						name: "branch",
						label: "branch",
						description: "Orchestration",
						executionKind: "orchestration",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => {
							await hookEntered.promise;
							const child = ctx.executeTool("writer", {});
							writerAttempted.resolve();
							expect((await child).isError).toBe(false);
							return empty();
						},
					});
				},
			],
		});
		harnesses.push(harness);
		if (replaceRequestHook) {
			// A public SDK request hook can use the bare registry instead of the session's projected tools.
			harness.session.agent.prepareRequest = (request) => ({
				context: { ...request.context, tools: harness.session.agent.state.tools },
			});
		}
		harness.session.agent.afterToolCall = async (context) => {
			if (context.toolCall.name === "reader") {
				hookEntered.resolve();
				await releaseHook.promise;
			}
			return undefined;
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("reader", {}), fauxToolCall("branch", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const running = harness.session.prompt("go");
		try {
			await writerAttempted.promise;
			await delay(25);
			expect(writes).toEqual([]);
			expect(harness.session.isIdle).toBe(false);
		} finally {
			releaseHook.resolve();
			await running;
		}
		expect(writes).toEqual(["write"]);
		expect(getToolResult(harness, "branch").nestedCalls?.complete).toBe(true);
	},
	5000,
);
