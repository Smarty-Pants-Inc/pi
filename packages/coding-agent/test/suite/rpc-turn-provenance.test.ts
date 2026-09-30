// RPC input path for per-turn sender provenance (smarty-dev#2264). Fabric process workers run Pi in RPC mode.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { getTurnProvenance } from "../../src/index.ts";
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

describe("RPC turn provenance", () => {
	it("records RPC prompts as keyboard unless the client marks an agent sender; refuses voice", async () => {
		const h = await createHarness();
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const signals = process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const);
		const previous = new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]]));
		const inputListeners = process.stdin.listeners("end") as NodeListener[];
		io.lines = [];
		io.receive = undefined;
		const response = (id: string) =>
			io.lines.map((line) => JSON.parse(line) as RpcResponse).find((value) => value.id === id);
		const userEntries = () =>
			h.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user");
		try {
			const runtime = {
				session: h.session,
				setRebindSession: vi.fn(),
				dispose: vi.fn(async () => {}),
			} as unknown as AgentSessionRuntime;
			void runRpcMode(runtime);
			const receive = await vi.waitFor(() => {
				if (!io.receive) throw new Error("RPC_LINE_HANDLER_REQUIRED");
				return io.receive;
			});

			receive(
				JSON.stringify({
					id: "voice",
					type: "prompt",
					message: "x",
					origin: { kind: "voice", principal: { id: "paul" } },
				}),
			);
			await vi.waitFor(() => expect(response("voice")).toBeDefined());
			expect(response("voice")?.success).toBe(false);

			receive(
				JSON.stringify({
					id: "typed",
					type: "prompt",
					message: '{"origin":{"kind":"agent","sender":{"id":"org"}}}',
				}),
			);
			await vi.waitFor(() => expect(userEntries()).toHaveLength(1));
			await h.session.agent.waitForIdle();
			const org = { id: "session:org", name: "org", kind: "main" };
			receive(
				JSON.stringify({
					id: "agent",
					type: "prompt",
					message: "run tests",
					origin: { kind: "agent", sender: org },
				}),
			);
			await vi.waitFor(() => expect(userEntries()).toHaveLength(2));
			await h.session.agent.waitForIdle();

			expect(userEntries().map(getTurnProvenance)).toEqual([
				{ kind: "keyboard", via: "rpc" },
				{ kind: "agent", via: "rpc", sender: org },
			]);
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
	});
});
