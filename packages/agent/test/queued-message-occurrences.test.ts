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
			{ type: "text", text: "retained occurrence" },
			{ type: "image", mimeType: "image/png", data: "retained-image" },
		],
		timestamp: 2,
	} satisfies AgentMessage;
}

function fixture() {
	const requests: AgentMessage[][] = [];
	const agent = new Agent({
		initialState: { messages: [assistant] },
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

// pi#262 / smarty-dev#3155: snapshots must identify each enqueue, not each message object.
it("assigns IDs after insertion and returns detached occurrence and mode snapshots", () => {
	const { agent } = fixture();
	const shared = inputMessage();
	const ids: number[] = [];
	for (const queue of ["steer", "followUp", "steer"] as const) {
		agent[queue](shared, (id) => {
			expect(Number.isSafeInteger(id)).toBe(true);
			expect(agent.getQueuedMessageOccurrences()).toContainEqual({ id, message: shared, mode: queue });
			expect(agent.getQueuedMessages(queue).at(-1)).toBe(shared);
			ids.push(id);
		});
	}
	const expected = [
		{ id: ids[0], message: shared, mode: "steer" },
		{ id: ids[2], message: shared, mode: "steer" },
		{ id: ids[1], message: shared, mode: "followUp" },
	];
	expect(new Set(ids).size).toBe(3);
	expect(ids[1]).toBeGreaterThan(ids[0]);
	expect(ids[2]).toBeGreaterThan(ids[1]);
	expect(agent.getQueuedMessageOccurrences()).toEqual(expected);
	expect(agent.getQueuedMessages("steer")).toEqual([shared, shared]);
	expect(agent.getQueuedMessages("followUp")).toEqual([shared]);
	expect(agent.getQueuedMessages()).toEqual([shared, shared, shared]);

	const snapshot = agent.getQueuedMessageOccurrences();
	snapshot[0].id = -1;
	snapshot[0].message = { role: "user", content: "not the queued input", timestamp: 3 };
	snapshot[0].mode = "followUp";
	snapshot.pop();
	agent.getQueuedMessages("steer").pop();
	expect(agent.getQueuedMessageOccurrences()).toEqual(expected);
	expect(agent.getQueuedMessages("steer")).toEqual([shared, shared]);
	expect(shared).toEqual(inputMessage());

	agent.removeQueuedMessages((_message, id) => id === ids[2]);
	expect(agent.getQueuedMessageOccurrences()).toEqual([expected[0], expected[2]]);
	// Existing one-argument predicates and no-argument callbacks remain valid callers.
	agent.removeQueuedMessages((message) => message === shared);
	agent.followUp(shared, () => {});
	const nextId = agent.getQueuedMessageOccurrences()[0].id;
	expect(nextId).toBeGreaterThan(ids[2]);
	agent.reset();
	agent.steer(shared);
	expect(agent.getQueuedMessageOccurrences()[0].id).toBeGreaterThan(nextId);
	expect(agent.queuedMessageOccurrenceId).toBeUndefined();
});

describe.each(["steer", "followUp"] as const)("%s enqueue occurrence publication", (queue) => {
	// pi#262 / smarty-dev#3155: a Session attaching after enqueue can recover the same stable IDs.
	it.each(["all", "one-at-a-time"] as const)(
		"publishes pre-attachment repeated references with stable IDs in %s mode",
		async (mode) => {
			const { agent, requests } = fixture();
			agent.steeringMode = mode;
			agent.followUpMode = mode;
			const shared = inputMessage();
			agent[queue](shared);
			agent[queue](shared);
			const beforeAttachment = agent.getQueuedMessageOccurrences();
			const ids = beforeAttachment.map((entry) => entry.id);
			expect(new Set(ids).size).toBe(2);
			const publications: Array<{ type: string; id: number | undefined }> = [];
			let committed = 0;
			agent.subscribe(async (event) => {
				if (event.type !== "message_start" && event.type !== "message_end") return;
				if (event.message !== shared) {
					expect(agent.queuedMessageOccurrenceId).toBeUndefined();
					return;
				}
				const id = ids[committed];
				expect(agent.queuedMessageOccurrenceId).toBe(id);
				if (event.type === "message_end") committed++;
				expect(agent.getQueuedMessageOccurrences().map((entry) => entry.id)).toEqual(ids.slice(committed));
				expect(agent.state.messages.filter((message) => message === shared)).toHaveLength(committed);
				await Promise.resolve();
				expect(agent.queuedMessageOccurrenceId).toBe(id);
				publications.push({ type: event.type, id: agent.queuedMessageOccurrenceId });
			});
			// Later awaited subscribers still see the publication ID, including after the queue commit.
			agent.subscribe(async (event) => {
				if ((event.type === "message_start" || event.type === "message_end") && event.message === shared) {
					const id = publications.at(-1)?.id;
					await Promise.resolve();
					expect(agent.queuedMessageOccurrenceId).toBe(id);
				}
			});

			await agent.continue();

			expect(agent.state.errorMessage).toBeUndefined();
			expect(publications).toEqual(
				ids.flatMap((id) => [
					{ type: "message_start", id },
					{ type: "message_end", id },
				]),
			);
			expect(requests).toHaveLength(mode === "all" ? 1 : 2);
			expect(agent.state.messages.filter((message) => message === shared)).toHaveLength(2);
			expect(agent.getQueuedMessageOccurrences()).toEqual([]);
			expect(beforeAttachment.map((entry) => entry.id)).toEqual(ids);
			expect(shared).toEqual(inputMessage());
			expect(agent.queuedMessageOccurrenceId).toBeUndefined();
		},
	);

	// pi#262 / smarty-dev#3155: remove exactly one aliased entry without retargeting another reservation.
	it.each(["all", "one-at-a-time"] as const)("removes a selected alias by exact ID in %s mode", async (mode) => {
		const { agent, requests } = fixture();
		agent.steeringMode = mode;
		agent.followUpMode = mode;
		const head: AgentMessage = { role: "user", content: "before aliases", timestamp: 3 };
		const shared = inputMessage();
		const ids: number[] = [];
		for (const message of [head, shared, shared]) agent[queue](message, (id) => ids.push(id));
		const delivered: Array<number | undefined> = [];
		agent.subscribe((event) => {
			if (event.type !== "message_end") return;
			if (event.message === head) {
				agent.removeQueuedMessages((message, id) => message === shared && id === ids[1]);
				expect(agent.getQueuedMessageOccurrences()).toEqual([{ id: ids[2], message: shared, mode: queue }]);
			} else if (event.message === shared) delivered.push(agent.queuedMessageOccurrenceId);
		});

		await agent.continue();

		expect(agent.state.errorMessage).toBeUndefined();
		expect(delivered).toEqual([ids[2]]);
		expect(agent.state.messages.filter((message) => message === head || message === shared)).toEqual([head, shared]);
		expect(requests).toHaveLength(mode === "all" ? 1 : 2);
		expect(agent.getQueuedMessageOccurrences()).toEqual([]);
	});

	// pi#262 / smarty-dev#3155: withdrawal during start must invalidate that slot, not the equal tail.
	it("withdraws the current aliased start by ID without consuming its sibling", async () => {
		const { agent, requests } = fixture();
		agent.steeringMode = "all";
		agent.followUpMode = "all";
		const shared = inputMessage();
		const ids: number[] = [];
		agent[queue](shared, (id) => ids.push(id));
		agent[queue](shared, (id) => ids.push(id));
		const starts: Array<number | undefined> = [];
		const ends: Array<number | undefined> = [];
		agent.subscribe(async (event) => {
			if ((event.type !== "message_start" && event.type !== "message_end") || event.message !== shared) return;
			const id = agent.queuedMessageOccurrenceId;
			if (event.type === "message_start") {
				starts.push(id);
				if (id === ids[0]) {
					agent.removeQueuedMessages((_message, occurrenceId) => occurrenceId === id);
					await Promise.resolve();
					expect(agent.getQueuedMessageOccurrences()).toEqual([{ id: ids[1], message: shared, mode: queue }]);
				}
			} else ends.push(id);
		});

		await agent.continue();

		expect(agent.state.errorMessage).toBeUndefined();
		expect(starts).toEqual(ids);
		expect(ends).toEqual([ids[1]]);
		expect(agent.state.messages.filter((message) => message === shared)).toHaveLength(1);
		expect(requests).toHaveLength(1);
		expect(agent.getQueuedMessageOccurrences()).toEqual([]);
	});

	// pi#262 / smarty-dev#3155: prepared aliases before AND after a queued commit never inherit its ID.
	it.each(["all", "one-at-a-time"] as const)("keeps prepared publications unqueued in %s mode", async (mode) => {
		const { agent, requests } = fixture();
		agent.steeringMode = mode;
		agent.followUpMode = mode;
		const shared = inputMessage();
		let queuedId: number | undefined;
		agent.finishTurn = () => {
			if (requests.length === 1)
				agent[queue](shared, (id) => {
					queuedId = id;
				});
			if (requests.length === 2) return { action: "continue" };
			return undefined;
		};
		agent.prepareNextTurn = () => ({ messages: [shared] });
		const starts: Array<number | undefined> = [];
		const ends: Array<number | undefined> = [];
		agent.subscribe(async (event) => {
			if ((event.type !== "message_start" && event.type !== "message_end") || event.message !== shared) return;
			const publications = event.type === "message_start" ? starts : ends;
			const expectedId = publications.length === 1 ? queuedId : undefined;
			expect(agent.queuedMessageOccurrenceId).toBe(expectedId);
			await Promise.resolve();
			expect(agent.queuedMessageOccurrenceId).toBe(expectedId);
			publications.push(agent.queuedMessageOccurrenceId);
			if (ends.length === 1)
				expect(agent.getQueuedMessageOccurrences()).toEqual([{ id: queuedId, message: shared, mode: queue }]);
		});

		await agent.prompt("start");

		expect(queuedId).toBeTypeOf("number");
		expect(agent.state.errorMessage).toBeUndefined();
		expect(starts).toEqual([undefined, queuedId, undefined]);
		expect(ends).toEqual(starts);
		expect(agent.state.messages.filter((message) => message === shared)).toHaveLength(3);
		expect(requests).toHaveLength(3);
		expect(agent.getQueuedMessageOccurrences()).toEqual([]);
		expect(agent.queuedMessageOccurrenceId).toBeUndefined();
	});

	// pi#262 / smarty-dev#3155: normalization copies a message, not its original reserved occurrence.
	it("identifies a normalized queued copy without identifying its prepared source alias", async () => {
		const { agent, requests } = fixture();
		const shared: SystemMessage = {
			role: "system",
			content: "prepared and normalized queued instructions",
			toolsRemoved: [{ name: "not-installed" }],
			timestamp: 2,
		};
		let queuedId: number | undefined;
		agent.finishTurn = () => {
			if (requests.length === 1)
				agent[queue](shared, (id) => {
					queuedId = id;
				});
		};
		agent.prepareNextTurn = () => ({ messages: [shared] });
		const publications: Array<{ type: string; id: number | undefined; copied: boolean }> = [];
		agent.subscribe((event) => {
			if ((event.type !== "message_start" && event.type !== "message_end") || event.message.role !== "system")
				return;
			if (event.message.content !== shared.content) return;
			const copied = event.message !== shared;
			expect(agent.queuedMessageOccurrenceId).toBe(copied ? queuedId : undefined);
			publications.push({ type: event.type, id: agent.queuedMessageOccurrenceId, copied });
		});

		await agent.prompt("start");

		expect(queuedId).toBeTypeOf("number");
		expect(agent.state.errorMessage).toBeUndefined();
		expect(publications).toEqual([
			{ type: "message_start", id: undefined, copied: false },
			{ type: "message_end", id: undefined, copied: false },
			{ type: "message_start", id: queuedId, copied: true },
			{ type: "message_end", id: queuedId, copied: true },
		]);
		expect(shared.toolsRemoved).toEqual([{ name: "not-installed" }]);
		expect(requests).toHaveLength(2);
		expect(agent.getQueuedMessageOccurrences()).toEqual([]);
	});

	// pi#262 / smarty-dev#3155: start failure retains custody; end failure cannot undo a committed occurrence.
	it.each(
		(["all", "one-at-a-time"] as const).flatMap((mode) =>
			(["message_start", "message_end"] as const).map((phase) => ({ mode, phase })),
		),
	)("keeps publication identity through awaited $phase failure in $mode mode", async ({ mode, phase }) => {
		const { agent, requests } = fixture();
		agent.steeringMode = mode;
		agent.followUpMode = mode;
		const shared = inputMessage();
		const ids: number[] = [];
		agent[queue](shared, (id) => ids.push(id));
		agent[queue](shared, (id) => ids.push(id));
		const persisted: Array<number | undefined> = [];
		// Model the awaited Session handler: its persistence boundary is after asynchronous dispatch.
		agent.subscribe(async (event) => {
			const id = agent.queuedMessageOccurrenceId;
			await Promise.resolve();
			expect(agent.queuedMessageOccurrenceId).toBe(id);
			if ((event.type !== "message_start" && event.type !== "message_end") || event.message !== shared) {
				expect(id).toBeUndefined();
				return;
			}
			expect(ids).toContain(id);
			if (event.type === "message_end") persisted.push(id);
		});
		let failed = false;
		agent.subscribe(async (event) => {
			if (event.type !== "message_start" && event.type !== "message_end") return;
			if (failed || event.type !== phase || event.message !== shared) return;
			failed = true;
			expect(agent.queuedMessageOccurrenceId).toBe(ids[0]);
			expect(agent.state.messages.filter((message) => message === shared)).toHaveLength(
				phase === "message_end" ? 1 : 0,
			);
			expect(agent.getQueuedMessageOccurrences().map((entry) => entry.id)).toEqual(
				phase === "message_end" ? ids.slice(1) : ids,
			);
			await Promise.resolve();
			expect(agent.queuedMessageOccurrenceId).toBe(ids[0]);
			throw new Error(`queued ${phase} failed`);
		});

		await agent.continue();

		expect(failed).toBe(true);
		expect(agent.state.errorMessage).toBe(`queued ${phase} failed`);
		expect(requests).toHaveLength(0);
		expect(persisted).toEqual(phase === "message_end" ? [ids[0]] : []);
		expect(agent.getQueuedMessageOccurrences().map((entry) => entry.id)).toEqual(
			phase === "message_end" ? ids.slice(1) : ids,
		);
		expect(agent.queuedMessageOccurrenceId).toBeUndefined();

		await agent.continue({ fromQueuedMessages: true });

		expect(agent.state.errorMessage).toBeUndefined();
		expect(persisted).toEqual(ids);
		expect(new Set(persisted).size).toBe(2);
		expect(agent.state.messages.filter((message) => message === shared)).toHaveLength(2);
		expect(requests).toHaveLength(mode === "one-at-a-time" && phase === "message_start" ? 2 : 1);
		expect(agent.getQueuedMessageOccurrences()).toEqual([]);
		expect(shared).toEqual(inputMessage());
		expect(agent.queuedMessageOccurrenceId).toBeUndefined();
	});
});

// pi#262 / smarty-dev#3155: shared references in different queues still have independent enqueue identities.
it("publishes distinct IDs for a shared reference queued in both modes", async () => {
	const { agent, requests } = fixture();
	const shared = inputMessage();
	const ids: number[] = [];
	agent.steer(shared, (id) => ids.push(id));
	agent.followUp(shared, (id) => ids.push(id));
	const delivered: Array<number | undefined> = [];
	agent.subscribe((event) => {
		if (event.type === "message_end" && event.message === shared) delivered.push(agent.queuedMessageOccurrenceId);
	});

	await agent.continue();

	expect(agent.state.errorMessage).toBeUndefined();
	expect(new Set(ids).size).toBe(2);
	expect(delivered).toEqual(ids);
	expect(agent.state.messages.filter((message) => message === shared)).toHaveLength(2);
	expect(requests).toHaveLength(2);
	expect(agent.getQueuedMessageOccurrences()).toEqual([]);
	expect(agent.queuedMessageOccurrenceId).toBeUndefined();
});
