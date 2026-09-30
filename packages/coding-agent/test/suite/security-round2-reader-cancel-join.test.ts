import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { AgentTool, AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createBashTool, createLocalShellOperations } from "../../src/core/tools/bash.ts";
import { createFindTool } from "../../src/core/tools/find.ts";
import { createGrepTool } from "../../src/core/tools/grep.ts";
import { createLsTool } from "../../src/core/tools/ls.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";
import * as imageProcess from "../../src/utils/image-process.ts";
import * as toolsManager from "../../src/utils/tools-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// #2241 R2-ASTRA-2: child-only cancellation must retain shared admission until accepted I/O settles.
it.each([
	"read-access",
	"read-mime",
	"read-text",
	"read-image",
	"read-processing",
	"ls-exists",
	"ls-stat",
	"ls-readdir",
	"ls-entry",
	"find-exists",
	"find-glob",
	"bash-exec",
])(
	"joins %s before admitting a live cousin writer, and fences subsequent backend work",
	async (stage) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const attempted = Promise.withResolvers<void>();
		const childAbort = new AbortController();
		const effects: string[] = [];
		let active = false;
		let readerSettled = false;
		let child: AgentToolCallOutcome | undefined;
		const backend = async (name: string) => {
			effects.push(name);
			if (name === stage) {
				active = true;
				entered.resolve();
				await release.promise;
				active = false;
				effects.push("backend-settled");
			}
		};
		const processImage = vi.spyOn(imageProcess, "processImage").mockImplementation(async () => {
			await backend("read-processing");
			return { ok: true, data: "", mimeType: "image/png", hints: [] };
		});
		let reader: AgentTool;
		let args: Record<string, unknown>;
		if (stage.startsWith("read-")) {
			reader = createReadTool("", {
				operations: {
					access: async () => backend("read-access"),
					detectImageMimeType: async () => {
						await backend("read-mime");
						return stage === "read-image" || stage === "read-processing" ? "image/png" : undefined;
					},
					readFile: async () => {
						await backend(stage === "read-image" ? "read-image" : "read-text");
						return Buffer.from("old");
					},
				},
			});
			args = { path: "effect.txt" };
		} else if (stage.startsWith("ls-")) {
			let statCount = 0;
			reader = createLsTool("", {
				operations: {
					exists: async () => {
						await backend("ls-exists");
						return true;
					},
					stat: async () => {
						await backend(statCount++ === 0 ? "ls-stat" : "ls-entry");
						return { isDirectory: () => true };
					},
					readdir: async () => {
						await backend("ls-readdir");
						return ["a", "b"];
					},
				},
			});
			args = {};
		} else if (stage.startsWith("find-")) {
			reader = createFindTool("", {
				operations: {
					exists: async () => {
						await backend("find-exists");
						return true;
					},
					glob: async () => {
						await backend("find-glob");
						return ["a"];
					},
				},
			});
			args = { pattern: "*" };
		} else {
			reader = createBashTool("", {
				operations: {
					exec: async () => {
						await backend("bash-exec");
						return { exitCode: 0 };
					},
				},
			});
			args = { command: "unused" };
		}
		const harness = await createHarness({
			tools: [
				reader,
				createWriteTool("", {
					operations: {
						mkdir: async () => {},
						writeFile: async (path, content) => {
							effects.push(active ? "writer-overlap" : "writer");
							await writeFile(path, content);
						},
					},
				}),
			],
			initialActiveToolNames: [reader.name, "write", "reader_branch", "writer_branch", "root"],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "reader_branch",
						label: "reader",
						description: "Orchestration",
						executionKind: "orchestration",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => {
							child = await ctx.executeTool(reader.name, args, { signal: childAbort.signal });
							readerSettled = true;
							return child.result;
						},
					});
					pi.registerTool({
						name: "writer_branch",
						label: "writer",
						description: "Live cousin",
						executionKind: "orchestration",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => {
							await entered.promise;
							const writing = ctx.executeTool("write", { path: join(ctx.cwd, "effect.txt"), content: "new" });
							attempted.resolve();
							return (await writing).result;
						},
					});
					pi.registerTool({
						name: "root",
						label: "root",
						description: "Parallel orchestration",
						executionKind: "orchestration",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => {
							await Promise.all([ctx.executeTool("reader_branch", {}), ctx.executeTool("writer_branch", {})]);
							return { content: [], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("root", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const running = harness.session.prompt("go");
		const before: string[] = [];
		try {
			await attempted.promise;
			childAbort.abort();
			await setTimeout(30);
			before.push(...effects);
			expect(readerSettled).toBe(false);
			expect(effects).not.toContain("writer-overlap");
			expect(effects).not.toContain("writer");
			expect(harness.session.isIdle).toBe(false);
		} finally {
			release.resolve();
			await running;
			await setImmediate();
			console.info(JSON.stringify({ stage, before, after: effects, readerSettled, childError: child?.isError }));
		}
		expect(child?.isError).toBe(true);
		expect(effects).toEqual([...before, "backend-settled", "writer"]);
		expect(processImage).toHaveBeenCalledTimes(stage === "read-processing" ? 1 : 0);
		expect(await readFile(join(harness.tempDir, "effect.txt"), "utf8")).toBe("new");
	},
	10_000,
);

// #2241 R2-ASTRA-2 countercase: unstarted queued children cancel promptly without backend effects.
it("cancels a queued reader promptly while its live writer predecessor remains gated", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const attempted = Promise.withResolvers<void>();
	const cancelled = Promise.withResolvers<AgentToolCallOutcome>();
	const abort = new AbortController();
	let calls = 0;
	const harness = await createHarness({
		tools: [
			createReadTool("", {
				operations: {
					access: async () => {
						calls++;
					},
					readFile: async () => {
						calls++;
						return Buffer.from("old");
					},
				},
			}),
			createWriteTool("", {
				operations: {
					mkdir: async () => {},
					writeFile: async () => {
						entered.resolve();
						await release.promise;
					},
				},
			}),
		],
		initialActiveToolNames: ["read", "write", "A", "B", "root"],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "A",
					label: "A",
					description: "Writer",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) =>
						(await ctx.executeTool("write", { path: "x", content: "x" })).result,
				});
				pi.registerTool({
					name: "B",
					label: "B",
					description: "Reader",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						await entered.promise;
						const reading = ctx.executeTool("read", { path: "x" }, { signal: abort.signal });
						attempted.resolve();
						const outcome = await reading;
						cancelled.resolve(outcome);
						return outcome.result;
					},
				});
				pi.registerTool({
					name: "root",
					label: "root",
					description: "Composite",
					executionKind: "orchestration",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						await Promise.all([ctx.executeTool("A", {}), ctx.executeTool("B", {})]);
						return { content: [], details: {} };
					},
				});
			},
		],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("root", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const running = harness.session.prompt("go");
	try {
		await attempted.promise;
		abort.abort();
		const outcome = await Promise.race([cancelled.promise, setTimeout(500).then(() => undefined)]);
		expect(outcome?.isError).toBe(true);
		expect(calls).toBe(0);
		expect(harness.session.isIdle).toBe(false);
	} finally {
		release.resolve();
		await running;
	}
});

