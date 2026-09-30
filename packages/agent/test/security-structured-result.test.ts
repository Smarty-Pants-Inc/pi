import { fauxAssistantMessage, fauxToolCall, type JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runToolCall } from "../src/agent-loop.ts";
import type { AfterToolCallResult, AgentTool } from "../src/types.ts";

const original = { secret: "private" };
const tool: AgentTool = {
	name: "structured",
	label: "Structured",
	description: "Return structured data",
	parameters: Type.Object({}),
	outputSchema: Type.Union([Type.Null(), Type.Object({ secret: Type.String() })]),
	execute: async () => ({
		content: [{ type: "text", text: "original text" }],
		details: {},
		structuredContent: original,
	}),
};

async function call(override: AfterToolCallResult) {
	const toolCall = fauxToolCall("structured", {}, { id: "call" });
	return runToolCall(toolCall, {
		tools: [tool],
		assistantMessage: fauxAssistantMessage(toolCall, { stopReason: "toolUse" }),
		context: { messages: [], tools: [tool] },
		afterToolCall: async () => override,
	});
}

describe("programmatic structured-result overrides", () => {
	// smarty-dev#2241 A12: null is a supplied JSON value, with or without a text replacement.
	it.each([false, true])("retains explicit structured null (replace text: %s)", async (replaceText) => {
		const outcome = await call({
			structuredContent: null,
			...(replaceText ? { content: [{ type: "text" as const, text: "redacted" }] } : {}),
		});
		expect(outcome.isError).toBe(false);
		expect(Object.hasOwn(outcome.result, "structuredContent")).toBe(true);
		expect(outcome.result.structuredContent).toBeNull();
		expect(outcome.result.content).toEqual([{ type: "text", text: replaceText ? "redacted" : "original text" }]);
		expect(original).toEqual({ secret: "private" });
	});

	// smarty-dev#2241 A12: only undefined falls back; a content override still invalidates old structure.
	it.each([false, true])("keeps undefined-only omission semantics (replace text: %s)", async (replaceText) => {
		const outcome = await call({ structuredContent: undefined, ...(replaceText ? { content: [] } : {}) });
		if (replaceText) {
			expect(Object.hasOwn(outcome.result, "structuredContent")).toBe(false);
			expect(outcome.result.content).toEqual([]);
		} else {
			expect(outcome.result.structuredContent).toEqual(original);
		}
	});

	// smarty-dev#2241 A12: false, zero and empty strings remain explicit structured overrides too.
	it.each([false, 0, "", { public: true }, []].map((value) => ({ value: value as JsonValue })))(
		"retains explicit JSON value $value",
		async ({ value }) => {
			expect((await call({ structuredContent: value, content: [] })).result.structuredContent).toEqual(value);
		},
	);

	// smarty-dev#2241 N1: programmatic/Codemode callers resolve against the callable set, not native declarations.
	it("names callable tools in unknown-tool hints with no native tools", async () => {
		const toolCall = fauxToolCall("missing", {}, { id: "call" });
		const outcome = await runToolCall(toolCall, {
			tools: [tool],
			assistantMessage: fauxAssistantMessage(toolCall, { stopReason: "toolUse" }),
			context: { messages: [], tools: [] },
		});
		expect(outcome.isError).toBe(true);
		expect(outcome.result.content).toEqual([
			{ type: "text", text: "Tool missing not found. Available tools in this session: structured" },
		]);
	});
});
