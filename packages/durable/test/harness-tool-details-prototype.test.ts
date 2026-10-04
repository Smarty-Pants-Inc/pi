import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import { defineTool, MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";

// PR #131 P1-9 / F3-F15: the active tool-progress transaction must not mutate inherited containers.
it("preserves own reserved tool details across committed updates without process-prototype mutation", async () => {
	const marker = "pi131ToolDetailsPrototype";
	const details = JSON.parse(
		`{"stage":2,"__proto__":{"${marker}":true},"constructor":{"prototype":{"${marker}":true}}}`,
	);
	const setup = chatSetup();
	addTool(
		setup.registry,
		defineTool({
			name: "progress",
			description: "Progress",
			parameters: Type.Object({}),
			execute: async (_args, api) => {
				await api.details({ stage: 1 }, context);
				await api.details(details, context);
				return { content: [] };
			},
		}),
	);
	setup.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("progress", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	try {
		const submission = await root.submit({ type: "input", content: "go" }, context);
		expect(await submission.wait(context)).toMatchObject({ status: "done" });
		expect(Object.hasOwn(Object.prototype, marker)).toBe(false);
		const entries = await allEntries(root);
		const entry = entries.find((candidate) => ToolResultEntry.is(candidate));
		const result = entry?.model?.[0] as ToolResultMessage | undefined;
		expect(result?.isError).toBe(false);
		expect(result?.details).toEqual(details);
		if (typeof result?.details !== "object" || result.details === null) throw new Error("Missing details object");
		expect(Object.hasOwn(result.details, "__proto__")).toBe(true);
	} finally {
		Reflect.deleteProperty(Object.prototype, marker);
		await harness.close(context);
	}
});
