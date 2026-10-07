import { describe, expect, it } from "vitest";
import { generateImages as openrouterImages } from "../src/api/openrouter-images.ts";
import { generateImages } from "../src/images.ts";
import { registerImagesApiProvider } from "../src/images-api-registry.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { AssistantImages, AssistantMessage, AssistantMessageEvent, ImageModel } from "../src/types.ts";
import { projectAssistantImages } from "../src/utils/diagnostics.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const imageModel: ImageModel<"openrouter-images"> = {
	type: "image",
	id: "synthetic",
	name: "Synthetic",
	provider: "openrouter",
	api: "openrouter-images",
	baseUrl: "https://mock.invalid",
	input: ["text"],
	output: ["image"],
	cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 4 },
};
function message(): AssistantMessage {
	return {
		role: "assistant",
		api: "pi-messages",
		provider: "radius",
		model: "synthetic",
		content: [{ type: "text", text: "generated" }],
		usage,
		timestamp: 0,
		stopReason: "pending",
	};
}
// smarty-dev#5822 F4: reject malformed indices with an owned terminal, without inspecting their text.
it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 65_536, 1])(
	"refuses index %s before progress publication",
	async (contentIndex) => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "text_start", contentIndex, partial: message() });
		stream.push({ type: "done", reason: "stop", message: { ...message(), stopReason: "stop" } });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect((await stream.result()).stopReason).toBe("error");
		expect((await stream.result()).oauthRecovery?.retryable).toBe(false);
	},
);
// smarty-dev#5822 F4: normal text/thinking/tool progress stays immutable and unchanged.
it("preserves normal progress and independent publication snapshots", async () => {
	const stream = createAssistantMessageEventStream();
	const partial = message();
	partial.content = [
		{ type: "text", text: "" },
		{ type: "thinking", thinking: "" },
		{ type: "toolCall", id: "call", name: "probe", arguments: {} },
	];
	stream.push({ type: "start", partial });
	stream.push({ type: "text_start", contentIndex: 0, partial });
	partial.content[0] = { type: "text", text: "generated" };
	stream.push({ type: "text_delta", contentIndex: 0, delta: "generated", partial });
	stream.push({ type: "text_end", contentIndex: 0, content: "generated", partial });
	stream.push({ type: "thinking_start", contentIndex: 1, partial });
	partial.content[1] = { type: "thinking", thinking: "reason" };
	stream.push({ type: "thinking_delta", contentIndex: 1, delta: "reason", partial });
	stream.push({ type: "thinking_end", contentIndex: 1, content: "reason", partial });
	stream.push({ type: "toolcall_start", contentIndex: 2, partial });
	stream.push({ type: "toolcall_delta", contentIndex: 2, delta: "{}", partial });
	stream.push({
		type: "toolcall_end",
		contentIndex: 2,
		toolCall: { type: "toolCall", id: "call", name: "probe", arguments: {} },
		partial,
	});
	stream.push({ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	expect(events.map((event) => event.type)).toEqual([
		"start",
		"text_start",
		"text_delta",
		"text_end",
		"thinking_start",
		"thinking_delta",
		"thinking_end",
		"toolcall_start",
		"toolcall_delta",
		"toolcall_end",
		"done",
	]);
	expect(events[0]).toMatchObject({
		partial: {
			content: [
				{ type: "text", text: "" },
				{ type: "thinking", thinking: "" },
				{ type: "toolCall", id: "call", name: "probe", arguments: {} },
			],
		},
	});
	expect((await stream.result()).content).toEqual(partial.content);
});
// smarty-dev#5822 F5/F7: shared dispatch and the direct projector retain content, not receipt metadata.
describe.each(["stop", "error"] as const)("shared image publication %s", (stopReason) => {
	it("projects registered and Models provider results without mutating the private result", async () => {
		const model = { ...imageModel, api: "synthetic-images", provider: "synthetic" };
		const raw: AssistantImages = {
			api: model.api,
			provider: model.provider,
			model: model.id,
			output: [
				{ type: "text", text: "generated" },
				{ type: "image", data: "aGk=", mimeType: "image/png" },
			],
			responseId: "SYNTHETIC_PRIVATE_RECEIPT",
			usage,
			stopReason,
			timestamp: 0,
		};
		registerImagesApiProvider({ api: model.api, generateImages: async () => raw });
		const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
		const provider = createProvider({
			id: model.provider,
			models: [model],
			auth: { apiKey: { name: "synthetic", resolve: async () => ({ auth: {} }) } },
			images: { [model.api]: { generateImages: async () => raw } },
		});
		models.setProvider(provider);
		for (const result of [
			projectAssistantImages(raw),
			await generateImages(model, { input: [] }),
			await models.generateImages(model, { input: [] }),
			await provider.generateImages!(model, { input: [] }),
		]) {
			expect(result).not.toHaveProperty("responseId");
			expect(result.output).toEqual(raw.output);
			expect(result.output).not.toBe(raw.output);
			expect(result.stopReason).toBe(stopReason);
		}
		expect(raw.responseId).toBe("SYNTHETIC_PRIVATE_RECEIPT");
	});
});
// smarty-dev#5822 F7: in-bound counts and pricing must survive the shared accounting projector.
it("preserves legitimate image accounting and derives total cost from rebuilt components", async () => {
	const result = await openrouterImages(
		imageModel,
		{ input: [{ type: "text", text: "synthetic" }] },
		{
			apiKey: "synthetic",
			maxRetries: 0,
			fetch: async () =>
				Response.json({
					id: "private",
					choices: [{ message: { content: "generated", images: [] } }],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 20,
						prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
					},
				}),
		},
	);
	expect(result.usage).toMatchObject({ input: 70, output: 20, cacheRead: 20, cacheWrite: 10, totalTokens: 120 });
	expect(result.usage?.cost.input).toBeCloseTo(0.00014);
	expect(result.usage?.cost.output).toBeCloseTo(0.00006);
	expect(result.usage?.cost.cacheRead).toBeCloseTo(0.00002);
	expect(result.usage?.cost.cacheWrite).toBeCloseTo(0.00004);
	expect(result.usage?.cost.total).toBeCloseTo(0.00026);
	expect(result).not.toHaveProperty("responseId");
});

// smarty-dev#5822 F4: absent required fields are malformed, not undefined public positions.
it.each([
	{ type: "text_start", partial: message() },
	{ type: "text_start", contentIndex: 0 },
	{ type: "text_delta", contentIndex: 0, partial: message() },
	{ type: "thinking_delta", contentIndex: 0, partial: message() },
	{ type: "toolcall_delta", contentIndex: 0, partial: message() },
	{ type: "text_end", contentIndex: 0, partial: message() },
	{ type: "thinking_end", contentIndex: 0, partial: message() },
])("refuses missing fields in $type", async (malformed) => {
	const stream = createAssistantMessageEventStream();
	stream.push(malformed as unknown as AssistantMessageEvent);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	expect(events.map((event) => event.type)).toEqual(["error"]);
	expect((await stream.result()).stopReason).toBe("error");
});
