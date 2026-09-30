import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { AgentTool, AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { writeFileAtomic } from "../../src/core/tools/atomic-write.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
const empty = () => ({ content: [], details: {} });

// #2241: a failed/cancelled VM must release fixture-only gates before its host children can join.
async function withGatedPrompt(
	harness: Harness,
	toolName: string,
	gates: readonly { resolve: () => void }[],
	inspect: (waitFor: (gate: Promise<void>, stage: string) => Promise<void>) => Promise<void>,
): Promise<void> {
	const interrupted = Promise.withResolvers<void>();
	const listeners: (() => void)[] = [];
	let interruption: string | undefined;
	const unblock = (reason: string) => {
		interruption ??= reason;
		interrupted.resolve();
		for (const gate of gates) gate.resolve();
	};
	const before = harness.session.agent.beforeToolCall;
	harness.session.agent.beforeToolCall = async (context, signal) => {
		if (signal) {
			const onAbort = () => unblock(`cancelled while entering ${context.toolCall.name}`);
			if (signal.aborted) onAbort();
			else {
				signal.addEventListener("abort", onAbort, { once: true });
				listeners.push(() => signal.removeEventListener("abort", onAbort));
			}
		}
		return before?.(context, signal);
	};
	const running = harness.session.prompt("go");
	const fail = async (stage: string): Promise<never> => {
		await running;
		const result = getToolResult(harness, toolName);
		throw new Error(
			result.isError
				? getMessageText(result)
				: `Fixture stopped before ${stage}: ${interruption ?? "prompt completed without reaching gate"}`,
		);
	};
	// Shorter than the unchanged Vitest deadline: unblock and join, never abandon a gated prompt.
	const deadline = new AbortController();
	const watchdog = setTimeout(8_000, undefined, { signal: deadline.signal }).then(
		async () => {
			unblock("fixture gate deadline (8000 ms)");
			await harness.session.abort();
		},
		() => {},
	);
	try {
		await inspect(async (gate, stage) => {
			await Promise.race([gate, running.then(() => fail(stage)), interrupted.promise.then(() => fail(stage))]);
			if (interruption) await fail(stage);
		});
	} finally {
		for (const gate of gates) gate.resolve();
		try {
			await running;
		} finally {
			deadline.abort();
			await watchdog;
			for (const remove of listeners) remove();
			harness.session.agent.beforeToolCall = before;
		}
	}
	if (interruption) await fail("fixture completion");
}

// #2241: deterministically reproduce retirement before backend entry and during a held child.
it.each(["before backend", "held child", "script error"] as const)(
	"surfaces original VM failure and joins fixture gates (%s)",
	async (failure) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let backendEntries = 0;
		const harness = await createHarness({
			tools: [
				createWriteTool("", {
					operations: {
						mkdir: async (path) => {
							await mkdir(path, { recursive: true });
						},
						writeFile: async (path, content) => {
							backendEntries++;
							entered.resolve();
							await release.promise;
							await writeFileAtomic(path, content);
						},
					},
				}),
			],
			initialActiveToolNames: ["write", "root", "codemode"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi) =>
					pi.registerTool({
						name: "root",
						label: "root",
						description: "Gated VM failure fixture",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) =>
							(await ctx.executeTool("write", { path: join(ctx.cwd, "failure.txt"), content: "owned" })).result,
					}),
			],
		});
		harnesses.push(harness);
		if (failure === "before backend") {
			const before = harness.session.agent.beforeToolCall;
			harness.session.agent.beforeToolCall = async (context, signal) => {
				if (context.toolCall.name === "root") await release.promise;
				return before?.(context, signal);
			};
		}
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code:
						failure === "script error"
							? 'throw new Error("original VM failure before dispatch");'
							: '// @options: {"timeout_ms": 1000}\nawait tools.root({});',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await expect(
			withGatedPrompt(harness, "codemode", [entered, release], async (waitFor) => {
				await waitFor(entered.promise, "writer backend");
				// Hold the child deliberately until the explicit script deadline cancels it.
				await waitFor(new Promise<void>(() => {}), "VM retirement");
			}),
		).rejects.toThrow(failure === "script error" ? "original VM failure before dispatch" : "Script timed out");
		expect(backendEntries).toBe(failure === "held child" ? 1 : 0);
		expect(harness.session.isIdle).toBe(true);
		if (failure === "held child") {
			expect(await readFile(join(harness.tempDir, "failure.txt"), "utf8")).toBe("owned");
		} else {
			await expect(access(join(harness.tempDir, "failure.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		}
	},
	10_000,
);

// #2241 A11: actual atomic write/read effects and public after-hooks, not mocked outcomes.
describe("ancestry-aware cousin effect admission", () => {
	for (const descriptor of [undefined, "orchestration"] as const) {
		for (const controls of ["builtin", "generic"] as const) {
			for (const route of ["native", "codemode"] as const) {
				for (const ancestor of ["parallel", "sequential"] as const) {
					it.each(["write", "read"] as const)(
						`${descriptor ?? "legacy"}/${controls}/${route}/${ancestor}: excludes cousins with %s first`,
						async (first) => {
							const second = first === "write" ? "read" : "write";
							const effectName = (name: string) => (controls === "generic" ? `custom_${name}` : name);
							const entered = Promise.withResolvers<void>();
							const attempted = Promise.withResolvers<void>();
							const releaseEffect = Promise.withResolvers<void>();
							const hookEntered = Promise.withResolvers<void>();
							const releaseHook = Promise.withResolvers<void>();
							const parents = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
							const effects: string[] = [];
							const reads: string[] = [];
							const beforeEffects: string[] = [];
							const tools: AgentTool[] = [
								createWriteTool("", {
									operations: {
										mkdir: async (path) => {
											await mkdir(path, { recursive: true });
										},
										writeFile: async (path, content) => {
											effects.push("write");
											if (first === "write") {
												entered.resolve();
												await releaseEffect.promise;
											}
											await writeFileAtomic(path, content);
										},
									},
								}),
								createReadTool("", {
									operations: {
										access,
										readFile: async (path) => {
											effects.push("read");
											const bytes = await readFile(path);
											reads.push(bytes.toString());
											if (first === "read") {
												entered.resolve();
												await releaseEffect.promise;
											}
											return bytes;
										},
									},
								}),
							];
							if (controls === "generic") {
								for (const tool of tools) {
									tool.name = effectName(tool.name);
									tool.executionKind = "effect";
								}
							}
							const harness = await createHarness({
								tools,
								initialActiveToolNames: [
									effectName("write"),
									effectName("read"),
									"codemode",
									"root",
									"branch0",
									"branch1",
								],
								extensionFactories: [
									createCodemodeExtension(),
									(pi) => {
										for (let index = 0; index < 2; index++)
											pi.registerTool({
												name: `branch${index}`,
												label: "branch",
												description: "Parallel composite",
												executionMode: "parallel",
												executionKind: descriptor,
												parameters: Type.Object({}),
												execute: async (_id, _args, _signal, _update, ctx) => {
													parents[index].resolve();
													await Promise.all(parents.map((gate) => gate.promise));
													if (index === 1) {
														await entered.promise;
														attempted.resolve();
													}
													const name = index === 0 ? first : second;
													const outcome = await ctx.executeTool(
														effectName(name),
														name === "read"
															? { path: join(ctx.cwd, "effect.txt") }
															: { path: join(ctx.cwd, "effect.txt"), content: "new" },
													);
													expect(outcome.isError).toBe(false);
													return outcome.result;
												},
											});
										pi.registerTool({
											name: "root",
											label: "root",
											description: "Composite ancestor",
											executionMode: ancestor,
											executionKind: descriptor,
											parameters: Type.Object({}),
											execute: async (_id, _args, _signal, _update, ctx) => {
												const outcomes = await Promise.all([
													ctx.executeTool("branch0", {}),
													ctx.executeTool("branch1", {}),
												]);
												expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
												return empty();
											},
										});
									},
								],
							});
							harnesses.push(harness);
							await writeFile(join(harness.tempDir, "effect.txt"), "old");
							const installedBefore = harness.session.agent.beforeToolCall;
							harness.session.agent.beforeToolCall = async (context, signal) => {
								if (
									context.toolCall.name === effectName("write") ||
									context.toolCall.name === effectName("read")
								) {
									beforeEffects.push(context.toolCall.name);
								}
								return installedBefore?.(context, signal);
							};
							const installedAfter = harness.session.agent.afterToolCall;
							harness.session.agent.afterToolCall = async (context, signal) => {
								const result = await installedAfter?.(context, signal);
								if (context.toolCall.name === effectName(first)) {
									hookEntered.resolve();
									await releaseHook.promise;
								}
								return result;
							};
							harness.setResponses([
								fauxAssistantMessage(
									fauxToolCall(
										route === "native" ? "root" : "codemode",
										route === "native" ? {} : { code: "await tools.root({});" },
										{ id: "issuer" },
									),
									{ stopReason: "toolUse" },
								),
								fauxAssistantMessage("done"),
							]);
							await withGatedPrompt(
								harness,
								route === "native" ? "root" : "codemode",
								[entered, attempted, releaseEffect, hookEntered, releaseHook, ...parents],
								async (waitFor) => {
									await waitFor(attempted.promise, "cousin attempt");
									await setTimeout(25);
									expect(effects).toEqual([first]);
									expect(beforeEffects).toEqual([effectName(first)]);
									releaseEffect.resolve();
									await waitFor(hookEntered.promise, "first effect after-hook");
									await setImmediate();
									expect(effects).toEqual([first]);
									expect(harness.eventsOfType("agent_end")).toHaveLength(0);
								},
							);
							expect(effects).toEqual([first, second]);
							expect(reads).toEqual([first === "write" ? "new" : "old"]);
							expect(await readFile(join(harness.tempDir, "effect.txt"), "utf8")).toBe("new");
							const result = getToolResult(harness, route === "native" ? "root" : "codemode");
							expect(result.isError).toBe(false);
							expect(result.nestedCalls?.complete).toBe(true);
							expect(result.nestedCalls?.calls.every((call) => call.status === "ok")).toBe(true);
						},
						10_000,
					);
				}
			}
		}
	}
});

// #2241 A11: blanket shared admission deadlocks B before its first delegation; both descriptors must complete.
for (const descriptor of [undefined, "orchestration"] as const) {
	it.each(["native", "codemode"] as const)(
		`${descriptor ?? "legacy"} composite B waits cousin writer before first executeTool (%s)`,
		async (route) => {
			const entered = Promise.withResolvers<void>();
			const parents = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
			const harness = await createHarness({
				tools: [
					createWriteTool("", {
						operations: {
							mkdir: async (path) => {
								await mkdir(path, { recursive: true });
							},
							writeFile: async (path, content) => {
								entered.resolve();
								await writeFileAtomic(path, content);
							},
						},
					}),
				],
				initialActiveToolNames: ["write", "reader", "A", "B", "root", "codemode"],
				extensionFactories: [
					createCodemodeExtension(),
					(pi) => {
						pi.registerTool({
							name: "reader",
							label: "reader",
							description: "Generic annotated effect",
							executionKind: "effect",
							parameters: Type.Object({}),
							execute: async (_id, _args, _signal, _update, ctx) => {
								await readFile(join(ctx.cwd, "effect.txt"));
								return empty();
							},
						});
						for (let index = 0; index < 2; index++)
							pi.registerTool({
								name: index === 0 ? "A" : "B",
								label: "branch",
								description: "Parallel composite",
								executionKind: descriptor,
								parameters: Type.Object({}),
								execute: async (_id, _args, _signal, _update, ctx) => {
									parents[index].resolve();
									await Promise.all(parents.map((gate) => gate.promise));
									if (index === 1) await entered.promise;
									const outcome =
										index === 0
											? await ctx.executeTool("write", { path: join(ctx.cwd, "effect.txt"), content: "new" })
											: await ctx.executeTool("reader", {});
									expect(outcome.isError).toBe(false);
									return empty();
								},
							});
						pi.registerTool({
							name: "root",
							label: "root",
							description: "Parallel composite",
							executionKind: descriptor,
							parameters: Type.Object({}),
							execute: async (_id, _args, _signal, _update, ctx) => {
								const outcomes = await Promise.all([ctx.executeTool("A", {}), ctx.executeTool("B", {})]);
								expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
								return empty();
							},
						});
					},
				],
			});
			harnesses.push(harness);
			await writeFile(join(harness.tempDir, "effect.txt"), "old");
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						route === "native" ? "root" : "codemode",
						route === "native" ? {} : { code: "await tools.root({});" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await withGatedPrompt(
				harness,
				route === "native" ? "root" : "codemode",
				[entered, ...parents],
				async (waitFor) => {
					await waitFor(entered.promise, "B's cousin writer before first delegation");
				},
			);
			expect(getToolResult(harness, route === "native" ? "root" : "codemode").isError).toBe(false);
			expect(await readFile(join(harness.tempDir, "effect.txt"), "utf8")).toBe("new");
			expect(getToolResult(harness, route === "native" ? "root" : "codemode").nestedCalls?.complete).toBe(true);
		},
		10_000,
	);
}

// #2241 A11: annotation is opt-in; arbitrary metadata-free readers retain legacy overlap.
it("preserves undeclared reader overlap and keeps executionKind out of model declarations", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const readEntered = Promise.withResolvers<void>();
	let observed: string | undefined;
	const harness = await createHarness({
		tools: [
			createWriteTool("", {
				operations: {
					mkdir: async (path) => {
						await mkdir(path, { recursive: true });
					},
					writeFile: async (path, content) => {
						entered.resolve();
						await release.promise;
						await writeFileAtomic(path, content);
					},
				},
			}),
		],
		initialActiveToolNames: ["write", "legacy_reader", "writer_branch", "root"],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "legacy_reader",
					label: "reader",
					description: "Undeclared arbitrary callback",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						observed = await readFile(join(ctx.cwd, "effect.txt"), "utf8");
						readEntered.resolve();
						return empty();
					},
				});
				pi.registerTool({
					name: "writer_branch",
					label: "writer",
					description: "Declared orchestration",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) =>
						(await ctx.executeTool("write", { path: join(ctx.cwd, "effect.txt"), content: "new" })).result,
				});
				pi.registerTool({
					name: "root",
					label: "root",
					description: "Declared orchestration",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						const writer = ctx.executeTool("writer_branch", {});
						await entered.promise;
						const reader = await ctx.executeTool("legacy_reader", {});
						expect(reader.isError).toBe(false);
						await writer;
						return empty();
					},
				});
			},
		],
	});
	harnesses.push(harness);
	await writeFile(join(harness.tempDir, "effect.txt"), "old");
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("root", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const running = harness.session.prompt("go");
	try {
		await readEntered.promise;
		expect(observed).toBe("old");
	} finally {
		release.resolve();
		await running;
	}
	const declarations = getCurrentTools(harness.session.messages);
	expect(declarations.map((tool) => tool.name)).toContain("root");
	for (const declaration of declarations) expect(declaration).not.toHaveProperty("executionKind");
}, 10_000);

