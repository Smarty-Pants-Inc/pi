import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const KiB = 1024;
const MiB = KiB * KiB;
const oldImage = "A".repeat(3 * KiB);
const newestImage = "B".repeat(3 * KiB);
const userImage = "C".repeat(KiB);

function history(): Context {
	return {
		messages: [
			{ role: "user", content: "Inspect screenshots", timestamp: 1 },
			...([oldImage, oldImage, newestImage] as const).flatMap((data, index) => {
				const assistant: AssistantMessage = {
					role: "assistant",
					api: "openai-completions",
					provider: "openai",
					model: "test",
					content: [{ type: "toolCall", id: `call_${index}`, name: "screenshot", arguments: {} }],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: index * 2 + 2,
				};
				return [
					assistant,
					{
						role: "toolResult" as const,
						toolCallId: `call_${index}`,
						toolName: "screenshot",
						content: [
							{ type: "text" as const, text: `screenshot ${index}` },
							{ type: "image" as const, mimeType: "image/png", data },
						],
						isError: false,
						timestamp: index * 2 + 3,
					},
				];
			}),
			{
				role: "user",
				content: [
					{ type: "text", text: "Compare these" },
					{ type: "image", mimeType: "image/png", data: userImage },
				],
				timestamp: 10,
			},
		],
	};
}

async function runtimeFor(api: Api, requestBudgetBytes = 8 * KiB) {
	const settings = SettingsManager.inMemory({ images: { requestBudgetBytes } });
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
		settingsManager: settings,
	});
	const provider = api === "anthropic-messages" ? "anthropic" : api === "openai-completions" ? "openrouter" : "openai";
	const catalog = runtime.getModels(provider).find((model) => model.api === api && model.input.includes("image"));
	if (!catalog) throw new Error(`Missing offline catalog model for ${api}`);
	const model: Model<Api> = { ...catalog, baseUrl: "https://request-size.invalid/v1" };
	return { runtime, model, settings };
}

