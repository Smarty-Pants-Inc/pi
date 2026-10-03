import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createCodemodeExtension } from "../../../src/extensions/codemode/index.ts";
import { createHarness, getToolResult } from "../harness.ts";

// pi#127 A12: public hook -> nested schema-bearing tool -> actual QuickJS guest.
it.each([false, true])("preserves explicit null redaction (replace text: %s)", async (replaceText) => {
	const harness = await createHarness({
		initialActiveToolNames: ["codemode"],
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool({
					name: "private_stats",
					label: "private",
					description: "private stats",
					parameters: Type.Object({}),
					outputSchema: Type.Object({ secret: Type.String() }),
					execute: async () => ({
						content: [{ type: "text", text: "ordinary text" }],
						details: {},
						structuredContent: { secret: "FAKE_SECRET_127" },
					}),
				});
			},
		],
	});
	try {
		harness.session.agent.afterToolCall = async ({ toolCall }) =>
			toolCall.name === "private_stats"
				? {
						structuredContent: null,
						...(replaceText ? { content: [{ type: "text" as const, text: "redacted" }] } : {}),
					}
				: undefined;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: "return await tools.private_stats({});" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("test null redaction");
		const result = getToolResult(harness, "codemode");
		expect(result.isError).toBe(false);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("null");
		expect(text).not.toContain("FAKE_SECRET_127");
	} finally {
		harness.cleanup();
	}
});
