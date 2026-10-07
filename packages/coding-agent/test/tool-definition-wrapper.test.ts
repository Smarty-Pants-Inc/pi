import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { wrapRegisteredTool } from "../src/core/extensions/wrapper.ts";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

class StatefulTool implements ToolDefinition {
	name = "stateful";
	label = "Stateful";
	description = "Preparation uses private instance state";
	parameters = Type.Object({ value: Type.String() });
	#prefix = "prepared:";
	prepareArguments(args: unknown) {
		return { value: this.#prefix + String(args) };
	}
	async execute() {
		return { content: [], details: {} };
	}
}

describe("tool preparation receivers", () => {
	it("preserves class private state through exported wrapRegisteredTool", () => {
		const definition = new StatefulTool();
		const runner = { createToolContext: () => ({}) } as unknown as ExtensionRunner;
		const wrapped = wrapRegisteredTool(
			{
				definition,
				sourceInfo: { path: "<inline:stateful>", source: "inline", scope: "temporary", origin: "top-level" },
			},
			runner,
		);
		expect(wrapped.prepareArguments!("input")).toEqual({ value: "prepared:input" });
	});

	it("preserves class private state at the AgentTool conversion boundary and round trip", () => {
		const original: AgentTool = new StatefulTool();
		const definition = createToolDefinitionFromAgentTool(original);
		expect(definition.prepareArguments!("input")).toEqual({ value: "prepared:input" });
		expect(wrapToolDefinition(definition).prepareArguments!("again")).toEqual({ value: "prepared:again" });
	});

	it("leaves optional preparation absent", () => {
		const original: AgentTool = {
			name: "plain",
			label: "Plain",
			description: "Plain",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		};
		expect(createToolDefinitionFromAgentTool(original).prepareArguments).toBeUndefined();
		expect(wrapToolDefinition(createToolDefinitionFromAgentTool(original)).prepareArguments).toBeUndefined();
	});
});
