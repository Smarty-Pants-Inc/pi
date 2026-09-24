import {
	type ClassifierModel,
	createProvider,
	type ImageModel,
	InMemoryModelsStore,
	type Model,
	type ModelsStore,
	type Provider,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { OrdinaryOwnerContext } from "../src/core/ordinary-owner-context.ts";
import { RuntimeCredentials } from "../src/core/runtime-credentials.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function chatModel(id: string): Model<"test-chat"> {
	return {
		id,
		name: id,
		api: "test-chat",
		provider: "mixed",
		baseUrl: "https://chat.test/v1",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 1000,
		maxTokens: 100,
	};
}

const imageModel: ImageModel<"test-images"> = {
	type: "image",
	id: "image",
	name: "image",
	api: "test-images",
	provider: "mixed",
	baseUrl: "https://images.test/v1",
	input: ["text"],
	output: ["image"],
	cost,
};

const classifierModel: ClassifierModel<"test-classifier"> = {
	type: "classifier",
	id: "classifier",
	name: "classifier",
	api: "test-classifier",
	provider: "mixed",
	baseUrl: "https://classifier.test/v1",
	input: ["text"],
	cost,
	contextWindow: 1000,
};

type RuntimeConstructor = new (
	credentials: RuntimeCredentials,
	config: ModelConfig,
	modelsPath: string | undefined,
	modelsStore: ModelsStore,
	providers: readonly Provider[],
	modelNetworkEnabled: boolean,
	ordinaryOwner?: OrdinaryOwnerContext,
) => ModelRuntime;

describe("ModelRuntime ordinary owner availability", () => {
	it("typed availability APIs return only the owner's allowed chat model", async () => {
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Mixed key", resolve: async () => ({ auth: {} }) } },
			models: [chatModel("allowed"), chatModel("other"), imageModel, classifierModel],
			images: { "test-images": { generateImages: async () => Promise.reject(new Error("unused")) } },
			classifiers: { "test-classifier": { classify: async () => Promise.reject(new Error("unused")) } },
		});
		let bindingChecks = 0;
		// ponytail: a real owner needs the full receiving handshake; these APIs read only the binding check and decision.
		const owner = {
			assertCredentialBinding: () => {
				bindingChecks++;
			},
			decision: { record: { provider: { provider: "mixed", model: "allowed", api: "test-chat" } } },
		} as unknown as OrdinaryOwnerContext;
		const runtime = new (ModelRuntime as unknown as RuntimeConstructor)(
			new RuntimeCredentials(AuthStorage.inMemory()),
			await ModelConfig.load(undefined),
			undefined,
			new InMemoryModelsStore(),
			[provider],
			false,
			owner,
		);

		expect(runtime.getAllModels("mixed")).toHaveLength(4);
		expect((await runtime.getAvailableOfType("chat")).map((model) => model.id)).toEqual(["allowed"]);
		expect((await runtime.getAvailableOfType("chat", "mixed")).map((model) => model.id)).toEqual(["allowed"]);
		expect((await runtime.getAllAvailable()).map((model) => model.id)).toEqual(["allowed"]);
		expect(await runtime.getAvailableOfType("image")).toEqual([]);
		expect(await runtime.getAvailableOfType("classifier", "mixed")).toEqual([]);
		expect(bindingChecks).toBe(5);
	});
});
