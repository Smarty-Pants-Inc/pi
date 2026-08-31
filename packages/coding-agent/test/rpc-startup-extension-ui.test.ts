import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { BashResult } from "../src/core/bash-executor.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
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
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			if (rpcIo.lineHandler === onLine) {
				rpcIo.lineHandler = undefined;
			}
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

type SignalListenerSnapshot = {
	signal: NodeJS.Signals;
	listeners: NodeListener[];
};

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: SignalListenerSnapshot[];
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
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const { signal, listeners: previousListeners } of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
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

describe("RPC startup extension UI", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		rpcIo.onOutputLine = undefined;
		rpcIo.backpressureWaits = 0;
	});

	it("accepts session_start dialog responses before dispatching queued commands", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const sessionStartResults: Array<boolean | string | undefined> = [];
		const uiMethods: string[] = [];
		const drainedCommandIds: string[] = [];
		let sessionStartComplete = false;
		let inputWasAttachedForUiRequests = true;
		let startupCommandsSent = false;
		let commandsSentDuringSessionStart = false;
		let getStateRanAfterSessionStart: boolean | undefined;
		let resolveBash!: (result: BashResult) => void;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						sessionStartResults.push(await ctx.ui.confirm("Confirm", "Continue?"));
						sessionStartResults.push(await ctx.ui.select("Select", ["choice"]));
						sessionStartResults.push(await ctx.ui.input("Input", "Type here"));
						sessionStartResults.push(await ctx.ui.editor("Editor", "Prefill"));
						sessionStartComplete = true;
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
				if (typeof record.method === "string") {
					uiMethods.push(record.method);
				}
				const response = responseForUiRequest(record);
				const lineHandler = rpcIo.lineHandler;
				if (!response || !lineHandler) {
					inputWasAttachedForUiRequests = false;
					return;
				}

				lineHandler(JSON.stringify(response));
				if (!startupCommandsSent) {
					startupCommandsSent = true;
					commandsSentDuringSessionStart = !sessionStartComplete;
					lineHandler(JSON.stringify({ id: "startup-bash", type: "bash", command: "blocked" }));
					lineHandler(JSON.stringify({ id: "startup-state", type: "get_state" }));
					lineHandler(JSON.stringify({ id: "startup-commands", type: "get_commands" }));
				}
				return;
			}

			if (record.type === "response" && (record.id === "startup-state" || record.id === "startup-commands")) {
				drainedCommandIds.push(record.id);
				if (record.id === "startup-state") {
					getStateRanAfterSessionStart = sessionStartComplete;
				}
			}
		};

		try {
			void runRpcMode(createRuntimeHost(harness));

			await vi.waitFor(() => {
				expect(sessionStartComplete).toBe(true);
				expect(executeBash).toHaveBeenCalledOnce();
				expect(drainedCommandIds).toEqual(["startup-state", "startup-commands"]);
			});

			expect(inputWasAttachedForUiRequests).toBe(true);
			expect(commandsSentDuringSessionStart).toBe(true);
			expect(getStateRanAfterSessionStart).toBe(true);
			resolveBash({ output: "", exitCode: undefined, cancelled: true, truncated: false });
			expect(uiMethods).toEqual(["confirm", "select", "input", "editor"]);
			expect(sessionStartResults).toEqual([true, "choice", "input", "edited"]);
		} finally {
			resolveBash({ output: "", exitCode: undefined, cancelled: true, truncated: false });
			executeBash.mockRestore();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	it("accepts a dialog response after 256 buffered startup commands", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		let sessionStartComplete = false;
		let confirmed: boolean | undefined;
		let startupInputSent = false;
		let stateResponses = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						confirmed = await ctx.ui.confirm("Confirm", "Continue?");
						sessionStartComplete = true;
					});
				},
			],
		});

		rpcIo.onOutputLine = (line) => {
			const record = JSON.parse(line) as Record<string, unknown>;
			if (record.type === "extension_ui_request" && !startupInputSent) {
				const response = responseForUiRequest(record);
				const lineHandler = rpcIo.lineHandler;
				if (!response || !lineHandler) throw new Error("Expected an attached input handler for the startup dialog");
				startupInputSent = true;
				for (let index = 0; index < 256; index++) {
					lineHandler(JSON.stringify({ id: `startup-${index}`, type: "get_state" }));
				}
				lineHandler(JSON.stringify(response));
				return;
			}
			if (record.type === "response" && typeof record.id === "string" && record.id.startsWith("startup-")) {
				stateResponses++;
			}
		};

		try {
			void runRpcMode(createRuntimeHost(harness));

			await vi.waitFor(() => {
				expect(sessionStartComplete).toBe(true);
				expect(stateResponses).toBe(256);
			});

			expect(confirmed).toBe(true);
			expect(rpcIo.lineHandler).toBeDefined();
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	it("fails on the first startup queue overflow without draining queued commands", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const dialogResults: Array<boolean | string | undefined> = [];
		const uiMethods: string[] = [];
		let sessionStartComplete = false;
		let shutdownAfterSessionStart: boolean | undefined;
		let overflowSent = false;
		const dispose = vi.fn(async () => {
			shutdownAfterSessionStart = sessionStartComplete;
		});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						const [confirmed, selected] = await Promise.all([
							ctx.ui.confirm("Confirm", "Continue?"),
							ctx.ui.select("Select", ["choice"]),
						]);
						dialogResults.push(confirmed, selected);
						sessionStartComplete = true;
					});
				},
			],
		});

		rpcIo.onOutputLine = (line) => {
			const record = JSON.parse(line) as Record<string, unknown>;
			if (record.type !== "extension_ui_request" || typeof record.method !== "string") return;
			uiMethods.push(record.method);
			if (overflowSent) return;
			overflowSent = true;
			queueMicrotask(() => {
				const lineHandler = rpcIo.lineHandler;
				if (!lineHandler) throw new Error("Expected an attached input handler for the startup overflow");
				for (let index = 0; index < 300; index++) {
					lineHandler(JSON.stringify({ id: `startup-${index}`, type: "get_state" }));
				}
			});
		};

		try {
			void runRpcMode({
				session: harness.session,
				newSession: vi.fn(async () => ({ cancelled: true })),
				switchSession: vi.fn(async () => ({ cancelled: true })),
				fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
				dispose,
				setRebindSession: vi.fn(),
			} as unknown as AgentSessionRuntime);

			await vi.waitFor(() => {
				expect(sessionStartComplete).toBe(true);
				expect(dispose).toHaveBeenCalledOnce();
				expect(exit).toHaveBeenCalledOnce();
			});

			const responses = rpcIo.outputLines
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter((record) => record.type === "response");
			const overflowErrors = responses.filter(
				(record) => record.success === false && record.error === "RPC startup command queue limit exceeded",
			);
			expect(overflowErrors).toEqual([
				expect.objectContaining({
					command: "parse",
					success: false,
				}),
			]);
			expect(
				responses.filter(
					(record) => record.success === true && typeof record.id === "string" && record.id.startsWith("startup-"),
				),
			).toEqual([]);
			expect(rpcIo.lineHandler).toBeUndefined();
			expect(dialogResults).toEqual([false, undefined]);
			expect(uiMethods).toEqual(["confirm", "select"]);
			expect(shutdownAfterSessionStart).toBe(true);
			expect(exit).toHaveBeenCalledWith(1);
			expect(rpcIo.backpressureWaits).toBe(0);
		} finally {
			exit.mockRestore();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	it.each(["valid", "malformed"] as const)(
		"rejects an oversized %s pre-bind record before parsing or execution",
		async (kind) => {
			const listenerSnapshot = takeListenerSnapshot();
			let sessionStartComplete = false;
			let oversizedRecordSent = false;
			let shutdownAfterSessionStart: boolean | undefined;
			const dispose = vi.fn(async () => {
				shutdownAfterSessionStart = sessionStartComplete;
			});
			const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async (_event, ctx) => {
							await ctx.ui.confirm("Confirm", "Continue?");
							sessionStartComplete = true;
						});
					},
				],
			});
			const executeBash = vi.spyOn(harness.session, "executeBash");
			const payload = "\u00e9".repeat(8 * 1024 * 1024);
			const oversizedRecord =
				kind === "valid"
					? JSON.stringify({ id: "oversized", type: "bash", command: payload })
					: `{"id":"oversized","type":"bash","command":"${payload}`;
			expect(Buffer.byteLength(oversizedRecord)).toBeGreaterThan(16 * 1024 * 1024);

			rpcIo.onOutputLine = (line) => {
				const record = JSON.parse(line) as Record<string, unknown>;
				if (record.type !== "extension_ui_request" || oversizedRecordSent) return;
				oversizedRecordSent = true;
				queueMicrotask(() => {
					const lineHandler = rpcIo.lineHandler;
					if (!lineHandler) throw new Error("Expected an attached input handler for the oversized startup record");
					lineHandler(oversizedRecord);
				});
			};

			try {
				void runRpcMode({
					session: harness.session,
					newSession: vi.fn(async () => ({ cancelled: true })),
					switchSession: vi.fn(async () => ({ cancelled: true })),
					fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
					dispose,
					setRebindSession: vi.fn(),
				} as unknown as AgentSessionRuntime);

				await vi.waitFor(() => {
					expect(sessionStartComplete).toBe(true);
					expect(dispose).toHaveBeenCalledOnce();
					expect(exit).toHaveBeenCalledOnce();
				});

				const responses = rpcIo.outputLines
					.map((line) => JSON.parse(line) as Record<string, unknown>)
					.filter((record) => record.type === "response");
				expect(responses).toEqual([
					expect.objectContaining({
						command: "parse",
						error: "RPC startup command queue limit exceeded",
						success: false,
					}),
				]);
				expect(executeBash).not.toHaveBeenCalled();
				expect(rpcIo.lineHandler).toBeUndefined();
				expect(shutdownAfterSessionStart).toBe(true);
				expect(exit).toHaveBeenCalledWith(1);
				expect(rpcIo.backpressureWaits).toBe(0);
			} finally {
				executeBash.mockRestore();
				exit.mockRestore();
				harness.cleanup();
				restoreListeners(listenerSnapshot);
			}
		},
	);

	it("waits for concurrent startup command responses before EOF shutdown", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		let sessionStartComplete = false;
		let startupInputSent = false;
		let resolveBash!: (result: BashResult) => void;
		let shutdownAfterBashResponse = false;
		const dispose = vi.fn(async () => {
			shutdownAfterBashResponse = rpcIo.outputLines.some((line) => {
				const record = JSON.parse(line) as Record<string, unknown>;
				return record.type === "response" && record.id === "slow-startup-bash" && record.success === true;
			});
		});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						await ctx.ui.confirm("Confirm", "Continue?");
						sessionStartComplete = true;
					});
				},
			],
		});
		const pendingBash = new Promise<BashResult>((resolve) => {
			resolveBash = resolve;
		});
		const executeBash = vi.spyOn(harness.session, "executeBash").mockReturnValue(pendingBash);

		rpcIo.onOutputLine = (line) => {
			const request = JSON.parse(line) as Record<string, unknown>;
			if (request.type !== "extension_ui_request" || startupInputSent) return;
			const response = responseForUiRequest(request);
			const lineHandler = rpcIo.lineHandler;
			if (!response || !lineHandler) {
				throw new Error("Expected an attached input handler for the startup dialog");
			}

			startupInputSent = true;
			lineHandler(JSON.stringify(response));
			lineHandler(JSON.stringify({ id: "slow-startup-bash", type: "bash", command: "slow" }));
			lineHandler(JSON.stringify({ id: "startup-state", type: "get_state" }));
			const onInputEnd = (process.stdin.listeners("end") as NodeListener[]).find(
				(listener) => !listenerSnapshot.stdinEnd.includes(listener),
			);
			if (!onInputEnd) {
				throw new Error("Expected RPC mode to listen for stdin EOF");
			}
			onInputEnd.call(process.stdin);
		};

		try {
			void runRpcMode({
				session: harness.session,
				newSession: vi.fn(async () => ({ cancelled: true })),
				switchSession: vi.fn(async () => ({ cancelled: true })),
				fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
				dispose,
				setRebindSession: vi.fn(),
			} as unknown as AgentSessionRuntime);

			await vi.waitFor(() => {
				expect(sessionStartComplete).toBe(true);
				expect(executeBash).toHaveBeenCalledOnce();
				expect(rpcIo.outputLines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
					expect.objectContaining({ id: "startup-state", type: "response", success: true }),
				);
			});
			expect(dispose).not.toHaveBeenCalled();

			resolveBash({ output: "", exitCode: undefined, cancelled: true, truncated: false });
			await vi.waitFor(() => {
				expect(dispose).toHaveBeenCalledOnce();
				expect(exit).toHaveBeenCalledWith(0);
			});
			expect(shutdownAfterBashResponse).toBe(true);
		} finally {
			resolveBash({ output: "", exitCode: undefined, cancelled: true, truncated: false });
			executeBash.mockRestore();
			exit.mockRestore();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	it("defers stdin EOF until session_start binding completes", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		let sessionStartComplete = false;
		let shutdownAfterSessionStart: boolean | undefined;
		let inputEnded = false;
		const dispose = vi.fn(async () => {
			shutdownAfterSessionStart = sessionStartComplete;
		});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						await ctx.ui.confirm("Confirm", "Continue?");
						sessionStartComplete = true;
					});
				},
			],
		});

		rpcIo.onOutputLine = (line) => {
			const request = JSON.parse(line) as Record<string, unknown>;
			if (request.type !== "extension_ui_request" || inputEnded) return;

			const response = responseForUiRequest(request);
			const lineHandler = rpcIo.lineHandler;
			if (!response || !lineHandler) {
				throw new Error("Expected an attached input handler for the startup dialog");
			}

			lineHandler(JSON.stringify(response));
			inputEnded = true;
			const onInputEnd = (process.stdin.listeners("end") as NodeListener[]).find(
				(listener) => !listenerSnapshot.stdinEnd.includes(listener),
			);
			if (!onInputEnd) {
				throw new Error("Expected RPC mode to listen for stdin EOF");
			}
			onInputEnd.call(process.stdin);
		};

		try {
			void runRpcMode({
				session: harness.session,
				newSession: vi.fn(async () => ({ cancelled: true })),
				switchSession: vi.fn(async () => ({ cancelled: true })),
				fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
				dispose,
				setRebindSession: vi.fn(),
			} as unknown as AgentSessionRuntime);

			await vi.waitFor(() => {
				expect(sessionStartComplete).toBe(true);
				expect(dispose).toHaveBeenCalledOnce();
			});

			expect(shutdownAfterSessionStart).toBe(true);
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			exit.mockRestore();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	it("cancels all pending startup dialogs on stdin EOF", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const dialogDefaults: Array<boolean | string | undefined> = [];
		const uiMethods: string[] = [];
		let sessionStartComplete = false;
		let shutdownAfterSessionStart: boolean | undefined;
		let inputEnded = false;
		const dispose = vi.fn(async () => {
			shutdownAfterSessionStart = sessionStartComplete;
		});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						const confirmation = ctx.ui.confirm("Confirm", "Continue?");
						const selection = ctx.ui.select("Select", ["choice"]);
						const [confirmed, selected] = await Promise.all([confirmation, selection]);
						dialogDefaults.push(confirmed, selected);
						dialogDefaults.push(await ctx.ui.input("Input", "Type here"));
						dialogDefaults.push(await ctx.ui.editor("Editor", "Prefill"));
						sessionStartComplete = true;
					});
				},
			],
		});

		rpcIo.onOutputLine = (line) => {
			const request = JSON.parse(line) as Record<string, unknown>;
			if (request.type !== "extension_ui_request" || typeof request.method !== "string") return;
			uiMethods.push(request.method);
			if (inputEnded || uiMethods.length !== 2) return;

			inputEnded = true;
			const onInputEnd = (process.stdin.listeners("end") as NodeListener[]).find(
				(listener) => !listenerSnapshot.stdinEnd.includes(listener),
			);
			if (!onInputEnd) {
				throw new Error("Expected RPC mode to listen for stdin EOF");
			}
			onInputEnd.call(process.stdin);
		};

		try {
			void runRpcMode({
				session: harness.session,
				newSession: vi.fn(async () => ({ cancelled: true })),
				switchSession: vi.fn(async () => ({ cancelled: true })),
				fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
				dispose,
				setRebindSession: vi.fn(),
			} as unknown as AgentSessionRuntime);

			await vi.waitFor(() => {
				expect(sessionStartComplete).toBe(true);
				expect(dispose).toHaveBeenCalledOnce();
			});

			expect(dialogDefaults).toEqual([false, undefined, undefined, undefined]);
			expect(uiMethods).toEqual(["confirm", "select"]);
			expect(shutdownAfterSessionStart).toBe(true);
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			exit.mockRestore();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});