// #2241 A11: model-native annotated effects share the same admission as nested effects.
it("excludes nested writer while a model-native reader is active", async () => {
	const first = "read";
	const entered = Promise.withResolvers<void>();
	const attempted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const effects: string[] = [];
	const harness = await createHarness({
		tools: [
			createWriteTool("", {
				operations: {
					mkdir: async (path) => {
						await mkdir(path, { recursive: true });
					},
					writeFile: async (path, content) => {
						effects.push("write");
						await writeFileAtomic(path, content);
					},
				},
			}),
			createReadTool("", {
				operations: {
					access,
					readFile: async (path) => {
						effects.push("read");
						const bytes = await readFile(path);
						entered.resolve();
						await release.promise;
						return bytes;
					},
				},
			}),
		],
		initialActiveToolNames: ["write", "read", "root"],
		extensionFactories: [
			(pi) =>
				pi.registerTool({
					name: "root",
					label: "root",
					description: "Declared orchestration",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						await entered.promise;
						const writing = ctx.executeTool("write", { path: join(ctx.cwd, "effect.txt"), content: "new" });
						attempted.resolve();
						const outcome = await writing;
						expect(outcome.isError).toBe(false);
						return outcome.result;
					},
				}),
		],
	});
	harnesses.push(harness);
	const path = join(harness.tempDir, "effect.txt");
	await writeFile(path, "old");

	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("root", {}), fauxToolCall("read", { path })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const running = harness.session.prompt("go");
	try {
		await attempted.promise;
		await setTimeout(25);
		expect(effects).toEqual([first]);
	} finally {
		release.resolve();
		await running;
	}
	expect(effects).toEqual(["read", "write"]);
	expect(await readFile(path, "utf8")).toBe("new");
}, 10_000);

