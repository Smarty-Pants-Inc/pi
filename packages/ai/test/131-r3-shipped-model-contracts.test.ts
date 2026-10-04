import { describe, expect, it } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as streamMistral } from "../src/api/mistral-conversations.ts";
import { clampThinkingLevel } from "../src/models.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Context, Model, ModelThinkingLevel } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

async function captureMistral(model: Model<"mistral-conversations">, reasoning?: ModelThinkingLevel) {
	const clamped = reasoning === undefined ? undefined : clampThinkingLevel(model, reasoning);
	let wire: Record<string, unknown> | undefined;
	const result = await streamMistral(
		model,
		normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		}),
		{
			apiKey: "fake-key",
			reasoning: clamped === "off" ? undefined : clamped,
			fetch: async (_input, init) => {
				wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(
					`data: ${JSON.stringify({
						id: "mock-response",
						model: model.id,
						choices: [{ index: 0, finish_reason: "stop", delta: { content: "ok" } }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})}\n\ndata: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		},
	).result();
	expect(result.stopReason).toBe("stop");
	expect(wire?.model).toBe(model.id);
	return wire!;
}

interface AnthropicPayload {
	messages: Array<{
		role: string;
		content: Array<{ type: string; text?: string; thinking?: string; signature?: string }>;
	}>;
}

async function captureReplay(model: Model<"anthropic-messages">, signature = "", sourceId = model.id) {
	const assistant: AssistantMessage = {
		role: "assistant",
		provider: model.provider,
		api: model.api,
		model: sourceId,
		content: [
			{ type: "thinking", thinking: "retained reasoning", thinkingSignature: signature },
			{ type: "text", text: "answer" },
		],
		stopReason: "stop",
		timestamp: 2,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const context: Context = {
		messages: [
			{ role: "user", content: "first", timestamp: 1 },
			assistant,
			{ role: "user", content: "next", timestamp: 3 },
		],
	};
	let payload: AnthropicPayload | undefined;
	let fetchCalls = 0;
	await streamAnthropic(model, normalizeContext(context), {
		apiKey: "fake-key",
		cacheRetention: "none",
		fetch: async () => {
			fetchCalls++;
			throw new Error("unexpected network admission");
		},
		onPayload: (value) => {
			payload = value as AnthropicPayload;
			throw new Error("captured before network");
		},
	}).result();
	expect(fetchCalls).toBe(0);
	expect(payload).toBeDefined();
	return payload!.messages.find((message) => message.role === "assistant")!.content;
}

describe("PR #131 round 3 shipped model contracts", () => {
	// PR #131 F19: test shipped lookup and serialized wire, not synthetic thinking maps.
	describe.each([
		"mistral-medium-2604",
		"mistral-medium-3.5",
		"mistral-medium-latest",
		"mistral-small-2603",
		"mistral-small-latest",
		"zai-glm-5-2",
	] as const)("Mistral %s", (id) => {
		it.each(["high", "low", "off", undefined] as const)("selects effort for %s", async (level) => {
			const model = getBuiltinModel("mistral", id);
			expect(model.reasoning).toBe(true);
			const wire = await captureMistral(model, level);
			expect(wire.reasoning_effort).toBe(level === "off" || level === undefined ? "none" : "high");
			expect(wire).not.toHaveProperty("prompt_mode");
		});
	});
	// PR #131 F19: GLM-5.3 is always-thinking; explicit off is unsupported, never prompt_mode.
	it.each(["low", "medium", "high", "max", "off", undefined] as const)("GLM-5.3 effort %s", async (level) => {
		const wire = await captureMistral(getBuiltinModel("mistral", "zai-glm-5-3"), level);
		if (level === undefined) expect(wire).not.toHaveProperty("reasoning_effort");
		else expect(wire.reasoning_effort).toBe(level === "medium" ? "high" : level === "off" ? "low" : level);
		expect(wire).not.toHaveProperty("prompt_mode");
	});
	it("GLM-5.2 retains max", async () => {
		expect((await captureMistral(getBuiltinModel("mistral", "zai-glm-5-2"), "max")).reasoning_effort).toBe("max");
	});
	it("preserves Magistral prompt_mode and off", async () => {
		const model = getBuiltinModel("mistral", "magistral-medium-latest");
		const enabled = await captureMistral(model, "high");
		expect(enabled.prompt_mode).toBe("reasoning");
		expect(enabled).not.toHaveProperty("reasoning_effort");
		const off = await captureMistral(model, "off");
		expect(off).not.toHaveProperty("prompt_mode");
		expect(off).not.toHaveProperty("reasoning_effort");
	});
	it("preserves non-reasoning Mistral", async () => {
		const wire = await captureMistral(getBuiltinModel("mistral", "mistral-medium-2505"), "high");
		expect(wire).not.toHaveProperty("prompt_mode");
		expect(wire).not.toHaveProperty("reasoning_effort");
	});
	// PR #131 F19: both actual Qwen catalogs must preserve unsigned thinking on same-model replay.
	describe.each(["opencode", "opencode-go"] as const)("%s Qwen", (provider) => {
		it("preserves empty-signature thinking", async () => {
			const model = getBuiltinModel(provider, "qwen3.8-flash");
			expect(await captureReplay(model)).toEqual([
				{ type: "thinking", thinking: "retained reasoning", signature: "" },
				{ type: "text", text: "answer" },
			]);
			expect(model.compat?.allowEmptySignature).toBe(true);
		});
		it("preserves signed thinking", async () => {
			expect(await captureReplay(getBuiltinModel(provider, "qwen3.8-flash"), "signed")).toEqual([
				{ type: "thinking", thinking: "retained reasoning", signature: "signed" },
				{ type: "text", text: "answer" },
			]);
		});
		it("still converts cross-model thinking to text", async () => {
			expect(await captureReplay(getBuiltinModel(provider, "qwen3.8-flash"), "", "other-model")).toEqual([
				{ type: "text", text: "retained reasoning" },
				{ type: "text", text: "answer" },
			]);
		});
	});
	it("does not opt other OpenCode models into unsigned replay", async () => {
		const model = getBuiltinModel("opencode", "claude-haiku-4-5");
		expect(model.compat?.allowEmptySignature).not.toBe(true);
		expect(await captureReplay(model)).toEqual([
			{ type: "text", text: "retained reasoning" },
			{ type: "text", text: "answer" },
		]);
	});
});
