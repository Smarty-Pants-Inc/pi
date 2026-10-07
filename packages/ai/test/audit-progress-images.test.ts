import { describe, expect, it } from "vitest";
import { generateImages } from "../src/api/openrouter-images.ts";
import { stream } from "../src/api/pi-messages.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Defensive schema acceptance for smarty-dev#5822; synthetic data and in-process transports only.
const marker = "SYNTHETIC_SCHEMA_METADATA_5822";
const model: Model<"pi-messages"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "pi-messages",
	provider: "radius",
	baseUrl: "https://mock.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 128,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function message(): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "generated" }],
		usage,
		timestamp: 0,
		stopReason: "stop",
	};
}

describe.each([undefined, false, true])("progress envelope policy=%s", (oauthDiagnostics) => {
	it("refuses nonnumeric wire contentIndex before publication", async () => {
		const wire = [
			{ type: "start" },
			{ type: "text_start", contentIndex: marker },
			{ type: "done", reason: "stop", usage },
		];
		const s = stream(model, normalizeContext({ messages: [] }), {
			apiKey: "synthetic",
			oauthDiagnostics,
			fetch: async () => new Response(wire.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")),
		});
		const events = [];
		for await (const e of s) events.push(e);
		expect(JSON.stringify({ events, result: await s.result() })).not.toContain(marker);
	});
});
it.each(["text_start", "thinking_start", "toolcall_start"] as const)(
	"refuses nonnumeric model-less %s index",
	async (type) => {
		const s = createAssistantMessageEventStream();
		s.push({
			type,
			contentIndex: { credentialDiagnostic: marker },
			partial: message(),
		} as unknown as AssistantMessageEvent);
		s.end(message());
		const events = [];
		for await (const e of s) events.push(e);
		expect(JSON.stringify(events)).not.toContain(marker);
	},
);
it.each(["text_delta", "thinking_delta", "toolcall_delta", "text_end", "thinking_end"] as const)(
	"refuses nonstring model-less %s payload",
	async (type) => {
		const s = createAssistantMessageEventStream();
		const e = {
			type,
			contentIndex: 0,
			partial: message(),
			[type.endsWith("delta") ? "delta" : "content"]: { credentialDiagnostic: marker },
		};
		s.push(e as unknown as AssistantMessageEvent);
		s.end(message());
		const events = [];
		for await (const e of s) events.push(e);
		expect(JSON.stringify(events)).not.toContain(marker);
	},
);
it.each(["receipt", "input", "output"])("closes successful image %s (design 9.1 rows 5/10)", async (field) => {
	const out = await generateImages(
		{ ...model, api: "openrouter-images", provider: "openrouter", type: "image", output: ["image"] },
		{ input: [{ type: "text", text: "synthetic" }] },
		{
			apiKey: "synthetic",
			maxRetries: 0,
			fetch: async () =>
				Response.json({
					id: marker,
					object: "chat.completion",
					created: 0,
					model: "synthetic",
					choices: [
						{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "generated", images: [] } },
					],
					usage: { prompt_tokens: 2 ** 40, completion_tokens: 1.5 },
				}),
		},
	);
	expect(out.stopReason).toBe("stop");
	if (field === "receipt") expect(out).not.toHaveProperty("responseId");
	if (field === "input") expect(out.usage?.input).toBeLessThanOrEqual(1e9);
	if (field === "output") expect(Number.isInteger(out.usage?.output)).toBe(true);
});
