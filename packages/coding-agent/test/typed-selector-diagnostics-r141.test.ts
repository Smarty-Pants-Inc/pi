import {
	type ClassifierModel,
	createModels,
	type ImageModel,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

const selector = "SYNTHETIC_R141_SELECTOR_DIAGNOSTIC";
const chat: Model<"openai-completions"> = {
	id: selector,
	name: "Synthetic",
	provider: selector,
	api: "openai-completions",
	baseUrl: "https://mock.invalid",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};
// pi#141 / Astra: wrong-kind typed selectors use the same owned setup projection as chat guards.
it.each(
	(["AI Models", "ModelRuntime"] as const).flatMap((receiver) =>
		(["image", "classifier"] as const).map((kind) => ({ receiver, kind })),
	),
)("makes $receiver $kind wrong-kind diagnostics value-free", async ({ receiver, kind }) => {
	const models =
		receiver === "AI Models"
			? createModels()
			: await ModelRuntime.create({
					credentials: new InMemoryCredentialStore(),
					modelsPath: null,
					modelsStore: new InMemoryCodingAgentModelsStore(),
					allowModelNetwork: false,
					refreshOnCreate: false,
				});
	const output =
		kind === "image"
			? await models.generateImages(chat as unknown as ImageModel<"openrouter-images">, { input: [] })
			: await models.classify(chat as unknown as ClassifierModel<"llama-cpp-classify">, {
					state: {},
					questions: {},
				});
	expect(output.stopReason).toBe("error");
	expect(output.errorMessage).toBe(
		kind === "image" ? "Model is not an image model" : "Model is not a classifier model",
	);
	expect(output.errorMessage).not.toContain(selector);
});
