import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { runAgentLoop, runToolCall } from "../src/agent-loop.ts";
import type { AgentTool, AgentToolCall } from "../src/types.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const result = { content: [], details: {} };

// PR #131 P2-3: observer rejection cannot let accepted sibling work escape settlement.
it("observes rejected updates immediately and drains every accepted update", async () => {
	const toolDone = deferred();
	const updateDone = deferred();
	const updatesIssued = deferred();
	const tool: AgentTool = {
		name: "updates",
		label: "updates",
		description: "updates",
		parameters: Type.Object({}),
		async execute(_id, _args, _signal, update) {
			update?.(result);
			update?.(result);
			updatesIssued.resolve();
			await toolDone.promise;
			return result;
		},
	};
	const call: AgentToolCall = { type: "toolCall", id: "u", name: "updates", arguments: {} };
	let index = 0;
	let settled = false;
	const operation = runToolCall(call, {
		tools: [tool],
		context: { messages: [], tools: [tool] },
		assistantMessage: fauxAssistantMessage([call], { stopReason: "toolUse" }),
		onUpdate: () => (++index === 1 ? Promise.reject(new Error("first update failed")) : updateDone.promise),
	}).finally(() => {
		settled = true;
	});
	await updatesIssued.promise;
	// Exercise a real event-loop turn while the executing tool has not returned.
	await new Promise((resolve) => setTimeout(resolve, 10));
	toolDone.resolve();
	await new Promise((resolve) => setTimeout(resolve, 10));
	const earlySettlement = settled;
	updateDone.resolve();
	const outcome = await operation;
	expect(earlySettlement).toBe(false);
	expect(outcome).toMatchObject({
		isError: true,
		result: { content: [{ type: "text", text: "first update failed" }] },
	});
});

it("drains sibling calls before propagating an end observer failure", async () => {
	const slow = deferred();
	const entered = deferred();
	const firstEnded = deferred();
	const tools: AgentTool[] = ["fast", "slow"].map((name) => ({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		async execute() {
			if (name === "slow") {
				entered.resolve();
				await slow.promise;
			}
			return result;
		},
	}));
	const calls: AgentToolCall[] = tools.map((tool) => ({
		type: "toolCall",
		id: tool.name,
		name: tool.name,
		arguments: {},
	}));
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" })]);
	let settled = false;
	const operation = runAgentLoop(
		[],
		{ messages: [], tools },
		{
			model: faux.getModel(),
			convertToLlm: () => [],
			toolExecution: "parallel",
		},
		(event) => {
			if (event.type === "tool_execution_end" && event.toolCallId === "fast") {
				firstEnded.resolve();
				throw new Error("end observer failed");
			}
		},
		undefined,
		streamSimple,
	)
		.then(
			() => undefined,
			(error: unknown) => error,
		)
		.finally(() => {
			settled = true;
		});
	try {
		await Promise.all([entered.promise, firstEnded.promise]);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const earlySettlement = settled;
		slow.resolve();
		expect(await operation).toMatchObject({ message: "end observer failed" });
		expect(earlySettlement).toBe(false);
	} finally {
		slow.resolve();
		await operation;
		faux.unregister();
	}
});
