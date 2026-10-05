import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

function child() {
	const events = new EventEmitter();
	const kill = vi.fn();
	return {
		process: Object.assign(events, { kill, exitCode: null, signalCode: null }) as unknown as ChildProcess,
		kill,
	};
}

type ClientState = {
	process: ChildProcess | null;
	pendingRequests: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
};

// PR #141 cut item 8: retirement callbacks own the exact outgoing child and callers.
describe("RPC stop identity", () => {
	for (const finish of ["timeout", "exit"] as const) {
		it(`does not retire a replacement on outgoing ${finish}`, async () => {
			vi.useFakeTimers();
			try {
				const client = new RpcClient();
				const state = client as unknown as ClientState;
				const a = child();
				const b = child();
				state.process = a.process;
				const rejected = vi.fn();
				state.pendingRequests.set("a", { resolve: vi.fn(), reject: rejected });
				const stopped = client.stop();
				state.process = b.process;
				if (finish === "exit") a.process.emit("exit", 0, null);
				else await vi.advanceTimersByTimeAsync(1000);
				await stopped;
				expect(state.process).toBe(b.process);
				expect(b.kill).not.toHaveBeenCalled();
				expect(rejected).toHaveBeenCalledTimes(1);
				expect(rejected.mock.calls[0]?.[0]).toBeInstanceOf(Error);
				await vi.advanceTimersByTimeAsync(2000);
				expect(a.kill.mock.calls).toEqual(finish === "exit" ? [["SIGTERM"]] : [["SIGTERM"], ["SIGKILL"]]);
				expect(rejected).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});
	}
});