function capture(api: Api) {
	const bodies: string[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		bodies.push(await request.text());
		const frames =
			api === "anthropic-messages"
				? [
						{
							type: "message_start",
							message: {
								id: "msg_test",
								type: "message",
								role: "assistant",
								model: "test",
								content: [],
								stop_reason: null,
								usage: { input_tokens: 1, output_tokens: 0 },
							},
						},
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 1 },
						},
						{ type: "message_stop" },
					]
				: api === "openai-responses"
					? [
							{
								type: "response.completed",
								response: {
									id: "resp_test",
									status: "completed",
									output: [],
									usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
								},
							},
						]
					: [
							{
								id: "chatcmpl-test",
								object: "chat.completion.chunk",
								created: 0,
								model: "test",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
								usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
							},
						];
		const body = frames
			.map((frame) => `${"type" in frame ? `event: ${frame.type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`)
			.join("");
		return new Response(`${body}${api === "openai-completions" ? "data: [DONE]\n\n" : ""}`, {
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { bodies, fetch };
}

// Regression for smarty-dev#16938: accumulated screenshots exceeded the gateway's serialized JSON limit.
describe("ModelRuntime assembled request size (smarty-dev#16938)", () => {
	for (const api of ["openai-completions", "anthropic-messages", "openai-responses"] as const) {
		for (const boundary of ["stream", "streamSimple"] as const) {
			it(`${api} ${boundary} omits historical images only on the wire and publishes one terminal diagnostic`, async () => {
				const { runtime, model } = await runtimeFor(api);
				const context = history();
				const before = JSON.stringify(context);
				const { bodies, fetch } = capture(api);
				const stream = runtime[boundary](model, context, { apiKey: "offline-key", fetch });
				const events: AssistantMessageEvent[] = [];
				for await (const event of stream) events.push(event);
				const result = await stream.result();
				expect(result.stopReason).toBe("stop");
				expect(bodies).toHaveLength(1);
				expect(Buffer.byteLength(bodies[0])).toBeLessThanOrEqual(8 * KiB);
				expect(bodies[0]).not.toContain(oldImage);
				expect(bodies[0]).toContain(newestImage);
				expect(bodies[0]).toContain(userImage);
				expect(bodies[0]).toMatch(/omitted/i);
				expect(bodies[0]).toContain("screenshot 0");
				expect(JSON.stringify(context)).toBe(before);
				const diagnostics = result.diagnostics?.filter((entry) => entry.type === "request_images_omitted");
				expect(diagnostics).toHaveLength(1);
				expect(diagnostics?.[0]).toMatchObject({ imagesOmitted: 2, bytesSaved: expect.any(Number) });
				expect(diagnostics?.[0].bytesSaved).toBeGreaterThan(0);
				for (const event of events) {
					if ("partial" in event)
						expect(event.partial.diagnostics?.some((entry) => entry.type === "request_images_omitted")).not.toBe(
							true,
						);
					if (event.type === "done") expect(event.message.diagnostics).toEqual(result.diagnostics);
				}
			});
		}
	}

	it("keeps an under-budget transformed payload unchanged and adds no diagnostic", async () => {
		const { runtime, model } = await runtimeFor("openai-completions", MiB);
		const { bodies, fetch } = capture(model.api);
		let transformed: unknown;
		let calls = 0;
		const result = await runtime.completeSimple(model, history(), {
			apiKey: "offline-key",
			fetch,
			onPayload: async (payload, receivedModel) => {
				calls++;
				expect(receivedModel).toEqual(model);
				transformed = { ...(payload as Record<string, unknown>), user: "transformed" };
				return transformed;
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(calls).toBe(1);
		expect(JSON.parse(bodies[0])).toEqual(transformed);
		expect(result.diagnostics).toBeUndefined();
	});

	it("sizes system instructions, schemas and caller transform inflation after assembly", async () => {
		const { runtime, model } = await runtimeFor("openai-completions", 12 * KiB);
		const { bodies, fetch } = capture(model.api);
		const context = history();
		context.systemPrompt = "system ".repeat(100);
		context.tools = [
			{ name: "screenshot", description: "schema ".repeat(100), parameters: Type.Object({ query: Type.String() }) },
		];
		let assembledBytes = 0;
		const result = await runtime.completeSimple(model, context, {
			apiKey: "offline-key",
			fetch,
			onPayload: async (payload) => {
				const inflated = { ...(payload as Record<string, unknown>), user: "transform ".repeat(250) };
				assembledBytes = Buffer.byteLength(JSON.stringify(inflated));
				return inflated;
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(assembledBytes).toBeGreaterThan(12 * KiB);
		expect(Buffer.byteLength(bodies[0])).toBeLessThanOrEqual(12 * KiB);
		expect(bodies[0]).toContain("system system");
		expect(bodies[0]).toContain("schema schema");
		expect(bodies[0]).toContain("transform transform");
		expect(result.diagnostics?.filter((entry) => entry.type === "request_images_omitted")).toHaveLength(1);
	});

	it("fits a real over-16-MiB screenshot history into the default 12-MiB budget", async () => {
		const { runtime, model } = await runtimeFor("openai-completions", 12 * MiB);
		const context = history();
		for (const message of context.messages) {
			if (message.role !== "toolResult") continue;
			for (const content of message.content) {
				if (content.type === "image") content.data = content.data[0].repeat(6 * MiB);
			}
		}
		const { bodies, fetch } = capture(model.api);
		let assembledBytes = 0;
		const result = await runtime.completeSimple(model, context, {
			apiKey: "offline-key",
			fetch,
			onPayload: (payload) => {
				assembledBytes = Buffer.byteLength(JSON.stringify(payload));
			},
		});
		expect(assembledBytes).toBeGreaterThan(16 * MiB);
		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(1);
		expect(Buffer.byteLength(bodies[0])).toBeLessThanOrEqual(12 * MiB);
		expect(bodies[0]).toContain("B".repeat(6 * MiB));
		expect(bodies[0]).not.toContain("A".repeat(6 * MiB));
		expect(result.diagnostics?.[0]).toMatchObject({ type: "request_images_omitted", imagesOmitted: 2 });
	});

	it("keeps caller mutations but does not trim the caller's payload object", async () => {
		const { runtime, model } = await runtimeFor("openai-completions");
		const { bodies, fetch } = capture(model.api);
		let assembled: Record<string, unknown> | undefined;
		const result = await runtime.completeSimple(model, history(), {
			apiKey: "offline-key",
			fetch,
			onPayload: (payload) => {
				assembled = payload as Record<string, unknown>;
				assembled.user = "in-place caller transform";
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(bodies[0]).toContain("in-place caller transform");
		expect(bodies[0]).not.toContain(oldImage);
		expect(JSON.stringify(assembled)).toContain(oldImage);
		expect(assembled?.user).toBe("in-place caller transform");
	});

	it("reads settings changes for the next turn", async () => {
		const { runtime, model, settings } = await runtimeFor("openai-completions", MiB);
		const { bodies, fetch } = capture(model.api);
		settings.applyOverrides({ images: { requestBudgetBytes: 8 * KiB } });
		const result = await runtime.completeSimple(model, history(), { apiKey: "offline-key", fetch });
		expect(result.stopReason).toBe("stop");
		expect(Buffer.byteLength(bodies[0])).toBeLessThanOrEqual(8 * KiB);
		expect(result.diagnostics?.[0]).toMatchObject({ type: "request_images_omitted", imagesOmitted: 2 });
	});

	it("settles the outer result when forwarding fails while the provider result stays pending", async () => {
		const { runtime, model } = await runtimeFor("openai-completions");
		const source = new AssistantMessageEventStream();
		source[Symbol.asyncIterator] = () => ({
			next: async () => {
				throw new Error("Local forwarding failure");
			},
		});
		runtime.registerProvider(model.provider, { api: model.api, streamSimple: () => source });
		const result = await runtime.completeSimple(
			model,
			{ messages: [] },
			{
				apiKey: "offline-key",
				signal: new AbortController().signal,
			},
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Local forwarding failure");
		expect(result.recovery).toEqual({ retryable: false });
	});

	for (const boundary of ["stream", "streamSimple"] as const) {
		it(`${boundary} rejects over 16 MiB locally despite a larger upstream limit, without recovery or network`, async () => {
			const { runtime, model } = await runtimeFor("openai-completions");
			model.inputLimits = { ...model.inputLimits, maxRequestBytes: 512 * MiB };
			const context = history();
			context.systemPrompt = "X".repeat(16 * MiB + 1);
			const { bodies, fetch } = capture(model.api);
			let dispatches = 0;
			const stream = runtime[boundary](model, context, {
				apiKey: "offline-key",
				fetch,
				beforeProviderRequest: () => {
					dispatches++;
				},
			});
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			const result = await stream.result();
			expect(bodies).toHaveLength(0);
			expect(dispatches).toBe(0);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/request.*(large|bytes|size)/i);
			expect(result.errorMessage).toMatch(/compact|session|reduce|remove/i);
			expect(result.recovery).toEqual({ retryable: false });
			const diagnostics = result.diagnostics?.filter((entry) => entry.type === "request_images_omitted");
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics?.[0]).toMatchObject({ imagesOmitted: 4, bytesSaved: expect.any(Number) });
			expect(diagnostics?.[0].bytesSaved).toBeGreaterThan(0);
			const failures = events.filter((event) => event.type === "error");
			expect(failures).toHaveLength(1);
			expect(failures[0].error.diagnostics).toEqual(result.diagnostics);
			for (const event of events) {
				if ("partial" in event)
					expect(event.partial.diagnostics?.some((entry) => entry.type === "request_images_omitted")).not.toBe(
						true,
					);
			}
		});
	}
});
