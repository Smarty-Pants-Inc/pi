import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../src/modes/rpc/rpc-types.ts";
import { createHarness } from "./suite/harness.ts";

const rpcIo = vi.hoisted(() => ({
	requests: [] as RpcExtensionUIRequest[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	failOutput: false,
}));
vi.mock("../src/core/output-guard.ts", () => ({
	takeOverStdout: () => {},
	flushRawStdout: async () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: (line: string) => {
		if (rpcIo.failOutput) throw new Error("output failed");
		const record = JSON.parse(line) as RpcExtensionUIRequest;
		if (record.type === "extension_ui_request") rpcIo.requests.push(record);
	},
}));
vi.mock("../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: (_stream: NodeJS.ReadableStream, handler: (line: string) => void) => {
		rpcIo.lineHandler = handler;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

interface RpcFixture {
	ui: ExtensionUIContext;
	respond(response: RpcExtensionUIResponse): void;
	end(): void;
}

async function withRpc(test: (fixture: RpcFixture) => Promise<void>): Promise<void> {
	let ui: ExtensionUIContext | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					ui = ctx.ui;
				});
			},
		],
	});
	const previousEnd = process.stdin.listeners("end");
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	const previousSignals = signals.map((signal) => ({ signal, listeners: process.listeners(signal) }));
	type NodeListener = Parameters<typeof process.on>[1];
	const dispose = vi.fn(async () => {});
	const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	const runtime = {
		session: harness.session,
		setRebindSession: () => {},
		dispose,
	} as unknown as AgentSessionRuntime;
	let runError: unknown;
	void runRpcMode(runtime).catch((error: unknown) => {
		runError = error;
	});
	const end = () => {
		for (const listener of process.stdin.listeners("end")) {
			if (!previousEnd.includes(listener)) listener.call(process.stdin);
		}
	};
	try {
		await vi.waitFor(() => expect(ui).toBeDefined());
		if (!ui) throw new Error("RPC UI was not bound");
		await test({
			ui,
			respond: (response) => rpcIo.lineHandler?.(JSON.stringify(response)),
			end,
		});
		expect(runError).toBeUndefined();
	} finally {
		rpcIo.failOutput = false;
		end();
		await vi.waitFor(() => {
			expect(dispose).toHaveBeenCalledOnce();
			expect(exit).toHaveBeenCalledWith(0);
		});
		exit.mockRestore();
		for (const listener of process.stdin.listeners("end")) {
			if (!previousEnd.includes(listener)) process.stdin.off("end", listener as () => void);
		}
		for (const { signal, listeners } of previousSignals) {
			for (const listener of process.listeners(signal)) {
				if (!listeners.includes(listener)) process.off(signal, listener as NodeListener);
			}
		}
		harness.cleanup();
	}
}

describe("RPC UI hold state (smarty-dev#2440, smarty-code#870)", () => {
	afterEach(() => {
		rpcIo.requests = [];
		rpcIo.lineHandler = undefined;
		rpcIo.failOutput = false;
	});

	it.each(["select", "confirm", "input", "editor"] as const)(
		"tracks pending %s requests on close and client cancel",
		async (kind) => {
			await withRpc(async ({ ui, respond }) => {
				for (const cancelled of [false, true]) {
					expect(ui.holdState()).toBeUndefined();
					const pending =
						kind === "select"
							? ui.select("Pick", ["choice"])
							: kind === "confirm"
								? ui.confirm("Confirm", "Continue?")
								: kind === "input"
									? ui.input("Input")
									: ui.editor("Edit");
					expect(ui.holdState()).toBe("dialog");
					const request = rpcIo.requests.at(-1);
					if (!request) throw new Error("Expected a pending UI request");
					respond(
						cancelled
							? { type: "extension_ui_response", id: request.id, cancelled: true }
							: kind === "confirm"
								? { type: "extension_ui_response", id: request.id, confirmed: true }
								: { type: "extension_ui_response", id: request.id, value: "value" },
					);
					await pending;
					expect(ui.holdState()).toBeUndefined();
				}
			});
		},
	);

	it("keeps simultaneous requests held until the last response", async () => {
		await withRpc(async ({ ui, respond }) => {
			const first = ui.input("First");
			const firstId = rpcIo.requests.at(-1)?.id;
			const second = ui.input("Second");
			const secondId = rpcIo.requests.at(-1)?.id;
			if (!firstId || !secondId) throw new Error("Expected two UI requests");
			expect(ui.holdState()).toBe("dialog");
			respond({ type: "extension_ui_response", id: firstId, value: "first" });
			await first;
			expect(ui.holdState()).toBe("dialog");
			respond({ type: "extension_ui_response", id: secondId, cancelled: true });
			await second;
			expect(ui.holdState()).toBeUndefined();
		});
	});

	it("clears local abort, timeout, EOF and output-error paths", async () => {
		await withRpc(async ({ ui, end }) => {
			const controller = new AbortController();
			const aborted = ui.confirm("Confirm", "Continue?", { signal: controller.signal });
			expect(ui.holdState()).toBe("dialog");
			controller.abort();
			expect(await aborted).toBe(false);
			expect(ui.holdState()).toBeUndefined();
			const timed = ui.input("Input", undefined, { timeout: 1 });
			expect(ui.holdState()).toBe("dialog");
			await timed;
			expect(ui.holdState()).toBeUndefined();
			rpcIo.failOutput = true;
			await expect(ui.input("Input")).rejects.toThrow("output failed");
			rpcIo.failOutput = false;
			expect(ui.holdState()).toBeUndefined();
			const first = ui.confirm("Confirm", "Continue?");
			const second = ui.editor("Edit");
			expect(ui.holdState()).toBe("dialog");
			end();
			await Promise.all([first, second]);
			expect(ui.holdState()).toBeUndefined();
		});
	});

	it("does not hold for notifications, unsupported custom UI, or already-aborted requests", async () => {
		await withRpc(async ({ ui }) => {
			ui.notify("notice");
			expect(ui.holdState()).toBeUndefined();
			await ui.custom(() => {
				throw new Error("must not run");
			});
			expect(ui.holdState()).toBeUndefined();
			const controller = new AbortController();
			controller.abort();
			await ui.input("Input", undefined, { signal: controller.signal });
			expect(ui.holdState()).toBeUndefined();
		});
	});
});

describe("non-UI hold state", () => {
	it.each(["print", "json"] as const)("reports no holds in %s mode", async (mode) => {
		const harness = await createHarness();
		try {
			await harness.session.bindExtensions({ mode });
			const ui = harness.session.extensionRunner.createContext().ui;
			expect(ui.holdState()).toBeUndefined();
			await ui.confirm("Confirm", "Continue?");
			await ui.custom(() => {
				throw new Error("must not run");
			});
			expect(ui.holdState()).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});
});
