import { runToolCall } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, wrapRegisteredTool } from "../src/index.ts";

class StatefulTool {
	name = "native";
	label = "Native";
	description = "Synthetic class-backed tool";
	parameters = Type.Object({ value: Type.Number() });
	#value = 7;
	prepareArguments() {
		return { value: this.#value };
	}
	async execute(_id: string, args: unknown) {
		if (typeof args !== "object" || args === null || !("value" in args) || typeof args.value !== "number")
			throw new Error("Invalid synthetic arguments");
		return { content: [], details: { value: args.value + this.#value } };
	}
}
// pi#141 / Astra: adapters must preserve the original class/private preparation receiver in both directions.
it.each(["definition", "inverse", "public registered"])(
	"binds class-backed prepareArguments through %s",
	async (kind) => {
		const source = new StatefulTool();
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const runner = new ExtensionRunner(
			[],
			createExtensionRuntime(),
			process.cwd(),
			SessionManager.inMemory(),
			new ModelRegistry(runtime),
		);
		const tool =
			kind === "definition"
				? wrapToolDefinition(source)
				: kind === "inverse"
					? wrapToolDefinition(createToolDefinitionFromAgentTool(source))
					: wrapRegisteredTool(
							{
								definition: source,
								sourceInfo: {
									path: "<inline:r141>",
									source: "inline",
									scope: "temporary",
									origin: "top-level",
								},
							},
							runner,
						);
		const call = { type: "toolCall" as const, id: "synthetic-call", name: "native", arguments: {} };
		const outcome = await runToolCall(call, {
			tools: [tool],
			context: { messages: [], tools: [tool] },
			assistantMessage: fauxAssistantMessage([call], { stopReason: "toolUse" }),
		});
		expect(outcome.isError).toBe(false);
		expect(outcome.result.details).toEqual({ value: 14 });
	},
);
