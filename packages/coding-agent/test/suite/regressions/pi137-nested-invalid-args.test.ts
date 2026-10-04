import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createHarness, getToolResult } from "../harness.ts";

// pi#137 / smarty-dev#3535, A18: public ctx.executeTool(), schema validation and persisted record.
const cases: ReadonlyArray<readonly [string, () => unknown, boolean]> = [
	[
		"cycle",
		() => {
			const value: Record<string, unknown> = {};
			value.self = value;
			return value;
		},
		true,
	],
	["root BigInt", () => 1n, true],
	// Keep upstream schema coercion: a BigInt field can become valid text after recording.
	["BigInt normalized to text", () => ({ text: 1n }), false],
	["function", () => () => {}, true],
	["undefined toJSON", () => ({ text: 1, toJSON: () => undefined }), true],
	[
		"throwing toJSON",
		() => ({
			text: 1,
			toJSON: () => {
				throw new Error("invalid JSON");
			},
		}),
		true,
	],
];

it.each(cases)(
	"settles nested unrecordable %s arguments through the tool pipeline without aborting the orchestrator",
	async (_name, makeArgs, expectedError) => {
		let executed = false;
		let nestedIsError: boolean | undefined;
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "echo",
						label: "echo",
						description: "Echo text",
						parameters: Type.Object({ text: Type.String() }),
						execute: async () => {
							executed = true;
							return { content: [], details: {} };
						},
					});
					pi.registerTool({
						name: "orchestrate",
						label: "orchestrate",
						description: "Calls echo",
						parameters: Type.Object({}),
						execute: async (_id, _params, _signal, _onUpdate, ctx) => {
							const outcome = await ctx.executeTool("echo", makeArgs());
							nestedIsError = outcome.isError;
							return { content: [{ type: "text", text: "orchestrator continued" }], details: {} };
						},
					});
				},
			],
		});
		try {
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("orchestrate", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			expect(nestedIsError).toBe(expectedError);
			expect(executed).toBe(!expectedError);
			const result = getToolResult(harness, "orchestrate");
			expect(result.isError).toBe(false);
			expect(result.content).toEqual([{ type: "text", text: "orchestrator continued" }]);
			expect(result.nestedCalls?.complete).toBe(false);
			expect(result.nestedCalls?.calls[0]).toMatchObject({ name: "echo", status: expectedError ? "error" : "ok" });
			expect(result.nestedCalls?.calls[0].arguments).toBeUndefined();
			expect(() => JSON.stringify(result)).not.toThrow();
		} finally {
			harness.cleanup();
		}
	},
);
