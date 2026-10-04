import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { afterEach, expect, it, vi } from "vitest";
import { type OpenAIResponsesOptions, stream } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

// PR #131: the workspace must resolve its pinned SDK, not the older root SDK.
// These contracts fail typechecking against root OpenAI 6.40.0.
const fastOptions = { serviceTier: "fast" } satisfies OpenAIResponsesOptions;
const cacheCases = [
	["none", { mode: "explicit" }],
	["short", undefined],
	["long", { ttl: "30m" }],
] as const satisfies ReadonlyArray<
	readonly ["none" | "short" | "long", ResponseCreateParamsStreaming["prompt_cache_options"]]
>;

afterEach(() => vi.restoreAllMocks());

it.each(cacheCases)(
	"preserves %s explicit prompt caching and fast tier payloads",
	async (cacheRetention, cacheOptions) => {
		let payload: unknown;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		const baseModel = getModel("openai", "gpt-6-luna");
		await stream(
			{ ...baseModel, compat: { ...baseModel.compat, supportsExplicitPromptCacheMode: true } },
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
			{
				...fastOptions,
				apiKey: "sk-test-key",
				cacheRetention,
				onPayload: (value) => {
					payload = value;
				},
			},
		).result();
		expect(payload).toMatchObject({ service_tier: "fast", prompt_cache_options: cacheOptions });
	},
);
