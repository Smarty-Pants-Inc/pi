import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { runAgentLoop, runToolCall } from "../src/agent-loop.ts";
import type { AgentEvent, AgentTool, AgentToolCall, StreamFn } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "fake",
	name: "fake",
	api: "openai-responses",
	provider: "fake",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 100,
};
function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
const call: AgentToolCall = { type: "toolCall", id: "a", name: "secret", arguments: {} };
const result = { content: [{ type: "text" as const, text: "safe" }], details: { credential: "fake-secret" } };
function stream(messages: AssistantMessage[]): StreamFn {
	return () => {
		const message = messages.shift()!;
		const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("not terminal");
			},
		);
		events.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
		return events;
	};
}
const tool: AgentTool = {
	name: "secret",
	label: "secret",
	description: "secret",
	parameters: Type.Object({}),
	execute: async () => result,
};

// PR #131 F01: explicit null is a replacement, not an omitted redaction.
it("redacts details:null in the shared public finalizer", async () => {
	const outcome = await runToolCall(call, {
		assistantMessage: assistant([call], "toolUse"),
		tools: [tool],
		context: { messages: [], tools: [tool] },
		afterToolCall: async () => ({ details: null }),
	});
	expect(outcome.result.details).toBeNull();
});
// PR #131 F01: wire-shaped end events and transcript use the same redacted value.
it("redacts direct end events and tool-result messages", async () => {
	const events: AgentEvent[] = [];
	const messages = await runAgentLoop(
		[{ role: "user", content: "go", timestamp: 1 }],
		{ messages: [], tools: [tool] },
		{
			model,
			convertToLlm: (messages) =>
				messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
			afterToolCall: async () => ({ details: null }),
		},
		(event) => {
			events.push(event);
		},
		undefined,
		stream([assistant([call], "toolUse"), assistant([])]),
	);
	expect(events.find((e) => e.type === "tool_execution_end")).toMatchObject({ result: { details: null } });
	expect(messages.find((m) => m.role === "toolResult")).toMatchObject({ details: null });
	expect(JSON.stringify(events)).not.toContain("fake-secret");
});

class ClassTool implements AgentTool {
	name = "secret";
	label = "class";
	description = "class";
	parameters = Type.Object({ value: Type.Number() });
	#value = 7;
	get executionMode(): "sequential" {
		return "sequential";
	}
	prepareArguments(): { value: number } {
		return { value: this.#value };
	}
	async execute(_id: string, args: unknown) {
		return { content: [], details: (args as { value: number }).value + this.#value };
	}
}
// PR #131 F12: prototype methods and private preparation/execution receivers survive pinning.
it("keeps structural class execution and preparation receivers", async () => {
	const outcome = await runToolCall(call, {
		assistantMessage: assistant([call]),
		tools: [new ClassTool()],
		context: { messages: [], tools: [] },
	});
	expect(outcome).toMatchObject({ isError: false, result: { details: 14 } });
});
// PR #131 F12: authorization of a pinned callable must not switch after an await.
it("does not replace the authorized callable across an awaited hook", async () => {
	const original = { ...tool, execute: async () => ({ content: [], details: "original" }) };
	const outcome = await runToolCall(call, {
		assistantMessage: assistant([call]),
		tools: [original],
		context: { messages: [], tools: [original] },
		beforeToolCall: async () => {
			original.execute = async () => ({ content: [], details: "mutated" });
			await Promise.resolve();
			return undefined;
		},
	});
	expect(outcome.result.details).toBe("original");
});
// PR #131 F12: prototype exclusivity is part of the captured admission contract.
it("preserves prototype sequential classification in a parallel batch", async () => {
	let active = 0;
	let maximum = 0;
	class ExclusiveTool implements AgentTool {
		name = "secret";
		label = "exclusive";
		description = "exclusive";
		parameters = Type.Object({});
		get executionMode(): "sequential" {
			return "sequential";
		}
		execute = async () => {
			active++;
			maximum = Math.max(maximum, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return { content: [], details: 0 };
		};
	}
	await runAgentLoop(
		[{ role: "user", content: "go", timestamp: 1 }],
		{ messages: [], tools: [new ExclusiveTool()] },
		{
			model,
			toolExecution: "parallel",
			convertToLlm: (messages) =>
				messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
		},
		() => {},
		undefined,
		stream([assistant([call, { ...call, id: "b" }], "toolUse"), assistant([])]),
	);
	expect(maximum).toBe(1);
});
// PR #131 F09: physical next-turn preparation must not start after cancellation.
it("does not prepare a cancelled physical tool turn", async () => {
	const controller = new AbortController();
	let preparations = 0;
	await runAgentLoop(
		[{ role: "user", content: "go", timestamp: 1 }],
		{ messages: [], tools: [tool] },
		{
			model,
			convertToLlm: (messages) =>
				messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
			prepareNextTurn: async () => {
				preparations++;
				return undefined;
			},
		},
		(event) => {
			if (event.type === "turn_end") controller.abort();
		},
		controller.signal,
		stream([assistant([call], "toolUse"), assistant([], "aborted")]),
	);
	expect(preparations).toBe(0);
});
