import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message, type UserMessageOrigin } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const API: UserMessageOrigin = { kind: "herdr-api", sender: "lead", pane: "p1", session: "s1", id: "7" };

function persistedUserMessages(harness: Harness): Record<string, unknown>[] {
	const file = harness.sessionManager.getSessionFile();
	if (!file) throw new Error("session is not persisted");
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.type === "message" && entry.message.role === "user")
		.map((entry) => entry.message);
}

describe("user message input origin", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("persists origin on the user message and keeps it out of provider context", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const providerUsers: Message[] = [];
		harness.setResponses([
			(context) => {
				providerUsers.push(...context.messages.filter((message) => message.role === "user"));
				return fauxAssistantMessage("ok");
			},
			fauxAssistantMessage("ok"),
			fauxAssistantMessage("ok"),
		]);

		await harness.session.prompt("from herdr", { origin: API });
		await harness.session.prompt("typed", { origin: { kind: "keyboard" } });
		await harness.session.prompt("sdk");

		const persisted = persistedUserMessages(harness);
		expect(persisted.map((message) => message.origin)).toEqual([API, { kind: "keyboard" }, undefined]);
		expect("origin" in persisted[2]!).toBe(false);
		expect(providerUsers).toHaveLength(1);
		expect("origin" in providerUsers[0]!).toBe(false);
	});

	it("carries origin through steer and follow-up queues", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await gate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ persistSession: true, tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after steer"),
			fauxAssistantMessage("after follow-up"),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const run = harness.session.prompt("start", { origin: { kind: "keyboard" } });
		await toolStarted;
		await harness.session.prompt("steered", { streamingBehavior: "steer", origin: API });
		await harness.session.followUp("followed", undefined, { origin: { kind: "herdr-api", sender: "b" } });
		release?.();
		await run;

		expect(persistedUserMessages(harness).map((message) => [message.content, message.origin])).toEqual([
			[[{ type: "text", text: "start" }], { kind: "keyboard" }],
			[[{ type: "text", text: "steered" }], API],
			[[{ type: "text", text: "followed" }], { kind: "herdr-api", sender: "b" }],
		]);
	});
});
