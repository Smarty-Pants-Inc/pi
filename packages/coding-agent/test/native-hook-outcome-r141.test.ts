import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const model: Model<"openai-completions"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "openai-completions",
	provider: "audit",
	baseUrl: "https://mock.invalid",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};
const usage = {
	input: 7,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 9,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};
// pi#141 / P2-AUDIT-NATIVE: completed receipts and usage survive publication failures, including mutating hooks.
it.each(
	(["parallel", "sequential"] as const).flatMap((toolExecution) =>
		(["afterToolCall", "updateObserver", "asyncUpdateObserver", "mutatingAfterToolCall"] as const).map((failure) => ({
			toolExecution,
			failure,
		})),
	),
)("journals completed native outcome after $failure ($toolExecution)", async ({ toolExecution, failure }) => {
	let native = 0;
	let rejected = false;
	const tool: AgentTool = {
		name: "native",
		label: "Native",
		description: "Synthetic",
		parameters: Type.Object({}),
		execute: async (id, _args, _signal, update) => {
			native++;
			if (failure === "updateObserver" || failure === "asyncUpdateObserver") update?.({ content: [], details: {} });
			return {
				content: [{ type: "text", text: `accepted:${id}` }],
				details: { receipt: id },
				usage: structuredClone(usage),
			};
		},
	};
	const response = {
		...fauxAssistantMessage([{ type: "toolCall", id: "own-accepted", name: "native", arguments: {} }], {
			stopReason: "toolUse",
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
	const agent = new Agent({
		initialState: { model, tools: [tool] },
		toolExecution,
		streamFn: () => {
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "toolUse", message: structuredClone(response) });
			return stream;
		},
	});
	agent.finishTurn = async () => ({ action: "end" });
	if (failure === "afterToolCall" || failure === "mutatingAfterToolCall")
		agent.afterToolCall = async ({ result }) => {
			if (failure === "mutatingAfterToolCall") {
				result.content.length = 0;
				(result.details as { receipt: string }).receipt = "changed-by-rejected-hook";
				if (result.usage) {
					result.usage.input = 0;
					result.usage.cost.total = 0;
				}
			}
			rejected = true;
			throw new Error("synthetic post-native failure");
		};
	else
		agent.subscribe((event) => {
			if (event.type === "tool_execution_update") {
				rejected = true;
				if (failure === "asyncUpdateObserver") return Promise.reject(new Error("synthetic async update failure"));
				throw new Error("synthetic update failure");
			}
		});
	const directory = mkdtempSync(join(tmpdir(), "pi-r141-native-hook-"));
	const journal = SessionManager.create(directory, directory);
	agent.subscribe((event) => {
		if (
			event.type === "message_end" &&
			(event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult" ||
				event.message.role === "system")
		)
			journal.appendMessage(event.message);
	});
	await agent.prompt("synthetic request");
	expect(native).toBe(1);
	expect(rejected).toBe(true);
	const file = journal.getSessionFile();
	if (!file) throw new Error("Missing actual journal");
	const rows = readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map(
			(line) =>
				JSON.parse(line) as {
					message?: {
						role?: string;
						toolCallId?: string;
						details?: { receipt?: string };
						usage?: typeof usage;
						isError?: boolean;
					};
				},
		);
	const outcomes = rows.filter(
		(row) => row.message?.role === "toolResult" && row.message.toolCallId === "own-accepted",
	);
	expect(outcomes).toHaveLength(1);
	expect(outcomes[0]?.message).toMatchObject({
		content: [{ type: "text", text: "accepted:own-accepted" }],
		details: { receipt: "own-accepted" },
		usage,
		isError: false,
	});
	expect(agent.state.errorMessage).toBeTruthy();
});
