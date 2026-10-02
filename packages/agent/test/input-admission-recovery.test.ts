import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentMessage } from "../src/types.ts";

// smarty-dev#3048: a shutdown receipt must include the complete backlog, not just the next batch.
describe("lossless input queue recovery", () => {
	it.each(["all", "one-at-a-time"] as const)(
		"snapshots both complete %s queues without consuming or changing their modes",
		(mode) => {
			const agent = new Agent({
				streamFn: () => {
					throw new Error("unexpected model call");
				},
				steeringMode: mode,
				followUpMode: mode,
			});
			const messages: AgentMessage[] = Array.from({ length: 4 }, (_, index) => ({
				role: "user",
				timestamp: index,
				content: [
					{ type: "text", text: String(index) },
					{ type: "image", mimeType: "image/png", data: String(index) },
				],
			}));
			agent.steer(messages[0]!);
			agent.steer(messages[1]!);
			agent.followUp(messages[2]!);
			agent.followUp(messages[3]!);
			const snapshot = agent.getQueuedMessages();
			expect(snapshot).toEqual(messages);
			snapshot.pop();
			expect(agent.getQueuedMessages()).toEqual(messages);
			expect(agent.steeringMode).toBe(mode);
			expect(agent.followUpMode).toBe(mode);
			expect(agent.peekQueuedMessages()).toEqual(mode === "all" ? messages.slice(0, 2) : messages.slice(0, 1));
			agent.clearAllQueues();
			expect(agent.getQueuedMessages()).toEqual([]);
		},
	);
});
