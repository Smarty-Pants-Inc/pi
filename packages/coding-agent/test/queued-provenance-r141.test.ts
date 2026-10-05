import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { repairModel, repairSession } from "./repair-r141-support.ts";

// PR #141 cut #5: provenance belongs to the live normalized event, not only its queued source.
it.each(
	(["user", "system"] as const).flatMap((role) => (["steer", "followUp"] as const).map((queue) => ({ role, queue }))),
)("maps queued $role $queue start/end aliases to the one accepted row", async ({ role, queue }) => {
	const agent = new Agent({
		initialState: { model: repairModel },
		streamFn: () => {
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") });
			return stream;
		},
	});
	const { session, manager, runtime } = await repairSession(agent);
	vi.spyOn(runtime, "getAuth").mockResolvedValue({ auth: { apiKey: "synthetic-auth" }, source: "runtime" });
	const source: AgentMessage =
		role === "system"
			? { role, content: "queued synthetic system", timestamp: 1, toolsRemoved: [{ name: "synthetic-unused" }] }
			: { role, content: "queued synthetic user", timestamp: 1 };
	const ids: string[] = [];
	let eventMessage: AgentMessage | undefined;
	let transferredId: string | undefined;
	const transfer = agent.transferQueuedMessage!;
	agent.transferQueuedMessage = async (...args) => {
		await transfer(...args);
		const row = manager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === role && entry.message.timestamp === 1);
		transferredId = row?.id;
	};
	session.startMessageEntryIdCapture();
	session.subscribe((event) => {
		if (
			(event.type === "message_start" || event.type === "message_end") &&
			event.message.role === role &&
			event.message.timestamp === 1
		) {
			eventMessage = event.message;
			const id = session.takeMessageEntryId(event.message);
			if (id) ids.push(id);
		}
	});
	agent[queue](source);
	await agent.prompt("trigger");
	await session.waitForIdle();
	const rows = manager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === role && entry.message.timestamp === 1);
	expect(rows).toHaveLength(1);
	expect(transferredId).toBe(rows[0].id);
	expect(ids).toEqual([rows[0].id]);
	if (role === "system") expect(eventMessage).not.toBe(source);
});
