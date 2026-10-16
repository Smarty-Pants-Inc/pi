import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import type { RpcResponse } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness } from "./harness.ts";

const io = vi.hoisted(() => ({
	lines: [] as string[],
	receive: undefined as ((line: string) => void) | undefined,
}));
vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		io.lines.push(line);
	},
}));
vi.mock("../../src/modes/interactive/theme/theme.ts", () => ({ theme: {} }));
vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: (_stream: NodeJS.ReadableStream, receive: (line: string) => void) => {
		io.receive = receive;
		return () => {
			io.receive = undefined;
		};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

// Refs Smarty-Pants-Inc/smarty-dev#2742. Real RPC dispatch + AgentSession + faux provider; only transport capture is mocked.
describe("RPC model switch context admission", () => {
	it.each([false, true])(
		"set_model compacts before its response or refuses cancellation (cancel: %s)",
		async (cancel) => {
			const h = await createHarness({
				models: [
					{ id: "opus", contextWindow: 1_000_000 },
					{ id: "sol", contextWindow: 272_000 },
				],
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: cancel
					? [
							(pi) => {
								pi.on("session_before_compact", () => ({ cancel: true }));
							},
						]
					: undefined,
			});
			const signals = process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const);
			const previous = new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]]));
			const inputListeners = process.stdin.listeners("end") as NodeListener[];
			io.lines = [];
			io.receive = undefined;
			try {
				h.sessionManager.appendMessage({ role: "user", content: "old context", timestamp: Date.now() - 2000 });
				h.sessionManager.appendMessage({
					...fauxAssistantMessage("old answer", { timestamp: Date.now() - 1000 }),
					api: h.getModel().api,
					provider: h.getModel().provider,
					model: h.getModel().id,
					usage: {
						input: 230_000,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 230_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
				h.session.refreshContext();
				h.setResponses([fauxAssistantMessage("RPC summary")]);
				const runtime = {
					session: h.session,
					setRebindSession: vi.fn(),
					setLifecycleCompleteHandler: vi.fn(),
					dispose: vi.fn(async () => {}),
				} as unknown as AgentSessionRuntime;
				void runRpcMode(runtime);
				const receive = await vi.waitFor(() => {
					if (!io.receive) throw new Error("RPC_LINE_HANDLER_REQUIRED");
					return io.receive;
				});
				receive(JSON.stringify({ id: "switch", type: "set_model", provider: "faux", modelId: "sol" }));
				await vi.waitFor(() => expect(io.lines.some((line) => line.includes('"id":"switch"'))).toBe(true));
				const records = io.lines.map((line) => JSON.parse(line) as RpcResponse | { type: string });
				const response = records.find(
					(record): record is RpcResponse =>
						record.type === "response" && "id" in record && record.id === "switch",
				);
				expect(response?.success).toBe(!cancel);
				expect(h.session.model?.id).toBe(cancel ? "opus" : "sol");
				expect(records.findIndex((r) => r.type === "compaction_start")).toBeLessThan(records.indexOf(response!));
				expect(records.findIndex((r) => r.type === "compaction_end")).toBeLessThan(records.indexOf(response!));
				if (cancel) {
					expect(response).toMatchObject({
						success: false,
						error: expect.stringMatching(/model switch refused/i),
					});
					expect(h.faux.state.callCount).toBe(0);
				} else {
					expect(h.faux.state.callCount).toBe(1);
					expect(h.eventsOfType("compaction_end")[0]?.result?.summary).toContain("RPC summary");
				}
			} finally {
				h.cleanup();
				for (const listener of process.stdin.listeners("end") as NodeListener[]) {
					if (!inputListeners.includes(listener)) process.stdin.off("end", listener);
				}
				for (const signal of signals) {
					for (const listener of process.listeners(signal) as NodeListener[]) {
						if (!previous.get(signal)?.includes(listener)) process.off(signal, listener);
					}
				}
				io.receive = undefined;
			}
		},
	);
});
