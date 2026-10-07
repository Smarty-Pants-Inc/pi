import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import * as childProcess from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BashOperations, createBashTool, createBashToolDefinition } from "../../../src/core/tools/bash.ts";
import type { BashSpawnEvent, ExtensionError } from "../../../src/index.ts";
import * as shell from "../../../src/utils/shell.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

vi.mock("child_process", { spy: true });

// Regressions for smarty-dev#4387 and smarty-dev#2271: tool_call alone cannot attest commandPrefix.
describe("bash_spawn final executor attestation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function runBash(harness: Harness, command: string) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command }, { id: "attested-call" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run the test command");
		return harness.session.messages.find((message) => message.role === "toolResult");
	}

	it("exposes the prefixed final command, resolved shell/argv, cwd and env immediately before spawn", async () => {
		const prefix = "mktemp(){ printf 'shadowed\\n'; }";
		const command = "printf 'native\\n'";
		const events: BashSpawnEvent[] = [];
		const harness = await createHarness({
			settings: { shellCommandPrefix: prefix },
			extensionFactories: [
				(pi) => {
					expect(pi.hostCapabilities.bashSpawnEvent).toBe(true);
					pi.on("bash_spawn", (event) => {
						events.push(event);
						expect(spawn).not.toHaveBeenCalled();
					});
				},
			],
		});
		harnesses.push(harness);
		const resolveShell = vi.spyOn(shell, "getShellConfig");
		const spawn = vi.mocked(childProcess.spawn);

		const result = await runBash(harness, command);

		expect(result).toMatchObject({ role: "toolResult", isError: false });
		expect(getMessageText(result)).toBe("native\n");
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event).toMatchObject({
			type: "bash_spawn",
			toolCallId: "attested-call",
			command: `${prefix}\n${command}`,
			cwd: harness.tempDir,
			backend: "local-builtin",
			env: { PI_SESSION_ID: harness.sessionManager.getSessionId() },
		});
		expect(resolveShell).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn.mock.calls[0]?.[0]).toBe(event.shellPath);
		expect(spawn.mock.calls[0]?.[1]).toEqual(event.shellArgs);
		expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: event.cwd, env: event.env });
	});

	it("attests spawnHook changes to command, cwd and env", async () => {
		const events: BashSpawnEvent[] = [];
		let finalCwd = "";
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						createBashToolDefinition(process.cwd(), {
							commandPrefix: "export PREFIXED=yes",
							spawnHook: ({ command, env }) => ({
								command: `${command}\nprintf '%s:%s:%s' "$PREFIXED" "$ATTEST_VALUE" "$PWD"`,
								cwd: finalCwd,
								env: { ...env, ATTEST_VALUE: "final" },
							}),
						}),
					);
					pi.on("bash_spawn", (event) => {
						events.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		finalCwd = join(harness.tempDir, "hook-cwd");
		mkdirSync(finalCwd);
		const result = await runBash(harness, ":");

		expect(events[0]).toMatchObject({
			command: expect.stringContaining("export PREFIXED=yes\n:\nprintf"),
			cwd: finalCwd,
			env: { ATTEST_VALUE: "final" },
		});
		expect(getMessageText(result)).toBe(`yes:final:${finalCwd}`);
	});

	it("a veto fails the tool with its reason and creates no child or marker", async () => {
		const calls: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_spawn", () => {
						calls.push("allow");
						return { block: false };
					});
					pi.on("bash_spawn", () => {
						calls.push("veto");
						return { block: true, reason: "policy denied spawn" };
					});
				},
				(pi) => {
					pi.on("bash_spawn", () => {
						calls.push("late allow");
						return { block: false };
					});
				},
			],
		});
		harnesses.push(harness);
		const spawn = vi.mocked(childProcess.spawn);
		const result = await runBash(harness, "printf created > veto-marker");

		expect(result).toMatchObject({ isError: true });
		expect(getMessageText(result)).toContain("policy denied spawn");
		expect(calls).toEqual(["allow", "veto"]);
		expect(spawn).not.toHaveBeenCalled();
		expect(existsSync(join(harness.tempDir, "veto-marker"))).toBe(false);
	});

	it.each(["sync", "async"])("a %s throwing handler fails closed without a child", async (kind) => {
		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					if (kind === "sync")
						pi.on("bash_spawn", () => {
							throw new Error("guard failure");
						});
					else
						pi.on("bash_spawn", async () => {
							throw new Error("guard failure");
						});
				},
			],
		});
		harnesses.push(harness);
		harness.session.extensionRunner.onError((error) => errors.push(error));
		const spawn = vi.mocked(childProcess.spawn);
		const result = await runBash(harness, "printf created > throwing-marker");

		expect(result).toMatchObject({ isError: true });
		expect(getMessageText(result)).toContain("bash_spawn handler failed: guard failure");
		expect(errors).toMatchObject([{ event: "bash_spawn", error: "guard failure" }]);
		expect(spawn).not.toHaveBeenCalled();
		expect(existsSync(join(harness.tempDir, "throwing-marker"))).toBe(false);
	});

	it.each([false, true])("custom operations report custom and honor veto=%s before exec", async (block) => {
		const events: BashSpawnEvent[] = [];
		const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, { onData }) => {
			onData(Buffer.from("custom output"));
			return { exitCode: 0 };
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						createBashToolDefinition(process.cwd(), {
							commandPrefix: "prefix",
							operations: { exec },
							spawnHook: (context) => ({
								...context,
								backend: "local-builtin",
								type: "forged",
								toolCallId: "forged",
								shellPath: "/forged",
								shellArgs: ["forged"],
							}),
						}),
					);
					pi.on("bash_spawn", (event) => {
						events.push(event);
						expect(exec).not.toHaveBeenCalled();
						return block ? { block: true, reason: "custom denied" } : undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		const resolveShell = vi.spyOn(shell, "getShellConfig");
		const result = await runBash(harness, "command");

		expect(events[0]).toMatchObject({
			type: "bash_spawn",
			toolCallId: "attested-call",
			command: "prefix\ncommand",
			backend: "custom",
			cwd: harness.tempDir,
		});
		expect(events[0]?.shellPath).toBeUndefined();
		expect(events[0]?.shellArgs).toBeUndefined();
		expect(resolveShell).not.toHaveBeenCalled();
		expect(exec).toHaveBeenCalledTimes(block ? 0 : 1);
		expect(getMessageText(result)).toBe(block ? "custom denied" : "custom output");
	});

	it("SDK-supplied built-in bash tools cannot lose the session's final gate", async () => {
		const events: BashSpawnEvent[] = [];
		const harness = await createHarness({
			tools: [createBashTool(process.cwd(), { commandPrefix: ": sdk-prefix" })],
			extensionFactories: [
				(pi) => {
					pi.on("bash_spawn", (event) => {
						events.push(event);
						return { block: true, reason: "SDK final gate" };
					});
				},
			],
		});
		harnesses.push(harness);
		const spawn = vi.mocked(childProcess.spawn);
		const result = await runBash(harness, "printf executed");
		expect(events[0]).toMatchObject({
			command: ": sdk-prefix\nprintf executed",
			backend: "local-builtin",
			cwd: harness.tempDir,
		});
		expect(result).toMatchObject({ isError: true });
		expect(getMessageText(result)).toBe("SDK final gate");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("no bash_spawn handler preserves normal behavior", async () => {
		const harness = await createHarness({ settings: { shellCommandPrefix: "export ATTEST_VALUE=unchanged" } });
		harnesses.push(harness);
		expect(harness.session.extensionRunner.hasHandlers("bash_spawn")).toBe(false);
		const result = await runBash(harness, "printf '%s' \"$ATTEST_VALUE\"");
		expect(result).toMatchObject({ isError: false });
		expect(getMessageText(result)).toBe("unchanged");
	});

	it("tool_call mutations precede final attestation", async () => {
		const events: BashSpawnEvent[] = [];
		const harness = await createHarness({
			settings: { shellCommandPrefix: ": prefix" },
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event) => {
						if (event.toolName === "bash") event.input.command = "printf rewritten";
					});
					pi.on("bash_spawn", (event) => {
						events.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		const result = await runBash(harness, "printf original");
		expect(events[0]?.command).toBe(": prefix\nprintf rewritten");
		expect(getMessageText(result)).toBe("rewritten");
	});

	it("handler mutations cannot change the executor or later handlers' snapshots", async () => {
		const events: BashSpawnEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_spawn", (event) => {
						event.command = "printf mutated > mutation-marker";
						event.cwd = "/missing";
						event.shellPath = "/missing";
						event.shellArgs?.splice(0);
						event.env = { ATTEST_VALUE: "mutated" };
					});
					pi.on("bash_spawn", (event) => {
						events.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		const result = await runBash(harness, "printf original");
		expect(events[0]).toMatchObject({ command: "printf original", cwd: harness.tempDir });
		expect(events[0]?.shellArgs?.length).toBeGreaterThan(0);
		expect(getMessageText(result)).toBe("original");
		expect(existsSync(join(harness.tempDir, "mutation-marker"))).toBe(false);
	});

	it("retained spawnHook env references cannot change the attested environment", async () => {
		let hookEnv: NodeJS.ProcessEnv | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						createBashToolDefinition(process.cwd(), {
							spawnHook: (context) => {
								hookEnv = { ...context.env, ATTEST_VALUE: "attested" };
								return { ...context, env: hookEnv };
							},
						}),
					);
					pi.on("bash_spawn", (event) => {
						expect(event.env.ATTEST_VALUE).toBe("attested");
						if (hookEnv) hookEnv.ATTEST_VALUE = "changed-after-attestation";
					});
				},
			],
		});
		harnesses.push(harness);
		const result = await runBash(harness, "printf '%s' \"$ATTEST_VALUE\"");
		expect(getMessageText(result)).toBe("attested");
	});

	it("attests stdin command transport without pretending the command is in argv", async () => {
		const events: BashSpawnEvent[] = [];
		const args = ["-e", "process.stdin.pipe(process.stdout)"];
		vi.spyOn(shell, "getShellConfig").mockReturnValue({ shell: process.execPath, args, commandTransport: "stdin" });
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_spawn", (event) => {
						events.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		const result = await runBash(harness, "stdin command bytes");
		expect(events[0]).toMatchObject({ shellPath: process.execPath, shellArgs: args, command: "stdin command bytes" });
		expect(getMessageText(result)).toBe("stdin command bytes");
	});

	it("native allocator-prefix substitution redirects the marker without a final gate (negative control)", async () => {
		const harness = await createHarness({
			settings: {
				shellCommandPrefix: "mktemp(){ printf '%s\\n' \"$PWD/redirected-grant\"; }",
			},
		});
		harnesses.push(harness);
		const result = await runBash(harness, 'allocated=$(mktemp); printf allocated > "$allocated"');
		expect(result).toMatchObject({ isError: false });
		expect(readFileSync(join(harness.tempDir, "redirected-grant"), "utf8")).toBe("allocated");
	});

	it("unsubscribe preserves the current dispatch snapshot and removes the next registration", async () => {
		const calls: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_spawn", () => {
						calls.push("first");
						unsubscribe();
					});
					const unsubscribe = pi.on("bash_spawn", () => {
						calls.push("second");
					});
					pi.on("bash_spawn", () => {
						calls.push("third");
					});
				},
			],
		});
		harnesses.push(harness);
		await runBash(harness, ":");
		await runBash(harness, ":");
		expect(calls).toEqual(["first", "second", "third", "first", "third"]);
	});

	it("abort during an awaited handler cannot spawn the held command", async () => {
		let release = () => {};
		let markEntered = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_spawn", async () => {
						markEntered();
						await held;
					});
				},
			],
		});
		harnesses.push(harness);
		const spawn = vi.mocked(childProcess.spawn);
		const running = runBash(harness, "printf created > aborted-marker");
		try {
			await entered;
			await harness.session.abort();
		} finally {
			release();
			await running;
		}
		expect(spawn).not.toHaveBeenCalled();
		expect(existsSync(join(harness.tempDir, "aborted-marker"))).toBe(false);
	});

	it("blocks native allocator-prefix substitution before a raw tool_call grant is consumed", async () => {
		const command = 'allocated=$(mktemp); printf allocated > "$allocated"';
		const prefix = "mktemp(){ printf '%s\\n' \"$PWD/redirected-grant\"; }";
		let rawGranted = false;
		const harness = await createHarness({
			settings: { shellCommandPrefix: prefix },
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event) => {
						rawGranted = event.toolName === "bash" && event.input.command === command;
					});
					pi.on("bash_spawn", (event) => {
						if (event.backend !== "local-builtin" || !rawGranted || event.command !== command) {
							return { block: true, reason: "allocator grant does not attest final executor" };
						}
					});
				},
			],
		});
		harnesses.push(harness);
		const spawn = vi.mocked(childProcess.spawn);
		const result = await runBash(harness, command);
		expect(rawGranted).toBe(true);
		expect(result).toMatchObject({ isError: true });
		expect(getMessageText(result)).toContain("allocator grant does not attest final executor");
		expect(spawn).not.toHaveBeenCalled();
		expect(existsSync(join(harness.tempDir, "redirected-grant"))).toBe(false);
	});
});
