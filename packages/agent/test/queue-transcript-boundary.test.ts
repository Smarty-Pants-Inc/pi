import { type AssistantMessage, createAssistantMessageEventStream, type SystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "done" }],
	api: "openai-responses",
	provider: "openai",
	model: "mock",
	stopReason: "stop",
	timestamp: 1,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

function fixture() {
	let requests = 0;
	const agent = new Agent({
		initialState: { messages: [assistant] },
		streamFn: () => {
			if (++requests > 3) throw new Error("Unexpected repeated queue delivery");
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: { ...assistant } });
			return stream;
		},
	});
	return { agent, requests: () => requests };
}

// smarty-dev#217: v0.87 transcript normalization must not change queue ownership.
describe.each(["steer", "followUp"] as const)("%s transcript transfer", (queue) => {
	it.each(["initial", "later"] as const)("consumes a normalized system message once on the %s path", async (path) => {
		const { agent, requests } = fixture();
		const message: SystemMessage = {
			role: "system",
			content: "queued instructions",
			toolsRemoved: [{ name: "not-installed" }],
			timestamp: 2,
		};
		if (path === "initial") agent[queue](message);
		else
			agent.finishTurn = () => {
				if (requests() === 1) agent[queue](message);
			};

		if (path === "initial") await agent.continue();
		else await agent.prompt("start");

		const stored = agent.state.messages.filter(
			(value) => value.role === "system" && value.content === message.content,
		);
		expect(stored).toHaveLength(1);
		expect(stored[0]).not.toBe(message);
		expect(stored[0]).not.toHaveProperty("toolsRemoved");
		expect(message.toolsRemoved).toEqual([{ name: "not-installed" }]);
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(requests()).toBe(path === "initial" ? 1 : 2);
	});

	it.each(["initial", "later"] as const)("does not deliver a cleared normalized tail on the %s path", async (path) => {
		const { agent, requests } = fixture();
		agent.steeringMode = "all";
		agent.followUpMode = "all";
		const first: SystemMessage = { role: "system", content: "first", timestamp: 2 };
		const tail: SystemMessage = {
			role: "system",
			content: "cleared",
			toolsRemoved: [{ name: "not-installed" }],
			timestamp: 3,
		};
		const enqueue = () => {
			agent[queue](first);
			agent[queue](tail);
		};
		if (path === "initial") enqueue();
		else
			agent.finishTurn = () => {
				if (requests() === 1) enqueue();
			};
		agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message === first) {
				await Promise.resolve();
				agent.clearAllQueues();
			}
		});

		if (path === "initial") await agent.continue();
		else await agent.prompt("start");

		expect(agent.state.messages).toContain(first);
		expect(agent.state.messages.some((value) => value.role === "system" && value.content === tail.content)).toBe(
			false,
		);
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(requests()).toBe(path === "initial" ? 1 : 2);
	});

	// Abort is excluded: like upstream, queued input still reaches the aborted run.
	it.each(["clear", "fail"] as const)(
		"does not manufacture a provider turn when preparation ends with %s",
		async (action) => {
			const { agent, requests } = fixture();
			const message: SystemMessage = { role: "system", content: "retained", timestamp: 2 };
			agent.finishTurn = () => {
				if (requests() === 1) agent[queue](message);
			};
			agent.prepareNextTurn = async () => {
				await Promise.resolve();
				if (action === "clear") agent.clearAllQueues();
				else throw new Error("preparation failed");
				return undefined;
			};

			await agent.prompt("start");

			expect(requests()).toBe(1);
			expect(agent.state.messages).not.toContain(message);
			expect(agent.hasQueuedMessages()).toBe(action !== "clear");
			if (action === "fail") expect(agent.state.errorMessage).toBe("preparation failed");
		},
	);
});

it("keeps explicit context-only continuation and its prepared transcript messages", async () => {
	const { agent, requests } = fixture();
	const prepared: SystemMessage = { role: "system", content: "prepared", timestamp: 2 };
	agent.finishTurn = () => (requests() === 1 ? { action: "continue" } : undefined);
	agent.prepareNextTurn = () => ({ messages: [prepared] });
	await agent.prompt("start");
	expect(requests()).toBe(2);
	expect(agent.state.messages).toContain(prepared);
});