// #2241 R2-ASTRA-2: native fd/rg termination is accepted work, not merely a kill request.
it.skipIf(process.platform === "win32").each(["find", "grep"] as const)(
	"joins native %s process termination after cancellation",
	async (name) => {
		const root = await mkdtemp(join(tmpdir(), "reader-process-"));
		roots.push(root);
		const executable = join(root, "backend");
		const ready = join(root, "ready");
		const stopped = join(root, "stopped");
		const release = join(root, "release");
		await writeFile(
			executable,
			`#!/usr/bin/env node\nconst fs = require('node:fs');\nprocess.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'stopping'); });\nfs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));\nsetTimeout(() => process.exit(0), 5000);\nsetInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);\n`,
		);
		await chmod(executable, 0o700);
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(executable);
		const abort = new AbortController();
		const tool = name === "find" ? createFindTool(root) : createGrepTool(root);
		let settled = false;
		const running = tool.execute("process", { pattern: "x", path: root }, abort.signal).then(
			() => {
				settled = true;
				return "success";
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		try {
			await vi.waitFor(async () => {
				await access(ready);
			});
			abort.abort();
			await vi.waitFor(async () => {
				await access(stopped);
			});
			await setImmediate();
			expect(settled).toBe(false);
		} finally {
			await writeFile(release, "release");
			await running;
			// The unsafe before implementation has already settled; fixture cleanup
			// must still let the owned backend exit before deleting its release file.
			const pid = Number(await readFile(ready, "utf8"));
			await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
		}
		expect(await running).toMatchObject({ message: "Operation aborted" });
	},
	10_000,
);

// #2241 R2-ASTRA-2 countercase: native bash already joins its accepted process on abort.
it.skipIf(process.platform === "win32")("joins native bash cancellation before reporting retirement", async () => {
	const root = await mkdtemp(join(tmpdir(), "reader-bash-"));
	roots.push(root);
	const ready = join(root, "ready");
	const script = join(root, "backend.cjs");
	await writeFile(
		script,
		`require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));\nsetTimeout(() => process.exit(0), 5000);\n`,
	);
	const abort = new AbortController();
	const operations = createLocalShellOperations("node", () => ({ shell: process.execPath, args: [script] }));
	const running = createBashTool(root, { operations })
		.execute("native-bash", { command: "unused", timeout: 5 }, abort.signal)
		.then(
			() => "success",
			(error: unknown) => error,
		);
	let pid: number | undefined;
	try {
		await vi.waitFor(async () => {
			pid = Number(await readFile(ready, "utf8"));
		});
		abort.abort();
		expect(await running).toMatchObject({ message: "Command aborted" });
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid!, 0)).toThrow();
	} finally {
		abort.abort();
		await running;
	}
});

