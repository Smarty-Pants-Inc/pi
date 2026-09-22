import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import type { RpcResponse, RpcSessionState } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness } from "./harness.ts";

const io = vi.hoisted(() => ({
	lines: [] as string[],
	receive: undefined as ((line: string) => void) | undefined,
}));
vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}), takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => { io.lines.push(line); },
}));
vi.mock("../../src/modes/interactive/theme/theme.ts", () => ({ theme: {} }));
vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: (_stream: NodeJS.ReadableStream, receive: (line: string) => void) => {
		io.receive = receive;
		return () => { io.receive = undefined; };
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

describe("RPC launch compaction provenance (faux, no process/model probe)", () => {
	it.each([
		{ args: [], enabled: true, selected: false },
		{ args: [], enabled: false, selected: false },
		{ args: ["--no-auto-compaction"], enabled: true, selected: true },
		{ args: ["--no-auto-compaction"], enabled: false, selected: true },
		{ args: ["--no-auto-compaction=true"], enabled: false, selected: false },
	])("keeps native selection distinct from settings: %j", async ({ args, enabled, selected }) => {
		const h = await createHarness({ settings: { compaction: { enabled } } });
		const signals = process.platform === "win32" ? ["SIGTERM"] as const : ["SIGTERM", "SIGHUP"] as const;
		const previous = new Map(signals.map(signal => [signal, process.listeners(signal) as NodeListener[]]));
		const inputListeners = process.stdin.listeners("end") as NodeListener[];
		io.lines = [];
		io.receive = undefined;
		try {
			const parsed = parseArgs(args);
			let applied = false;
			if (parsed.noAutoCompaction) {
				h.settingsManager.applyOverrides({ compaction: { enabled: false } });
				applied = true;
			}
			const runtime = {
				session: h.session, setRebindSession: vi.fn(), dispose: vi.fn(async () => {}),
			} as unknown as AgentSessionRuntime;
			const options = { autoCompactionDisabledForProcess: applied };
			// Exercise default invocation separately; a global false cannot supply provenance.
			void (applied ? runRpcMode(runtime, options) : runRpcMode(runtime));
			options.autoCompactionDisabledForProcess = false;
			await vi.waitFor(() => expect(io.receive).toBeDefined());
			// Extra command DATA must not be a setter for launch provenance.
			io.receive?.(JSON.stringify({ id: "state", type: "get_state", autoCompactionDisabledForProcess: true }));
			await vi.waitFor(() => expect(io.lines.some(line => line.includes('"id":"state"'))).toBe(true));
			const response = io.lines.map(line => JSON.parse(line) as RpcResponse).find(value => value.id === "state");
			expect(response?.success).toBe(true);
			if (!response?.success || response.command !== "get_state") throw new Error("STATE_REQUIRED");
			expectTypeOf<RpcSessionState["autoCompactionDisabledForProcess"]>().toEqualTypeOf<boolean>();
			expect(response.data.autoCompactionDisabledForProcess).toBe(selected);
			expect(response.data.autoCompactionEnabled).toBe(selected ? false : enabled);
			expect(h.settingsManager.getGlobalSettings().compaction?.enabled).toBe(enabled);
			if (selected) {
				// Provenance is not an immutable policy: the client must check BOTH fields.
				h.settingsManager.applyOverrides({ compaction: { enabled: true } });
				io.receive?.(JSON.stringify({ id: "changed", type: "get_state" }));
				await vi.waitFor(() => expect(io.lines.some(line => line.includes('"id":"changed"'))).toBe(true));
				const changed = io.lines.map(line => JSON.parse(line) as RpcResponse).find(value => value.id === "changed");
				if (!changed?.success || changed.command !== "get_state") throw new Error("STATE_REQUIRED");
				expect(changed.data.autoCompactionDisabledForProcess).toBe(true);
				expect(changed.data.autoCompactionEnabled).toBe(true);
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
	});
});
