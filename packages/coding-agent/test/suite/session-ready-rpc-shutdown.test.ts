import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import type { UserMessageReceipt } from "../../src/index.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness, getUserTexts, type Harness, type HarnessOptions } from "./harness.ts";

const io = vi.hoisted(() => ({
	lines: [] as string[],
	receive: undefined as ((line: string) => void) | undefined,
}));
vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	takeOverStdout: () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: (line: string) => io.lines.push(line),
}));
vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: (_stream: NodeJS.ReadableStream, receive: (line: string) => void) => {
		io.receive = receive;
		return () => {
			io.receive = undefined;
		};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const harnesses: Harness[] = [];
const signals = ["SIGTERM", "SIGHUP"] as const;
type Listener = Parameters<typeof process.on>[1];
const oldSignals = new Map(signals.map((signal) => [signal, process.listeners(signal) as Listener[]]));
const oldEnd = process.stdin.listeners("end") as Listener[];
afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()!.cleanup();
	for (const signal of signals) {
		for (const listener of process.listeners(signal) as Listener[]) {
			if (!oldSignals.get(signal)?.includes(listener)) process.off(signal, listener);
		}
	}
	for (const listener of process.stdin.listeners("end") as Listener[]) {
		if (!oldEnd.includes(listener)) process.stdin.off("end", listener);
	}
	io.receive = undefined;
	io.lines = [];
});

// smarty-dev#10453 review: RPC defers a requested shutdown by a macrotask after the lifecycle completes.
// A shutdown requested from a held session_start must win: session_ready must not fire and start a
// turn that the shutdown would then wait for.
it("withholds session_ready when an RPC shutdown is requested during a held session_start", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const startEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const ready: string[] = [];
	const submissions: Promise<UserMessageReceipt>[] = [];
	const extension: ExtensionFactory = (pi) => {
		pi.on("session_start", async (event, ctx) => {
			if (event.reason !== "new") return;
			ctx.shutdown();
			entered();
			await held;
		});
		pi.on("session_ready", (event) => {
			ready.push(event.reason);
			submissions.push(
				pi.submitUserMessage({
					registrationEpoch: "epoch-1",
					requestId: "from-ready",
					sessionGeneration: event.sessionGeneration,
					text: "from session_ready",
					deliverAs: "followUp",
					expandPromptTemplates: false,
				}),
			);
		});
	};
	const create = async (options: HarnessOptions) => {
		const harness = await createHarness({
			...options,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [extension],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("turn from session_ready")]);
		return harness;
	};
	const initial = await create({ persistSession: true });
	let incoming: Harness | undefined;
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		incoming = await create({ cwd, sessionManager, sessionStartEvent });
		return {
			session: incoming.session,
			extensionsResult: incoming.resourceLoader.getExtensions(),
			services: {
				cwd,
				agentDir: initial.tempDir,
				modelRuntime: incoming.modelRuntime,
				settingsManager: incoming.settingsManager,
				resourceLoader: incoming.resourceLoader,
				diagnostics: [],
			},
			diagnostics: [],
		};
	};
	const runtime = new AgentSessionRuntime(
		initial.session,
		{
			cwd: initial.tempDir,
			agentDir: initial.tempDir,
			modelRuntime: initial.modelRuntime,
			settingsManager: initial.settingsManager,
			resourceLoader: initial.resourceLoader,
			diagnostics: [],
		},
		createRuntime,
	);
	const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	void runRpcMode(runtime);
	const receive = await vi.waitFor(() => {
		if (!io.receive) throw new Error("Waiting for ingress");
		return io.receive;
	});
	receive(JSON.stringify({ type: "get_state", id: "bound" }));
	await vi.waitFor(() => expect(io.lines.some((line) => line.includes('"id":"bound"'))).toBe(true));

	receive(JSON.stringify({ type: "new_session", id: "replace" }));
	await startEntered;
	release();

	await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
	await Promise.allSettled(submissions);
	expect(ready).toEqual([]);
	expect(incoming).toBeDefined();
	expect(incoming!.session.isDisposed).toBe(true);
	expect(getUserTexts(incoming!)).toEqual([]);
});
