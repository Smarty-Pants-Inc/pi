import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentMessage } from "../src/types.ts";

const assistant: AssistantMessage = {
	role: "assistant",
	content: [],
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

function queuedMessage(index: number): AgentMessage {
	return {
		role: "user",
		timestamp: index,
		content: [
			{ type: "text", text: String(index) },
			{ type: "image", mimeType: "image/png", data: String(index) },
		],
	};
}

function fixture(messages: AgentMessage[] = [assistant]) {
	let requests = 0;
	const agent = new Agent({
		initialState: { messages },
		streamFn: () => {
			if (++requests > 6) throw new Error("Unexpected repeated queue delivery");
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: { ...assistant } });
			return stream;
		},
	});
	return { agent, requests: () => requests };
}

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
			const messages = Array.from({ length: 4 }, (_, index) => queuedMessage(index));
			agent.steer(messages[0]);
			agent.steer(messages[1]);
			agent.followUp(messages[2]);
			agent.followUp(messages[3]);
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

	// smarty-dev#3048: failed preparation releases reservations, not the retained input.
	it.each(["steer", "followUp"] as const)("recovers %s images and order after failed preparation", async (queue) => {
		const { agent, requests } = fixture();
		const first = queuedMessage(1);
		const second = queuedMessage(2);
		let queued = false;
		agent.finishTurn = () => {
			if (queued) return;
			queued = true;
			agent[queue](first);
			agent[queue](second);
		};
		agent.prepareNextTurn = async () => {
			expect(agent.getQueuedMessages()).toEqual([first, second]);
			throw new Error("preparation failed");
		};
		await agent.prompt("start");
		expect(requests()).toBe(1);
		expect(agent.getQueuedMessages()).toEqual([first, second]);
		expect(agent.state.messages).not.toContain(first);
		expect(agent.state.errorMessage).toBe("preparation failed");

		agent.prepareNextTurn = undefined;
		await agent.continue({ fromQueuedMessages: true });
		expect(agent.state.messages.filter((message) => message === first || message === second)).toEqual([
			first,
			second,
		]);
		expect(agent.getQueuedMessages()).toEqual([]);
		expect(requests()).toBe(3);
	});

	// pi#187: invalidating one metadata input must not release or retarget a sibling reservation.
	it.each(["steer", "followUp"] as const)("removes a reserved %s tail without losing its sibling", async (queue) => {
		const { agent } = fixture();
		agent.steeringMode = "all";
		agent.followUpMode = "all";
		const first = queuedMessage(1);
		const removed = queuedMessage(2);
		const third = queuedMessage(3);
		agent[queue](first);
		agent[queue](removed);
		agent[queue](third);
		agent.subscribe(async (event) => {
			if (event.type !== "message_end" || event.message !== first) return;
			await Promise.resolve();
			agent.removeQueuedMessages((message) => message === removed);
			expect(agent.getQueuedMessages()).toEqual([third]);
		});
		await agent.continue();
		expect(agent.state.messages.filter((message) => [first, removed, third].includes(message))).toEqual([
			first,
			third,
		]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	// #3155 CR-1: a failed start retains input; a failed end already committed it.
	it.each(
		(["steer", "followUp"] as const).flatMap((queue) =>
			(["all", "one-at-a-time"] as const).flatMap((mode) =>
				(["message_start", "message_end"] as const).map((stage) => ({ queue, mode, stage })),
			),
		),
	)(
		"recovers $queue/$mode after $stage rejection without losing or replaying images",
		async ({ queue, mode, stage }) => {
			const { agent, requests } = fixture();
			agent.steeringMode = mode;
			agent.followUpMode = mode;
			const first = queuedMessage(1);
			const second = queuedMessage(2);
			const newer = queuedMessage(3);
			const failure = new Error(`${stage} listener failed`);
			let failed = false;
			agent[queue](first);
			agent[queue](second);
			agent.subscribe(async (event) => {
				if (event.type !== "message_start" && event.type !== "message_end") return;
				if (event.type !== stage || event.message !== first || failed) return;
				failed = true;
				await Promise.resolve();
				expect(agent.getQueuedMessages()).toEqual(stage === "message_start" ? [first, second] : [second]);
				throw failure;
			});

			await agent.continue();
			expect(failed).toBe(true);
			expect(requests()).toBe(0);
			expect(agent.state.errorMessage).toBe(failure.message);
			expect(agent.state.messages.filter((message) => message === first)).toHaveLength(
				stage === "message_end" ? 1 : 0,
			);
			expect(agent.getQueuedMessages()).toEqual(stage === "message_start" ? [first, second] : [second]);

			agent[queue](newer);
			await agent.continue({ fromQueuedMessages: true });
			expect(agent.state.messages.filter((message) => [first, second, newer].includes(message))).toEqual([
				first,
				second,
				newer,
			]);
			expect([first, second, newer]).toEqual([queuedMessage(1), queuedMessage(2), queuedMessage(3)]);
			expect(agent.getQueuedMessages()).toEqual([]);
			expect(requests()).toBe(mode === "all" ? 1 : stage === "message_start" ? 3 : 2);
		},
	);

	// #3155 CR-3: two queue occurrences can share one message object.
	it.each((["steer", "followUp"] as const).flatMap((queue) => [false, true].map((remove) => ({ queue, remove }))))(
		"delivers only live aliased $queue occurrences with removal=$remove",
		async ({ queue, remove }) => {
			const { agent, requests } = fixture();
			agent.steeringMode = "all";
			agent.followUpMode = "all";
			const shared = queuedMessage(1);
			agent[queue](shared);
			agent[queue](shared);
			let ended = 0;
			agent.subscribe((event) => {
				if (event.type !== "message_end" || event.message !== shared) return;
				if (++ended !== 1) return;
				expect(agent.getQueuedMessages()).toEqual([shared]);
				if (remove) agent.removeQueuedMessages((message) => message === shared);
			});
			await agent.continue();
			expect(ended).toBe(remove ? 1 : 2);
			expect(agent.state.messages.filter((message) => message === shared)).toHaveLength(remove ? 1 : 2);
			expect(agent.getQueuedMessages()).toEqual([]);
			expect(requests()).toBe(1);
		},
	);

	// #3155 CR-3 counterexample: withdrawing an unreserved alias must not cancel a selected occurrence.
	it.each(
		(["steer", "followUp"] as const).flatMap((queue) =>
			(["selected", "unreserved"] as const).map((removed) => ({ queue, removed })),
		),
	)("removes only the $removed aliased $queue occurrence", async ({ queue, removed }) => {
		const { agent, requests } = fixture();
		const shared = queuedMessage(1);
		agent[queue](shared);
		agent[queue](shared);
		let visited = 0;
		const unsubscribe = agent.subscribe((event) => {
			if (event.type !== "agent_start") return;
			agent.removeQueuedMessages(() => ++visited === (removed === "unreserved" ? 1 : 2));
		});
		await agent.continue();
		unsubscribe();
		expect(visited).toBe(2);
		expect(requests()).toBe(removed === "unreserved" ? 1 : 0);
		expect(agent.getQueuedMessages()).toEqual(removed === "selected" ? [shared] : []);
		if (removed === "selected") await agent.continue({ fromQueuedMessages: true });
		expect(agent.state.messages.filter((message) => message === shared)).toHaveLength(1);
		expect(agent.getQueuedMessages()).toEqual([]);
		expect(requests()).toBe(1);
	});

	// pi#187: the enqueue acknowledgement is synchronous and proves insertion, not execution.
	it("acknowledges follow-up custody after insertion and retains it if the acknowledgement throws", () => {
		const { agent, requests } = fixture();
		const message = queuedMessage(1);
		const failure = new Error("acknowledgement failed");
		let acknowledgements = 0;
		expect(() =>
			agent.followUp(message, () => {
				acknowledgements++;
				expect(agent.getQueuedMessages()).toEqual([message]);
				throw failure;
			}),
		).toThrow(failure);
		expect(acknowledgements).toBe(1);
		expect(requests()).toBe(0);
		expect(agent.getQueuedMessages()).toEqual([message]);
	});

	// smarty-dev#3048: explicit recovery must not retry an old non-assistant transcript tail.
	it("starts from queued input even when a prior failed request left a user tail", async () => {
		const old = queuedMessage(0);
		const next = queuedMessage(1);
		const { agent, requests } = fixture([old]);
		let delivered = false;
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message === next) delivered = true;
		});
		agent.followUp(next);
		agent.prepareRequest = async () => {
			expect(delivered).toBe(true);
			return undefined;
		};
		await agent.continue({ fromQueuedMessages: true });
		expect(requests()).toBe(1);
		expect(agent.state.messages.filter((message) => message === next)).toHaveLength(1);
		await expect(agent.continue({ fromQueuedMessages: true })).rejects.toThrow("No queued messages to continue from");
	});
});
