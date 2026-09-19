import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";

describe("passive native lifecycle observer", () => {
	it("observes starts before awaited listeners, queue transfers, and actual settlement afterward", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("synthetic provider refusal");
			},
		});
		const events: Array<{ type: string; activeRun: boolean; steering: number; followUp: number }> = [];
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const listenerEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		agent.subscribe(async (event) => {
			if (event.type === "agent_start") {
				entered();
				await blocked;
			}
		});
		const detach = agent.observeLifecycle((event) => {
			events.push(event);
		});
		const run = agent.prompt("synthetic");
		await listenerEntered;
		expect(events.map((event) => event.type)).toEqual(["attached", "run_start", "agent_start"]);
		expect(() => agent.observeLifecycle(() => {})).toThrow(/observer/);
		agent.steer({ role: "user", content: [{ type: "text", text: "queued" }], timestamp: 1 });
		expect(events.at(-1)).toMatchObject({ type: "queue_update", activeRun: true, steering: 1 });
		agent.clearSteeringQueue();
		expect(events.at(-1)?.steering).toBe(0);
		release();
		await run;
		expect(events.at(-1)).toMatchObject({ type: "run_settled", activeRun: false });
		expect(events.some((event) => event.type === "turn_end")).toBe(true);
		detach();
		const count = events.length;
		agent.clearAllQueues();
		expect(events).toHaveLength(count);
	});

	it("wraps only actual loop stream calls with the original run signal", async () => {
		let direct = 0;
		const native = () => {
			direct++;
			throw new Error("synthetic stream refusal");
		};
		const agent = new Agent({ streamFn: native });
		const signals: AbortSignal[] = [];
		let wrapped = 0;
		const detach = agent.observeLifecycle(
			(event) => {
				if (event.type === "run_start") signals.push(agent.signal!);
			},
			(original, signal) =>
				(...args) => {
					expect(original).toBe(native);
					expect(signal).toBe(signals.at(-1));
					wrapped++;
					return original(...args);
				},
		);
		expect(() => native()).toThrow("synthetic stream refusal");
		expect(wrapped).toBe(0);
		await agent.prompt("first");
		await agent.prompt("second");
		expect(wrapped).toBe(2);
		expect(direct).toBe(3);
		expect(signals[0]).not.toBe(signals[1]);
		detach();
		await agent.prompt("after detach");
		expect(wrapped).toBe(2);
	});

	it("rolls back both hooks when the attached observer throws", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("synthetic stream refusal");
			},
		});
		let wrapped = 0;
		expect(() =>
			agent.observeLifecycle(
				() => {
					throw new Error("attachment refused");
				},
				(original) =>
					(...args) => {
						wrapped++;
						return original(...args);
					},
			),
		).toThrow("attachment refused");
		const detach = agent.observeLifecycle(() => {});
		await agent.prompt("after failed attachment");
		expect(wrapped).toBe(0);
		detach();
	});

	it("keeps a new same-callback registration when an old disposer is called again", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("synthetic stream refusal");
			},
		});
		const kinds: string[] = [];
		const observer: Parameters<Agent["observeLifecycle"]>[0] = (event) => {
			kinds.push(event.type);
		};
		const staleDetach = agent.observeLifecycle(observer);
		staleDetach();
		let wrapped = 0;
		const detach = agent.observeLifecycle(observer, (original) => (...args) => {
			wrapped++;
			return original(...args);
		});
		staleDetach();
		await agent.prompt("new registration");
		expect(wrapped).toBe(1);
		expect(kinds.at(-1)).toBe("run_settled");
		detach();
	});

	it.each(["steer", "followUp"] as const)("retains %s input when a transfer observation fails", async (enqueue) => {
		let streamCalls = 0;
		const agent = new Agent({
			streamFn: () => {
				streamCalls++;
				throw new Error("synthetic stream refusal");
			},
		});
		await agent.prompt("seed");
		const message = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "retained queued input" }],
			timestamp: 1,
		};
		agent[enqueue](message);
		let received = 0;
		agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message === message) {
				await Promise.resolve();
				received++;
			}
		});
		let fail = true;
		agent.observeLifecycle((event) => {
			if (event.type === "queue_update" && event.steering === 0 && event.followUp === 0 && fail) {
				fail = false;
				throw new Error("transfer refused");
			}
		});
		await agent.continue();
		expect(agent.state.messages.filter((value) => value === message)).toHaveLength(1);
		expect(received).toBe(1);
		expect(agent.state.errorMessage).toBe("transfer refused");
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(streamCalls).toBe(1);
		expect(agent.signal).toBeUndefined();
	});

	it("records settlement even when an awaited listener fails", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("no provider operation");
			},
		});
		const kinds: string[] = [];
		agent.observeLifecycle((event) => {
			kinds.push(event.type);
		});
		agent.subscribe(() => {
			throw new Error("synthetic listener failure");
		});
		await expect(agent.prompt("synthetic")).rejects.toThrow("synthetic listener failure");
		expect(kinds.at(-1)).toBe("run_settled");
		expect(agent.signal).toBeUndefined();
	});
});