// #2241 R2-ASTRA-2: grep's accepted context read must join and stop later context reads.
it("records grep cancellation during async context formatting and fences later reads", async () => {
	const root = await mkdtemp(join(tmpdir(), "reader-grep-"));
	roots.push(root);
	await writeFile(join(root, "a.txt"), "match\nmatch\n");
	await writeFile(join(root, "b.txt"), "match\n");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const abort = new AbortController();
	let reads = 0;
	const tool = createGrepTool(root, {
		operations: {
			isDirectory: () => true,
			readFile: async () => {
				reads++;
				entered.resolve();
				await release.promise;
				return "match\nmatch\n";
			},
		},
	});
	let settled = false;
	const running = tool.execute("context", { pattern: "match", path: root, context: 1 }, abort.signal).then(
		() => {
			settled = true;
			return "success";
		},
		(error: unknown) => {
			settled = true;
			return error;
		},
	);
	try {
		await entered.promise;
		abort.abort();
		await setImmediate();
		expect(settled).toBe(false);
	} finally {
		release.resolve();
		await running;
	}
	expect(await running).toMatchObject({ message: "Operation aborted" });
	expect(reads).toBe(1);
}, 10_000);

// #2241 R2-ASTRA-2 countercases: uncancelled custom readers and images still produce normal output.
it("retains normal custom read/image/ls/find/bash behavior", async () => {
	const root = await mkdtemp(join(tmpdir(), "reader-normal-"));
	roots.push(root);
	const text = await createReadTool(root, {
		operations: { access: async () => {}, readFile: async () => Buffer.from("first\nsecond") },
	}).execute("text", { path: "x", offset: 2 });
	expect(text.content).toEqual([{ type: "text", text: "second" }]);
	const image = await createReadTool(root, {
		autoResizeImages: false,
		operations: {
			access: async () => {},
			detectImageMimeType: async () => "image/png",
			readFile: async () => Buffer.from("image"),
		},
	}).execute("image", { path: "x" });
	expect(image.content[1]).toMatchObject({
		type: "image",
		mimeType: "image/png",
		data: Buffer.from("image").toString("base64"),
	});
	const ls = await createLsTool(root, {
		operations: { exists: () => true, stat: () => ({ isDirectory: () => true }), readdir: () => ["b", "a"] },
	}).execute("ls", {});
	expect(ls.content).toEqual([{ type: "text", text: "a/\nb/" }]);
	const find = await createFindTool(root, {
		operations: { exists: () => true, glob: () => [join(root, "a")] },
	}).execute("find", { pattern: "*" });
	expect(find.content).toEqual([{ type: "text", text: "a" }]);
	const bash = await createBashTool(root, {
		operations: {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("normal"));
				return { exitCode: 0 };
			},
		},
	}).execute("bash", { command: "unused" });
	expect(bash.content).toEqual([{ type: "text", text: "normal" }]);
});

