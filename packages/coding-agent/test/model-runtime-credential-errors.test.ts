// pi#150 redaction port of pi#131 round-4 R4-1 (direct ModelRuntime non-chat and cancellation errors)
// and R4-4 (copied filenames inserted raw into shell input).
import {
	type AssistantImages,
	type ClassifierModel,
	type ClassifierResult,
	createAssistantMessageEventStream,
	createProvider,
	type ImageModel,
	InMemoryModelsStore,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { isUnquotedShellPosition } from "../src/modes/interactive/interactive-mode.ts";

const KEY = "sk-live-PI150-RUNTIME-KEY-0123456789";
const HEADER = 'opaque"PI150\\RUNTIME-HEADER';
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const image: ImageModel<"pi150-images"> = {
	type: "image",
	id: "img",
	name: "img",
	api: "pi150-images",
	provider: "pi150",
	baseUrl: "https://pi150.invalid",
	input: ["text"],
	output: ["image"],
	cost,
};
const classifier: ClassifierModel<"pi150-classify"> = {
	type: "classifier",
	id: "cls",
	name: "cls",
	api: "pi150-classify",
	provider: "pi150",
	baseUrl: "https://pi150.invalid",
	input: ["text"],
	cost,
	contextWindow: 1000,
};
const chat: Model<"pi150-chat"> = {
	id: "chat",
	name: "chat",
	api: "pi150-chat",
	provider: "pi150",
	baseUrl: "https://pi150.invalid",
	reasoning: false,
	input: ["text"],
	cost,
	contextWindow: 1000,
	maxTokens: 100,
};
const imagesContext = { input: [{ type: "text" as const, text: "x" }] };
const classifierContext = {
	state: { text: "x" },
	questions: { q: { type: "bool" as const, instructions: "?", criteria: { true: "y", false: "n" } } },
};

function forms(secret: string): string[] {
	const json = JSON.stringify(secret).slice(1, -1);
	return [secret, json, encodeURIComponent(secret), encodeURIComponent(json)];
}

function expectNoCredential(value: unknown): void {
	const text = JSON.stringify(value);
	for (const secret of [KEY, HEADER]) for (const form of forms(secret)) expect(text).not.toContain(form);
}

type Echo = "reject" | "result";

async function runtimeFor(echo: Echo, calls: { count: number }): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const leak = (options: { apiKey?: string; headers?: unknown } | undefined) => {
		calls.count++;
		return `provider echoed ${options?.apiKey} ${JSON.stringify(options?.headers)}`;
	};
	runtime.registerNativeProvider(
		createProvider({
			id: "pi150",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: KEY } }) } },
			models: [chat, image, classifier],
			api: {
				// A custom provider stream with no protection of its own reflects the key in its error.
				stream: (model, _context, options) => {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						const error = {
							role: "assistant" as const,
							content: [],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { ...cost, total: 0 },
							},
							stopReason: "error" as const,
							errorMessage: leak(options),
							timestamp: 0,
						};
						stream.push({ type: "error", reason: "error", error });
					});
					return stream;
				},
				streamSimple: () => createAssistantMessageEventStream(),
				cancelDeferred: async (_model, _handle, options) => {
					throw new Error(leak(options));
				},
			},
			images: {
				"pi150-images": {
					generateImages: async (model, _context, options): Promise<AssistantImages> => {
						if (echo === "reject") throw new Error(leak(options));
						return {
							api: model.api,
							provider: model.provider,
							model: model.id,
							output: [],
							stopReason: "error",
							errorMessage: leak(options),
							timestamp: 0,
						};
					},
				},
			},
			classifiers: {
				"pi150-classify": {
					classify: async (model, _context, options): Promise<ClassifierResult> => {
						if (echo === "reject") throw new Error(leak(options));
						return {
							api: model.api,
							provider: model.provider,
							model: model.id,
							answers: {},
							stopReason: "error",
							errorMessage: leak(options),
							timestamp: 0,
						};
					},
				},
			},
		}),
	);
	return runtime;
}

const headers = { authorization: `Bearer ${HEADER}` };

describe("R4-1: direct ModelRuntime non-chat and cancellation errors", () => {
	it.each(["reject", "result"] as const)("masks a provider %s after preparation", async (echo) => {
		const calls = { count: 0 };
		const runtime = await runtimeFor(echo, calls);
		const images = await runtime.generateImages(image, imagesContext, { headers });
		const classified = await runtime.classify(classifier, classifierContext, { headers });
		expect(images.stopReason).toBe("error");
		expect(classified.stopReason).toBe("error");
		expect(images.errorMessage).toContain("provider echoed");
		expectNoCredential({ images, classified });
		expect(calls.count).toBe(2);
	});

	it("masks a custom provider's chat stream error", async () => {
		const calls = { count: 0 };
		const runtime = await runtimeFor("reject", calls);
		const result = await runtime.complete(chat, { messages: [] }, { headers });
		expect(result.errorMessage).toContain("provider echoed");
		expectNoCredential(result);
		expect(calls.count).toBe(1);
	});

	it("masks a cancellation rejection and drops its cause", async () => {
		const calls = { count: 0 };
		const runtime = await runtimeFor("reject", calls);
		const error = await runtime.cancelDeferred(chat, { id: "h" } as never, { headers }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).cause).toBeUndefined();
		expect((error as Error).message).toContain("provider echoed");
		expectNoCredential({ message: (error as Error).message, stack: (error as Error).stack });
		expect(calls.count).toBe(1);
	});

	it("reports auth/header-transform setup failures as value-free categories", async () => {
		const calls = { count: 0 };
		const runtime = await runtimeFor("reject", calls);
		const transformHeaders = (seen: Record<string, string | null>) => {
			throw new Error(`transform saw ${JSON.stringify(seen)} ${KEY}`);
		};
		const options = { headers, transformHeaders };
		const images = await runtime.generateImages(image, imagesContext, options);
		const classified = await runtime.classify(classifier, classifierContext, options);
		const cancelled = await runtime.cancelDeferred(chat, { id: "h" } as never, options).catch((e: unknown) => e);
		expect(images.errorMessage).toBe("request setup failed: Error");
		expect(classified.errorMessage).toBe("request setup failed: Error");
		expect((cancelled as Error).message).toBe("request setup failed: Error");
		expect(calls.count).toBe(0);
	});
});

describe("R4-4: filename paste into shell input", () => {
	it.each([
		["!ls ", true],
		["!echo 'abc", false],
		['!echo "abc', false],
		["!echo abc\\", false],
		["!echo 'a' \"b\" c\\ d ", true],
		['!echo "it\'s" ', true],
	])("%j is an unquoted position: %s", (text, expected) => {
		expect(isUnquotedShellPosition(text)).toBe(expected);
	});
});
