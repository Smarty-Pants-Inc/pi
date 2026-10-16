import { type AssistantMessage, createAssistantMessageEventStream, type SystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentMessage } from "../src/types.ts";

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

function inputMessage() {
	return {
		role: "user",
		content: [
			{ type: "text", text: "prepared and queued" },
			{ type: "image", mimeType: "image/png", data: "retained-image" },
		],
		timestamp: 2,
	} satisfies AgentMessage;
}

function fixture() {
	const requests: AgentMessage[][] = [];
	const agent = new Agent({
		streamFn: (_model, context) => {
			requests.push(context.messages.slice());
			if (requests.length > 6) throw new Error("Unexpected repeated occurrence delivery");
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: { ...assistant } });
			return stream;
		},
	});
	return { agent, requests };
}

// #3155 DELTA-2: prepared input and queued input are separate occurrences, even when their objects alias.
describe.each(["steer", "followUp"] as const)("%s prepared/queued occurrence custody", (queue) => {
	// Pair the reported alias failure with distinct equal-valued objects and repeated queued reference controls.
	it.each(
		(["all", "one-at-a-time"] as const).flatMap((mode) =>
			(["same-reference", "equal-value"] as const).flatMap((relation) =>
				([1, 2] as const).map((copies) => ({ mode, relation, copies })),
			),
		),
	)("commits prepared plus $copies queued $relation occurrences in $mode mode", async ({ mode, relation, copies }) => {
		const { agent, requests } = fixture();
		agent.steeringMode = mode;
		agent.followUpMode = mode;
		const prepared = inputMessage();
		const queued = relation === "same-reference" ? prepared : inputMessage();
		expect(queued).toEqual(prepared);
		if (relation === "equal-value") expect(queued).not.toBe(prepared);
		agent.finishTurn = () => {
			if (requests.length !== 1) return;
			for (let index = 0; index < copies; index++) agent[queue](queued);
		};
		agent.prepareNextTurn = () => (requests.length === 1 ? { messages: [prepared] } : undefined);
		const started: AgentMessage[] = [];
		const ended: AgentMessage[] = [];
		agent.subscribe((event) => {
			if (event.type !== "message_start" && event.type !== "message_end") return;
			if (event.message.role !== "user" || event.message.timestamp !== 2) return;
			if (event.type === "message_start") started.push(event.message);
			else {
				ended.push(event.message);
				// Prepared commit leaves all queued occurrences in custody; each queued commit retires one.
				const retained = agent.getQueuedMessages();
				expect(retained).toHaveLength(copies - ended.length + 1);
				for (const message of retained) expect(message).toBe(queued);
			}
		});

		await agent.prompt("start");

		const expected = [prepared, ...Array.from({ length: copies }, () => queued)];
		const stored = agent.state.messages.filter((message) => message.role === "user" && message.timestamp === 2);
		expect(agent.state.errorMessage).toBeUndefined();
		expect(stored).toHaveLength(expected.length);
		expect(started).toHaveLength(expected.length);
		expect(ended).toHaveLength(expected.length);
		for (const [index, message] of expected.entries()) {
			expect(stored[index]).toBe(message);
			expect(started[index]).toBe(message);
			expect(ended[index]).toBe(message);
		}
		expect(requests).toHaveLength(mode === "all" ? 2 : 1 + copies);
		expect(requests.at(-1)?.filter((message) => message.role === "user" && message.timestamp === 2)).toEqual(
			expected,
		);
		expect(queued).toEqual(inputMessage());
		expect(agent.getQueuedMessages()).toEqual([]);
	});

	// #3155 DELTA-2/CR-1: a prepared commit must not steal custody before a queued start can fail.
	it.each(
		(["all", "one-at-a-time"] as const).flatMap((mode) =>
			(["same-reference", "equal-value"] as const).map((relation) => ({ mode, relation })),
		),
	)("recovers the queued $relation occurrence after start rejection in $mode mode", async ({ mode, relation }) => {
		const { agent, requests } = fixture();
		agent.steeringMode = mode;
		agent.followUpMode = mode;
		const prepared = inputMessage();
		const queued = relation === "same-reference" ? prepared : inputMessage();
		const failure = new Error("queued occurrence start failed");
		agent.finishTurn = () => {
			if (requests.length === 1) agent[queue](queued);
		};
		agent.prepareNextTurn = () => ({ messages: [prepared] });
		let starts = 0;
		let rejected = false;
		agent.subscribe(async (event) => {
			if (event.type !== "message_start" || event.message.role !== "user" || event.message.timestamp !== 2) return;
			if (++starts !== 2) return;
			rejected = true;
			expect(agent.getQueuedMessages()).toHaveLength(1);
			expect(agent.getQueuedMessages()[0]).toBe(queued);
			await Promise.resolve();
			throw failure;
		});

		await agent.prompt("start");

		expect(rejected).toBe(true);
		expect(requests).toHaveLength(1);
		expect(agent.state.errorMessage).toBe(failure.message);
		const committed = agent.state.messages.filter((message) => message.role === "user" && message.timestamp === 2);
		expect(committed).toHaveLength(1);
		expect(committed[0]).toBe(prepared);
		expect(agent.getQueuedMessages()).toHaveLength(1);
		expect(agent.getQueuedMessages()[0]).toBe(queued);

		agent.prepareNextTurn = undefined;
		await agent.continue({ fromQueuedMessages: true });

		const recovered = agent.state.messages.filter((message) => message.role === "user" && message.timestamp === 2);
		expect(agent.state.errorMessage).toBeUndefined();
		expect(recovered).toHaveLength(2);
		expect(recovered[0]).toBe(prepared);
		expect(recovered[1]).toBe(queued);
		expect(queued).toEqual(inputMessage());
		expect(requests).toHaveLength(2);
		expect(agent.getQueuedMessages()).toEqual([]);
	});

	// #3155 DELTA-2 counterexample: deliberate withdrawal still cancels only the queued occurrence.
	it("keeps the prepared alias when its reserved queued occurrence is cleared", async () => {
		const { agent, requests } = fixture();
		const shared = inputMessage();
		agent.finishTurn = () => {
			if (requests.length === 1) agent[queue](shared);
		};
		agent.prepareNextTurn = () => ({ messages: [shared] });
		let ends = 0;
		agent.subscribe((event) => {
			if (event.type !== "message_end" || event.message !== shared) return;
			ends++;
			expect(agent.getQueuedMessages()).toEqual([shared]);
			agent.clearAllQueues();
		});

		await agent.prompt("start");

		expect(agent.state.errorMessage).toBeUndefined();
		expect(ends).toBe(1);
		expect(agent.state.messages.filter((message) => message === shared)).toHaveLength(1);
		expect(requests).toHaveLength(2);
		expect(agent.getQueuedMessages()).toEqual([]);
	});

	// #3155 DELTA-2: normalization may copy the queued alias but must retain its exact source slot.
	it("commits a normalized queued system alias separately from its prepared occurrence", async () => {
		const { agent, requests } = fixture();
		const shared: SystemMessage = {
			role: "system",
			content: "aliased instructions",
			toolsRemoved: [{ name: "not-installed" }],
			timestamp: 2,
		};
		agent.finishTurn = () => {
			if (requests.length === 1) agent[queue](shared);
		};
		agent.prepareNextTurn = () => ({ messages: [shared] });
		let ends = 0;
		agent.subscribe((event) => {
			if (
				event.type !== "message_end" ||
				event.message.role !== "system" ||
				event.message.content !== shared.content
			)
				return;
			ends++;
			expect(agent.getQueuedMessages()).toEqual(ends === 1 ? [shared] : []);
		});

		await agent.prompt("start");

		const stored = agent.state.messages.filter(
			(message) => message.role === "system" && message.content === shared.content,
		);
		expect(agent.state.errorMessage).toBeUndefined();
		expect(ends).toBe(2);
		expect(stored).toHaveLength(2);
		expect(stored[0]).toBe(shared);
		expect(stored[1]).not.toBe(shared);
		expect(stored[1]).not.toHaveProperty("toolsRemoved");
		expect(shared.toolsRemoved).toEqual([{ name: "not-installed" }]);
		expect(requests).toHaveLength(2);
		expect(agent.getQueuedMessages()).toEqual([]);
	});
});

// #3155 DELTA-2: queue origin is independent of message identity across steering and follow-up queues too.
it("commits one prepared occurrence and one shared occurrence from each queue", async () => {
	const { agent, requests } = fixture();
	const shared = inputMessage();
	agent.finishTurn = () => {
		if (requests.length !== 1) return;
		agent.steer(shared);
		agent.followUp(shared);
	};
	agent.prepareNextTurn = () => (requests.length === 1 ? { messages: [shared] } : undefined);
	let ends = 0;
	agent.subscribe((event) => {
		if (event.type !== "message_end" || event.message !== shared) return;
		ends++;
		expect(agent.getQueuedMessages()).toHaveLength(3 - ends);
	});

	await agent.prompt("start");

	expect(agent.state.errorMessage).toBeUndefined();
	expect(ends).toBe(3);
	expect(agent.state.messages.filter((message) => message === shared)).toHaveLength(3);
	expect(requests).toHaveLength(3);
	expect(agent.getQueuedMessages()).toEqual([]);
});