// #2241 F18: native and nested wrappers must join accepted unawaited atomic work before publication/idle.
describe("native parent child custody", () => {
	it.each([
		["native", false],
		["native", true],
		["codemode", false],
		["codemode", true],
	] as const)(
		"drains unawaited children and fences retired %s contexts (parent throws: %s)",
		async (route, parentThrows) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const hookEntered = Promise.withResolvers<void>();
			const releaseHook = Promise.withResolvers<void>();
			let captured: ExtensionToolContext | undefined;
			let child: Promise<AgentToolCallOutcome> | undefined;
			const harness = await createHarness({
				tools: [
					createWriteTool("", {
						operations: {
							mkdir: async (path) => {
								await mkdir(path, { recursive: true });
							},
							writeFile: async (path, content) => {
								entered.resolve();
								await release.promise;
								await writeFileAtomic(path, content);
							},
						},
					}),
				],
				initialActiveToolNames: ["write", "detached", "codemode"],
				extensionFactories: [
					createCodemodeExtension(),
					(pi) =>
						pi.registerTool({
							name: "detached",
							label: "detached",
							description: "Accept one unawaited child",
							parameters: Type.Object({}),
							execute: async (_id, _args, _signal, _update, ctx) => {
								captured = ctx;
								child = ctx.executeTool("write", { path: join(ctx.cwd, "owned.txt"), content: "owned" });
								if (parentThrows) throw new Error("parent failed after accepting child");
								return empty();
							},
						}),
				],
			});
			harnesses.push(harness);
			const installed = harness.session.agent.afterToolCall;
			harness.session.agent.afterToolCall = async (context, signal) => {
				const result = await installed?.(context, signal);
				if (context.toolCall.name === "write") {
					hookEntered.resolve();
					await releaseHook.promise;
				}
				return result;
			};
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						route === "native" ? "detached" : "codemode",
						route === "native" ? {} : { code: "await tools.detached({});" },
						{ id: "issuer" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			let settled = false;
			const running = harness.session.prompt("go").then(() => {
				settled = true;
			});
			try {
				await entered.promise;
				await setImmediate();
				expect(settled).toBe(false);
				expect(harness.session.isIdle).toBe(false);
				const late = captured?.executeTool("write", { path: join(harness.tempDir, "late.txt"), content: "late" });
				let refused = false;
				void late?.then(() => {
					refused = true;
				});
				await setImmediate();
				expect(refused).toBe(true);
				expect((await late)?.isError).toBe(true);
				expect(
					harness.eventsOfType("message_start").filter((event) => event.message.role === "toolResult"),
				).toHaveLength(0);
				release.resolve();
				await hookEntered.promise;
				await setImmediate();
				expect(settled).toBe(false);
				expect(harness.eventsOfType("agent_end")).toHaveLength(0);
			} finally {
				release.resolve();
				releaseHook.resolve();
				await running;
			}
			expect((await child)?.isError).toBe(false);
			expect(await readFile(join(harness.tempDir, "owned.txt"), "utf8")).toBe("owned");
			const result = getToolResult(harness, route === "native" ? "detached" : "codemode");
			expect(result.isError).toBe(parentThrows);
			expect(result.nestedCalls?.complete).toBe(true);
			expect(result.nestedCalls?.calls.find((call) => call.name === "write")?.status).toBe("ok");
			const retired = await captured?.executeTool("write", {
				path: join(harness.tempDir, "late.txt"),
				content: "late",
			});
			expect(retired?.isError).toBe(true);
			expect(getMessageText(retired?.result)).toContain("retired");
			await expect(access(join(harness.tempDir, "late.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			const oldContext = captured;
			// Reusing the provider's id in a fresh run must not revive an older context.
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("detached", {}, { id: "issuer" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("again");
			expect(captured).not.toBe(oldContext);
			expect(
				(await oldContext?.executeTool("write", { path: join(harness.tempDir, "late.txt"), content: "late" }))
					?.isError,
			).toBe(true);
			expect(getToolResult(harness, "detached").nestedCalls?.complete).toBe(true);
		},
		10_000,
	);

	// #2241 F18: an explicitly supplied live child signal cannot sever the parent's cancellation ownership.
	it.each(["native", "codemode"] as const)(
		"keeps cancellation linked while %s parent drains",
		async (route) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const override = new AbortController();
			let child: Promise<AgentToolCallOutcome> | undefined;
			let childSignal: AbortSignal | undefined;
			const harness = await createHarness({
				tools: [
					createWriteTool("", {
						operations: {
							mkdir: async (path) => {
								await mkdir(path, { recursive: true });
							},
							writeFile: async (path, content) => {
								entered.resolve();
								await release.promise;
								await writeFileAtomic(path, content);
							},
						},
					}),
				],
				initialActiveToolNames: ["write", "detached", "codemode"],
				extensionFactories: [
					createCodemodeExtension(),
					(pi) =>
						pi.registerTool({
							name: "detached",
							label: "detached",
							description: "Unawaited child",
							parameters: Type.Object({}),
							execute: async (_id, _args, _signal, _update, ctx) => {
								child = ctx.executeTool(
									"write",
									{ path: join(ctx.cwd, "cancelled.txt"), content: "accepted effect" },
									{ signal: override.signal },
								);
								return empty();
							},
						}),
				],
			});
			harnesses.push(harness);
			const before = harness.session.agent.beforeToolCall;
			harness.session.agent.beforeToolCall = async (context, signal) => {
				if (context.toolCall.name === "write") {
					childSignal = signal;
				}
				return before?.(context, signal);
			};
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						route === "native" ? "detached" : "codemode",
						route === "native" ? {} : { code: "await tools.detached({});" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			const running = harness.session.prompt("go");
			await entered.promise;
			let aborted = false;
			const abort = harness.session.abort().then(() => {
				aborted = true;
			});
			try {
				await setImmediate();
				expect(childSignal?.aborted).toBe(true);
				expect(override.signal.aborted).toBe(false);
				expect(aborted).toBe(false);
				expect(harness.session.isIdle).toBe(false);
			} finally {
				release.resolve();
				await Promise.all([running, abort]);
			}
			expect((await child)?.isError).toBe(true);
			expect(await readFile(join(harness.tempDir, "cancelled.txt"), "utf8")).toBe("accepted effect");
			expect(harness.eventsOfType("agent_settled").at(-1)?.outcome).toBe("aborted");
		},
		10_000,
	);
});
