import { describe, expect, it } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Model, ProviderHeaders } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
});

async function capturePayload(
	apiKey: string | undefined,
	requestModel: Model<"openai-responses"> = model,
	headers?: ProviderHeaders,
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	await streamOpenAIResponses(requestModel, context, {
		apiKey,
		headers,
		maxRetries: 0,
		maxTokens: 1000,
		temperature: 0.5,
		cacheRetention: "long",
		onPayload: (params) => {
			payload = params as Record<string, unknown>;
		},
		fetch: async () => new Response(null, { status: 500 }),
	}).result();
	if (!payload) throw new Error("Request payload was not captured");
	return payload;
}

describe("OpenAI Responses with Sign in with ChatGPT", () => {
	// smarty-dev#3535 / pi#137 A10: compatibility follows the final Authorization credential.
	it.each<{ name: string; apiKey: string | undefined; headers: ProviderHeaders; chatgpt: boolean }>([
		{
			name: "header-only token",
			apiKey: undefined,
			headers: { Authorization: "Bearer chatgpt-access-token" },
			chatgpt: true,
		},
		{
			name: "header token overrides API key",
			apiKey: "sk-proj-test",
			headers: { authorization: "Bearer chatgpt-access-token" },
			chatgpt: true,
		},
		{
			name: "header API key overrides token",
			apiKey: "chatgpt-access-token",
			headers: { AUTHORIZATION: "Bearer sk-proj-test" },
			chatgpt: false,
		},
	])("uses $name", async ({ apiKey, headers, chatgpt }) => {
		const payload = await capturePayload(apiKey, model, headers);
		expect(payload.max_output_tokens).toBe(chatgpt ? undefined : 1000);
		expect(payload.temperature).toBe(chatgpt ? undefined : 0.5);
		expect(payload.prompt_cache_retention).toBe(chatgpt ? undefined : "24h");
		const explicit = await capturePayload(
			apiKey,
			{ ...model, compat: { supportsExplicitPromptCacheMode: true } },
			headers,
		);
		expect(explicit.prompt_cache_options).toEqual(chatgpt ? undefined : { ttl: "30m" });
	});

	it("uses model header authentication and final case-insensitive overrides on the wire", async () => {
		const headerModel = { ...model, headers: { Authorization: "Bearer chatgpt-access-token" } };
		expect((await capturePayload(undefined, headerModel)).temperature).toBeUndefined();
		let auth: string | null | undefined;
		let payload: Record<string, unknown> | undefined;
		await streamOpenAIResponses(headerModel, context, {
			apiKey: "chatgpt-access-token",
			maxTokens: 1000,
			temperature: 0.5,
			maxRetries: 0,
			headers: { authorization: "Bearer sk-proj-test" },
			fetch: async (_input, init) => {
				auth = new Headers(init?.headers).get("authorization");
				payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(null, { status: 500 });
			},
		}).result();
		expect(auth).toBe("Bearer sk-proj-test");
		expect(payload?.temperature).toBe(0.5);
	});
	it("omits request fields that token sharing rejects", async () => {
		const payload = await capturePayload("chatgpt-access-token");

		expect(payload).not.toHaveProperty("max_output_tokens");
		expect(payload).not.toHaveProperty("temperature");
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("omits prompt_cache_options on models with explicit prompt cache mode", async () => {
		const explicitCacheModel = { ...model, compat: { supportsExplicitPromptCacheMode: true } };

		const signInPayload = await capturePayload("chatgpt-access-token", explicitCacheModel);
		const apiKeyPayload = await capturePayload("sk-proj-test", explicitCacheModel);

		expect(signInPayload.prompt_cache_options).toBeUndefined();
		expect(apiKeyPayload.prompt_cache_options).toEqual({ ttl: "30m" });
	});

	it.each([
		{ name: "OpenAI API keys", apiKey: "sk-proj-test", requestModel: model },
		{
			name: "other OpenAI-compatible endpoints",
			apiKey: "gateway-key",
			requestModel: { ...model, baseUrl: "https://gateway.example.com/v1" },
		},
	])("keeps those fields for $name", async ({ apiKey, requestModel }) => {
		const payload = await capturePayload(apiKey, requestModel);

		expect(payload.max_output_tokens).toBe(1000);
		expect(payload.temperature).toBe(0.5);
		expect(payload.prompt_cache_retention).toBe("24h");
	});
});
