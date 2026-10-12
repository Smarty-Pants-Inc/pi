import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

// pi#132 R5-S3: handled input owes no agent_settled, so promptAndWait completes on its disposition.
describe("RpcClient promptAndWait disposition", () => {
	it.each(["handled", "run"] as const)("completes %s prompts on the correct signal", async (disposition) => {
		const client = new RpcClient();
		const listeners = new Set<(event: unknown) => void>();
		vi.spyOn(client, "onEvent").mockImplementation((listener) => {
			listeners.add(listener as (event: unknown) => void);
			return () => listeners.delete(listener as (event: unknown) => void);
		});
		(client as unknown as { send: (command: unknown) => Promise<unknown> }).send = vi.fn(async () => {
			if (disposition === "run")
				setTimeout(() => {
					for (const listener of [...listeners]) listener({ type: "agent_settled", outcome: "completed" });
				}, 10);
			return { type: "response", command: "prompt", success: true, data: { disposition } };
		});
		const events = await client.promptAndWait("hi", undefined, 1000);
		expect(events).toEqual(disposition === "run" ? [{ type: "agent_settled", outcome: "completed" }] : []);
		expect(listeners.size).toBe(0);
	});
});