// #2241 R2-ASTRA-2: abort during tool resolution must join it, then fence stat/spawn.
it.each(["find", "grep"] as const)(
	"fences native %s startup after cancellation during binary resolution",
	async (name) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<string>();
		const root = await mkdtemp(join(tmpdir(), "reader-startup-"));
		roots.push(root);
		const marker = join(root, "spawned");
		const executable = join(root, "backend");
		await writeFile(
			executable,
			`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned');\n`,
		);
		await chmod(executable, 0o700);
		vi.spyOn(toolsManager, "ensureTool").mockImplementation(async () => {
			entered.resolve();
			return release.promise;
		});
		let stats = 0;
		const abort = new AbortController();
		const tool =
			name === "find"
				? createFindTool(root)
				: createGrepTool(root, {
						operations: {
							isDirectory: () => {
								stats++;
								return true;
							},
							readFile: () => "",
						},
					});
		let settled = false;
		const running = tool.execute("startup", { pattern: "x", path: root }, abort.signal).then(
			() => {
				settled = true;
				return "success";
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		try {
			await entered.promise;
			abort.abort();
			await setImmediate();
			expect(settled).toBe(false);
		} finally {
			release.resolve(executable);
			await running;
		}
		expect(await running).toMatchObject({ message: "Operation aborted" });
		expect(stats).toBe(0);
		await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
	},
);

// #2241 R2-ASTRA-2: a failed accepted backend still joins; cancellation wins without later work.
it.each(["read", "ls"] as const)("joins a failed accepted %s backend after cancellation", async (name) => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const abort = new AbortController();
	let later = 0;
	const fail = async () => {
		entered.resolve();
		await release.promise;
		throw new Error("backend failed");
	};
	const tool =
		name === "read"
			? createReadTool("", {
					operations: {
						access: fail,
						readFile: async () => {
							later++;
							return Buffer.from("");
						},
					},
				})
			: createLsTool("", {
					operations: {
						exists: fail,
						stat: () => {
							later++;
							return { isDirectory: () => true };
						},
						readdir: () => {
							later++;
							return [];
						},
					},
				});
	let settled = false;
	const running = tool.execute("failure", { path: "x" }, abort.signal).then(
		() => {
			settled = true;
			return "success";
		},
		(error: unknown) => {
			settled = true;
			return error;
		},
	);
	try {
		await entered.promise;
		abort.abort();
		await setImmediate();
		expect(settled).toBe(false);
	} finally {
		release.resolve();
		await running;
	}
	expect(await running).toMatchObject({ message: "Operation aborted" });
	expect(later).toBe(0);
});

// #2241 R2-ASTRA-2 countercase: already cancelled calls start no injected/backend work.
it("rejects already cancelled built-ins before operations or binary resolution", async () => {
	const abort = new AbortController();
	abort.abort();
	const ensure = vi.spyOn(toolsManager, "ensureTool");
	const exec = vi.fn(async () => ({ exitCode: 0 }));
	const readers: AgentTool[] = [
		createReadTool(""),
		createLsTool(""),
		createFindTool(""),
		createGrepTool(""),
		createBashTool("", { operations: { exec } }),
	];
	for (const reader of readers) {
		await expect(
			reader.execute("cancelled", { path: "x", pattern: "x", command: "unused" }, abort.signal),
		).rejects.toThrow(/aborted/i);
		expect(reader.executionKind).toBe("effect");
	}
	expect(exec).not.toHaveBeenCalled();
	expect(ensure).not.toHaveBeenCalled();
});

// #2241 R2-ASTRA-2: cancellation after grep stat must fence the native search process.
it("joins grep directory detection and fences process startup after cancellation", async () => {
	const root = await mkdtemp(join(tmpdir(), "reader-stat-"));
	roots.push(root);
	const marker = join(root, "spawned");
	const executable = join(root, "backend");
	await writeFile(
		executable,
		`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned');\n`,
	);
	await chmod(executable, 0o700);
	vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(executable);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const abort = new AbortController();
	const tool = createGrepTool(root, {
		operations: {
			isDirectory: async () => {
				entered.resolve();
				await release.promise;
				return true;
			},
			readFile: () => "",
		},
	});
	let settled = false;
	const running = tool.execute("stat", { pattern: "x" }, abort.signal).then(
		() => {
			settled = true;
			return "success";
		},
		(error: unknown) => {
			settled = true;
			return error;
		},
	);
	try {
		await entered.promise;
		abort.abort();
		await setImmediate();
		expect(settled).toBe(false);
	} finally {
		release.resolve();
		await running;
	}
	expect(await running).toMatchObject({ message: "Operation aborted" });
	await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
