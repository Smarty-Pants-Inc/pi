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

	// #3155 CR-1: failed publication must retain the original normalized source until explicit recovery.
	it.each(
		(["initial", "later"] as const).flatMap((path) =>
			(["retain", "remove", "clear"] as const).map((action) => ({ path, action })),
		),
	)("recovers the $path normalized batch after a start failure and $action", async ({ path, action }) => {
		const { agent, requests } = fixture();
		agent.steeringMode = "all";
		agent.followUpMode = "all";
		const original: SystemMessage = {
			role: "system",
			content: "normalized retry",
			toolsRemoved: [{ name: "not-installed" }],
			timestamp: 2,
		};
		const tail: AgentMessage = {
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: "retained-image" }],
			timestamp: 3,
		};
		const newer: AgentMessage = { role: "user", content: "newer", timestamp: 4 };
		let enqueued = false;
		const enqueue = () => {
			if (enqueued) return;
			enqueued = true;
			agent[queue](original);
			agent[queue](tail);
		};
		if (path === "initial") enqueue();
		else agent.finishTurn = enqueue;
		const failure = new Error("normalized start listener failed");
		let failed = false;
		agent.subscribe(async (event) => {
			if (event.type !== "message_start" || event.message.role !== "system") return;
			if (event.message.content !== original.content || failed) return;
			failed = true;
			expect(event.message).not.toBe(original);
			await Promise.resolve();
			throw failure;
		});

		if (path === "initial") await agent.continue();
		else await agent.prompt("start");
		expect(failed).toBe(true);
		expect(agent.state.errorMessage).toBe(failure.message);
		expect(agent.getQueuedMessages()).toEqual([original, tail]);
		expect(
			agent.state.messages.some((message) => message.role === "system" && message.content === original.content),
		).toBe(false);
		expect(requests()).toBe(path === "initial" ? 0 : 1);

		if (action === "remove") agent.removeQueuedMessages((message) => message === original);
		if (action === "clear") agent.clearAllQueues();
		agent[queue](newer);
		await agent.continue({ fromQueuedMessages: true });
		const stored = agent.state.messages.filter(
			(message) => message.role === "system" && message.content === original.content,
		);
		expect(stored).toHaveLength(action === "retain" ? 1 : 0);
		if (action === "retain") expect(stored[0]).not.toHaveProperty("toolsRemoved");
		expect(original.toolsRemoved).toEqual([{ name: "not-installed" }]);
		expect(agent.state.messages.filter((message) => message === tail || message === newer)).toEqual(
			action === "clear" ? [newer] : [tail, newer],
		);
		expect(tail.content).toEqual([{ type: "image", mimeType: "image/png", data: "retained-image" }]);
		expect(agent.getQueuedMessages()).toEqual([]);
		expect(requests()).toBe(path === "initial" ? 1 : 2);
	});

	// #3155 CR-3: invalidate the selected occurrence, not the last equal message reference.
	it("keeps the normalized alias when an earlier reserved occurrence is selectively removed", async () => {
		const { agent, requests } = fixture();
		agent.steeringMode = "all";
		agent.followUpMode = "all";
		const first: SystemMessage = { role: "system", content: "before aliases", timestamp: 2 };
		const shared: SystemMessage = {
			role: "system",
			content: "aliased instructions",
			toolsRemoved: [{ name: "not-installed" }],
			timestamp: 3,
		};
		agent[queue](first);
		agent[queue](shared);
		agent[queue](shared);
		agent.subscribe((event) => {
			if (event.type !== "message_end" || event.message !== first) return;
			let visited = 0;
			agent.removeQueuedMessages((message) => message === shared && ++visited === 2);
			expect(agent.getQueuedMessages()).toEqual([shared]);
		});
		await agent.continue();
		const stored = agent.state.messages.filter(
			(message) => message.role === "system" && message.content === shared.content,
		);
		expect(stored).toHaveLength(1);
		expect(stored[0]).not.toBe(shared);
		expect(stored[0]).not.toHaveProperty("toolsRemoved");
		expect(shared.toolsRemoved).toEqual([{ name: "not-installed" }]);
		expect(agent.getQueuedMessages()).toEqual([]);
		expect(requests()).toBe(1);
	});

	// #3155 CR-1/CR-3: a withdrawn start must not consume another equal reserved occurrence.
	it("rechecks the current normalized occurrence after a start listener removes its alias", async () => {
		const { agent, requests } = fixture();
		agent.steeringMode = "all";
		agent.followUpMode = "all";
		const shared: SystemMessage = {
			role: "system",
			content: "withdraw the first alias",
			toolsRemoved: [{ name: "not-installed" }],
			timestamp: 2,
		};
		agent[queue](shared);
		agent[queue](shared);
		let originalEnded = false;
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message === shared) originalEnded = true;
			if (event.type !== "message_start" || event.message !== shared) return;
			let visited = 0;
			agent.removeQueuedMessages((message) => message === shared && ++visited === 2);
			expect(agent.getQueuedMessages()).toEqual([shared]);
		});
		await agent.continue();
		const stored = agent.state.messages.filter(
			(message) => message.role === "system" && message.content === shared.content,
		);
		expect(originalEnded).toBe(false);
		expect(stored).toHaveLength(1);
		expect(stored[0]).not.toBe(shared);
		expect(stored[0]).not.toHaveProperty("toolsRemoved");
		expect(agent.getQueuedMessages()).toEqual([]);
		expect(requests()).toBe(1);
	});

	// Abort is covered below: queued input still reaches the aborted transcript.
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

	// smarty-dev#244 (N1), smarty-dev#14950: transfer queued input without dispatching after abort.
	it("delivers input queued before an abort once, to the aborted run", async () => {
		const signals: boolean[] = [];
		const agent = new Agent({
			initialState: { messages: [assistant] },
			streamFn: (_model, _context, options) => {
				const aborted = options?.signal?.aborted === true;
				signals.push(aborted);
				const stream = createAssistantMessageEventStream();
				if (aborted) {
					stream.push({ type: "error", reason: "aborted", error: { ...assistant, stopReason: "aborted" } });
				} else {
					stream.push({ type: "done", reason: "stop", message: { ...assistant } });
				}
				return stream;
			},
		});
		const message: SystemMessage = { role: "system", content: "queued before abort", timestamp: 2 };
		agent.finishTurn = ({ message: completed }) => {
			if (completed.stopReason !== "aborted" && signals.length === 1) agent[queue](message);
		};
		agent.prepareNextTurn = async () => {
			await Promise.resolve();
			agent.abort();
			return undefined;
		};

		await agent.prompt("start");

		expect(signals).toEqual([false]);
		expect(
			agent.state.messages.filter((value) => value.role === "system" && value.content === message.content),
		).toHaveLength(1);
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(agent.state.isStreaming).toBe(false);
	});
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
