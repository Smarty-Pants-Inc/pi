import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { BashResult } from "../src/core/bash-executor.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string, rawFramedByteLength?: number) => void) | undefined,
	onOutputLine: undefined as ((line: string) => void) | undefined,
	backpressureWaits: 0,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: async () => {
		rpcIo.backpressureWaits += 1;
	},
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
		rpcIo.onOutputLine?.(line);
	},
}));
vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));
vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn(
		(_stream: NodeJS.ReadableStream, onLine: (line: string, rawFramedByteLength?: number) => void) => {
			rpcIo.lineHandler = onLine;
			return () => {
				if (rpcIo.lineHandler === onLine) rpcIo.lineHandler = undefined;
			};
		},
	),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];
type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Array<{ signal: NodeJS.Signals; listeners: NodeListener[] }>;
};
function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: signals.map((signal) => ({ signal, listeners: process.listeners(signal) as NodeListener[] })),
	};
}
function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const { signal, listeners } of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!listeners.includes(listener)) process.off(signal, listener);
		}
	}
}
function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async (options?: Parameters<AgentSessionRuntime["dispose"]>[0]) => {
			await options?.beforeShutdown?.();
		}),
		setRebindSession: vi.fn(),
		setLifecycleCompleteHandler: vi.fn(),
	} as unknown as AgentSessionRuntime;
}
function responseForUiRequest(request: Record<string, unknown>): Record<string, unknown> | undefined {
	if (typeof request.id !== "string") return undefined;
	switch (request.method) {
		case "confirm":
			return { type: "extension_ui_response", id: request.id, confirmed: true };
		case "select":
			return { type: "extension_ui_response", id: request.id, value: "choice" };
		case "input":
			return { type: "extension_ui_response", id: request.id, value: "input" };
		case "editor":
			return { type: "extension_ui_response", id: request.id, value: "edited" };
		default:
			return undefined;
	}
}
function records(): Array<Record<string, unknown>> {
	return rpcIo.outputLines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

// pi#132 / pi#116: generic startup buffering, bounded dialogs and terminal cancellation only.
// Fork-only fatal/cancel protocol fields are deliberately not required by these regressions.
describe("RPC startup extension UI", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		rpcIo.onOutputLine = undefined;
		rpcIo.backpressureWaits = 0;
	});

	it("accepts session_start dialog responses before dispatching queued commands", async () => {
		const snapshot = takeListenerSnapshot();
		const results: Array<boolean | string | undefined> = [];
		const methods: string[] = [];
		const drained: string[] = [];
		let complete = false;
		let sent = false;
		let attached = true;
		let sentBeforeComplete = false;
		let stateAfterComplete: boolean | undefined;
		let resolveBash!: (result: BashResult) => void;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						results.push(await ctx.ui.confirm("Confirm", "Continue?"));
						results.push(await ctx.ui.select("Select", ["choice"]));
						results.push(await ctx.ui.input("Input", "Type here"));
						results.push(await ctx.ui.editor("Editor", "Prefill"));
						complete = true;
					});
				},
			],
		});
		const pendingBash = new Promise<BashResult>((resolve) => {
			resolveBash = resolve;
		});
		const executeBash = vi.spyOn(harness.session, "executeBash").mockReturnValue(pendingBash);
		rpcIo.onOutputLine = (line) => {
			const record = JSON.parse(line) as Record<string, unknown>;
			if (record.type === "extension_ui_request") {
				if (typeof record.method === "string") methods.push(record.method);
				const response = responseForUiRequest(record);
				const input = rpcIo.lineHandler;
				if (!response || !input) {
					attached = false;
					return;
				}
				input(JSON.stringify(response));
				if (!sent) {
					sent = true;
					sentBeforeComplete = !complete;
					input(JSON.stringify({ id: "startup-bash", type: "bash", command: "blocked" }));
					input(JSON.stringify({ id: "startup-state", type: "get_state" }));
					input(JSON.stringify({ id: "startup-commands", type: "get_commands" }));
				}
			} else if (record.type === "response" && (record.id === "startup-state" || record.id === "startup-commands")) {
				drained.push(record.id);
				if (record.id === "startup-state") stateAfterComplete = complete;
			}
		};
		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => {
				expect(complete).toBe(true);
				expect(executeBash).toHaveBeenCalledOnce();
				expect(drained).toEqual(["startup-state", "startup-commands"]);
			});
			expect(attached).toBe(true);
			expect(sentBeforeComplete).toBe(true);
			expect(stateAfterComplete).toBe(true);
			expect(methods).toEqual(["confirm", "select", "input", "editor"]);
			expect(results).toEqual([true, "choice", "input", "edited"]);
		} finally {
			resolveBash({ output: "", exitCode: undefined, cancelled: true, truncated: false });
			executeBash.mockRestore();
			harness.cleanup();
			restoreListeners(snapshot);
		}
	});

	it("times out every untimed startup dialog and drains queued commands", async () => {
		const snapshot = takeListenerSnapshot();
		const requests: Array<Record<string, unknown>> = [];
		const defaults: Array<boolean | string | undefined> = [];
		let complete = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						defaults.push(
							...(await Promise.all([
								ctx.ui.confirm("Confirm", "Continue?"),
								ctx.ui.select("Select", ["choice"]),
								ctx.ui.input("Input", "Type here"),
								ctx.ui.editor("Editor", "Prefill"),
							])),
						);
						complete = true;
					});
				},
			],
		});
		vi.useFakeTimers();
		rpcIo.onOutputLine = (line) => {
			const record = JSON.parse(line) as Record<string, unknown>;
			if (record.type === "extension_ui_request") requests.push(record);
		};
		try {
			void runRpcMode(createRuntimeHost(harness));
			for (let attempt = 0; attempt < 20 && requests.length < 4; attempt++) await Promise.resolve();
			expect(requests.map((r) => r.method)).toEqual(["confirm", "select", "input", "editor"]);
			expect(requests.map((r) => r.timeout)).toEqual([300_000, 300_000, 300_000, 300_000]);
			rpcIo.lineHandler!(JSON.stringify({ id: "after-timeout", type: "get_state" }));
			await vi.advanceTimersByTimeAsync(299_999);
			expect(complete).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			for (let attempt = 0; attempt < 40 && !complete; attempt++) await Promise.resolve();
			expect(complete).toBe(true);
			expect(defaults).toEqual([false, undefined, undefined, undefined]);
			expect(records()).toContainEqual(expect.objectContaining({ id: "after-timeout", success: true }));
		} finally {
			vi.useRealTimers();
			harness.cleanup();
			restoreListeners(snapshot);
		}
	});

	it.each(["matched", "unmatched", "overflow"] as const)(
		"preserves the bounded startup UI response reserve (%s)",
		async (kind) => {
			const snapshot = takeListenerSnapshot();
			let sent = false;
			let confirmed: boolean | undefined;
			const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async (_event, ctx) => {
							confirmed = await ctx.ui.confirm("Confirm", "Continue?");
						});
					},
				],
			});
			rpcIo.onOutputLine = (line) => {
				const record = JSON.parse(line) as Record<string, unknown>;
				if (record.type !== "extension_ui_request" || sent) return;
				sent = true;
				const input = rpcIo.lineHandler!;
				for (let i = 0; i < 256; i++) input(JSON.stringify({ id: `startup-${i}`, type: "get_state" }));
				if (kind === "matched") input(JSON.stringify(responseForUiRequest(record)));
				else if (kind === "unmatched")
					input(JSON.stringify({ type: "extension_ui_response", id: "stale", confirmed: true }));
				else input(JSON.stringify({ id: "overflow", type: "get_state" }));
			};
			try {
				void runRpcMode(createRuntimeHost(harness));
				if (kind === "matched") {
					await vi.waitFor(() => expect(records().filter((r) => r.type === "response")).toHaveLength(256));
					expect(confirmed).toBe(true);
					expect(exit).not.toHaveBeenCalled();
				} else {
					await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
					const responses = records().filter((r) => r.type === "response");
					expect(responses).toHaveLength(257);
					expect(responses.filter((r) => r.id !== undefined)).toEqual(
						Array.from({ length: 256 }, (_, i) =>
							expect.objectContaining({
								id: `startup-${i}`,
								success: false,
								error: expect.stringContaining("INPUT_ADMISSION_SHUTDOWN"),
							}),
						),
					);
					expect(responses.find((r) => r.command === "parse")).toMatchObject({
						success: false,
						error: "RPC startup command queue limit exceeded",
					});
					expect(rpcIo.lineHandler).toBeUndefined();
				}
			} finally {
				exit.mockRestore();
				harness.cleanup();
				restoreListeners(snapshot);
			}
		},
	);

	it.each(["valid", "malformed", "raw-bytes"] as const)("uses raw startup byte limits (%s)", async (kind) => {
		const snapshot = takeListenerSnapshot();
		let sent = false;
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						await ctx.ui.confirm("Confirm", "Continue?");
					});
				},
			],
		});
		const executeBash = vi.spyOn(harness.session, "executeBash").mockResolvedValue({
			output: "",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
		});
		const payload = "é".repeat(8 * 1024 * 1024);
		const raw = Buffer.concat([
			Buffer.from('{"id":"raw","type":"bash","command":"'),
			Buffer.alloc(6 * 1024 * 1024, 0x80),
			Buffer.from('"}'),
		]);
		rpcIo.onOutputLine = (line) => {
			const record = JSON.parse(line) as Record<string, unknown>;
			if (record.type !== "extension_ui_request" || sent) return;
			sent = true;
			queueMicrotask(() => {
				const input = rpcIo.lineHandler!;
				if (kind === "raw-bytes") {
					input(raw.toString(), raw.byteLength + 1);
					input(JSON.stringify(responseForUiRequest(record)));
				} else
					input(
						kind === "valid"
							? JSON.stringify({ id: "oversized", type: "bash", command: payload })
							: `{"type":"bash","command":"${payload}`,
					);
			});
		};
		try {
			void runRpcMode(createRuntimeHost(harness));
			if (kind === "raw-bytes") {
				await vi.waitFor(() => expect(executeBash).toHaveBeenCalledOnce());
				expect(exit).not.toHaveBeenCalled();
			} else {
				await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
				expect(executeBash).not.toHaveBeenCalled();
				expect(records().filter((r) => r.type === "response")).toEqual([
					expect.objectContaining({
						command: "parse",
						error: "RPC startup command queue limit exceeded",
						success: false,
					}),
				]);
			}
		} finally {
			executeBash.mockRestore();
			exit.mockRestore();
			harness.cleanup();
			restoreListeners(snapshot);
		}
	});

	it.each(["end", "SIGTERM"] as const)("cancels binding and buffered commands on %s", async (ending) => {
		const snapshot = takeListenerSnapshot();
		let sent = false;
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						await ctx.ui.confirm("Confirm", "Continue?");
						await held;
					});
				},
			],
		});
		const host = createRuntimeHost(harness);
		const executeBash = vi.spyOn(harness.session, "executeBash");
		rpcIo.onOutputLine = (line) => {
			const record = JSON.parse(line) as Record<string, unknown>;
			if (record.type !== "extension_ui_request" || sent) return;
			sent = true;
			rpcIo.lineHandler!(JSON.stringify({ id: "held-bash", type: "bash", command: "slow" }));
			rpcIo.lineHandler!(JSON.stringify({ id: "held-state", type: "get_state" }));
			if (ending === "end") {
				const onEnd = (process.stdin.listeners("end") as NodeListener[]).find(
					(l) => !snapshot.stdinEnd.includes(l),
				);
				if (!onEnd) throw new Error("Expected EOF listener");
				onEnd.call(process.stdin);
			} else {
				const previous = snapshot.signals.find((s) => s.signal === "SIGTERM")?.listeners ?? [];
				const handler = (process.listeners("SIGTERM") as NodeListener[]).find((l) => !previous.includes(l));
				if (!handler) throw new Error("Expected signal listener");
				handler();
			}
		};
		try {
			void runRpcMode(host);
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(ending === "end" ? 0 : 143));
			expect(host.dispose).toHaveBeenCalledOnce();
			expect(harness.session.shutdownSignal.aborted).toBe(true);
			expect(executeBash).not.toHaveBeenCalled();
			const responses = records().filter((r) => r.type === "response");
			expect(responses.map((r) => r.id)).toEqual(["held-bash", "held-state"]);
			expect(responses.every((r) => r.success === false && /cancel/i.test(String(r.error)))).toBe(true);
			expect(rpcIo.lineHandler).toBeUndefined();
		} finally {
			release();
			executeBash.mockRestore();
			exit.mockRestore();
			harness.cleanup();
			restoreListeners(snapshot);
		}
	});
});
