import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const io = vi.hoisted(() => ({ lines: [] as string[], receive: undefined as ((line: string) => void) | undefined }));
vi.mock("../../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		io.lines.push(line);
	},
}));
vi.mock("../../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: (_stream: NodeJS.ReadableStream, receive: (line: string) => void) => {
		io.receive = receive;
		return () => {
			io.receive = undefined;
		};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const disconnect = "stream error: stream disconnected before completion: stream closed before response.completed";
type NodeListener = Parameters<typeof process.on>[1];

// smarty-dev#3200: exercise actual print/RPC subscribers, session recovery and the faux provider.
describe("headless stream recovery notices", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		vi.restoreAllMocks();
		io.lines = [];
		io.receive = undefined;
	});

	it.each(["text", "json"] as const)(
		"%s print mode announces retry and fallback before the next call",
		async (mode) => {
			const h = await createHarness({
				models: [{ id: "primary" }, { id: "alternate" }],
				settings: { retry: { baseDelayMs: 0, fallbackModel: "faux/alternate" } },
			});
			harnesses.push(h);
			h.setResponses([
				...Array.from({ length: 3 }, () =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect }),
				),
				fauxAssistantMessage("alternate completed"),
			]);
			const notices: { callCount: number; message: string }[] = [];
			vi.spyOn(console, "error").mockImplementation((message: unknown) => {
				notices.push({ callCount: h.faux.state.callCount, message: String(message) });
			});
			const runtime = {
				session: h.session,
				setRebindSession: vi.fn(),
				dispose: vi.fn(async () => {}),
			} as unknown as AgentSessionRuntime;
			const exitCode = await runPrintMode(runtime, { mode, initialMessage: "test" });
			expect(exitCode).toBe(0);
			expect(h.faux.state.callCount).toBe(4);
			expect(notices).toMatchObject([
				{ callCount: 1, message: expect.stringContaining("Retrying (1/2)") },
				{ callCount: 2, message: expect.stringContaining("Retrying (2/2)") },
				{ callCount: 3, message: expect.stringContaining("Failed over from faux/primary to faux/alternate") },
			]);
			if (mode === "text") expect(io.lines).toEqual(["alternate completed\n"]);
			else {
				const records = io.lines.map((line) => JSON.parse(line) as { type: string });
				expect(records.filter((record) => record.type === "auto_retry_start")).toHaveLength(2);
				expect(records.filter((record) => record.type === "auto_retry_fallback")).toHaveLength(1);
				expect(records.at(-1)?.type).toBe("agent_settled");
			}
		},
	);

	it("print mode exits with a clear error after two retries with fallback off", async () => {
		const h = await createHarness({ settings: { retry: { baseDelayMs: 0 } } });
		harnesses.push(h);
		h.setResponses(
			Array.from({ length: 3 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect })),
		);
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = {
			session: h.session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;
		expect(await runPrintMode(runtime, { mode: "text", initialMessage: "test" })).toBe(1);
		expect(h.faux.state.callCount).toBe(3);
		expect(stderr).toHaveBeenCalledWith(`Retry failed after 2 retries: ${disconnect}`);
		expect(stderr).toHaveBeenCalledWith(disconnect);
		expect(io.lines).toEqual([]);
	});

	it("RPC recovers automatically and publishes retry/fallback events plus immediate stderr notices", async () => {
		const h = await createHarness({
			models: [{ id: "primary" }, { id: "alternate" }],
			settings: { retry: { baseDelayMs: 0, fallbackModel: "faux/alternate" } },
		});
		harnesses.push(h);
		h.setResponses([
			...Array.from({ length: 3 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect }),
			),
			fauxAssistantMessage("alternate completed"),
		]);
		const notices: { callCount: number; message: string }[] = [];
		vi.spyOn(console, "error").mockImplementation((message: unknown) => {
			notices.push({ callCount: h.faux.state.callCount, message: String(message) });
		});
		const signals = process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const);
		const previous = new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]]));
		const inputListeners = process.stdin.listeners("end") as NodeListener[];
		try {
			const runtime = {
				session: h.session,
				setRebindSession: vi.fn(),
				dispose: vi.fn(async () => {}),
			} as unknown as AgentSessionRuntime;
			void runRpcMode(runtime);
			const receive = await vi.waitFor(() => {
				if (!io.receive) throw new Error("RPC not bound");
				return io.receive;
			});
			receive(JSON.stringify({ id: "task", type: "prompt", message: "test" }));
			await vi.waitFor(() => expect(io.lines.some((line) => line.includes('"type":"agent_settled"'))).toBe(true));
			await h.session.waitForIdle();
			const records = io.lines.map((line) => JSON.parse(line) as { type: string; outcome?: string });
			expect(records.filter((record) => record.type === "auto_retry_start")).toHaveLength(2);
			expect(records.filter((record) => record.type === "auto_retry_fallback")).toHaveLength(1);
			expect(records.at(-1)).toMatchObject({ type: "agent_settled", outcome: "completed" });
			expect(h.faux.state.callCount).toBe(4);
			expect(notices).toMatchObject([
				{ callCount: 1, message: expect.stringContaining("Retrying (1/2)") },
				{ callCount: 2, message: expect.stringContaining("Retrying (2/2)") },
				{ callCount: 3, message: expect.stringContaining("Failed over from faux/primary to faux/alternate") },
			]);
		} finally {
			for (const listener of process.stdin.listeners("end") as NodeListener[])
				if (!inputListeners.includes(listener)) process.stdin.off("end", listener);
			for (const signal of signals)
				for (const listener of process.listeners(signal) as NodeListener[])
					if (!previous.get(signal)?.includes(listener)) process.off(signal, listener);
		}
	});
});
