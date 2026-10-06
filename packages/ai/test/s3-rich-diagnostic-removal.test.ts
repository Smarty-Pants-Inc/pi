import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stream as completionsStream } from "../src/api/openai-completions.ts";
import { stream as responsesStream } from "../src/api/openai-responses.ts";
import { generateImages } from "../src/api/openrouter-images.ts";
import type { Api, Model } from "../src/types.ts";
import { normalizeProviderError } from "../src/utils/error-body.ts";
import { isRetryableAssistantError, throttledLimitWait } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const canary = "SYNTHETIC_RICH_DIAGNOSTIC_5822";
const context = normalizeContext({ messages: [] });
function model<A extends Api>(api: A): Model<A> {
	return {
		id: "synthetic",
		name: "Synthetic",
		provider: "openai",
		api,
		baseUrl: "https://mock.invalid/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 4096,
		maxTokens: 128,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

// smarty-dev#5822 T-R2-05 / T-guard: publication has no live-secret collection or rich branch.
it("removes collectors and recursive masking from request and publication paths", () => {
	const root = new URL("../src/", import.meta.url);
	const files = [
		"types.ts",
		"models.ts",
		"auth/resolve.ts",
		"auth/types.ts",
		"utils/error-body.ts",
		"utils/provider-retry.ts",
		...readdirSync(new URL("api/", root))
			.filter((file) => file.endsWith(".ts"))
			.map((file) => `api/${file}`),
	];
	for (const file of files) {
		const source = readFileSync(new URL(file, root), "utf8");
		expect(source, file).not.toMatch(/getOAuthDiagnosticSecrets|diagnosticSecrets|redactOAuthDiagnostic/);
	}
	const runtime = readFileSync(new URL("../../coding-agent/src/core/model-runtime.ts", import.meta.url), "utf8");
	expect(runtime).not.toMatch(/getOAuthDiagnosticSecrets|diagnosticSecrets|redactOAuthDiagnostic/);
});

// smarty-dev#5822 T-R2-05: an obsolete diagnostic input must not be inspected before request preparation.
it("does not inspect secret lists in the direct image adapter", async () => {
	const fetch = async () => Response.json({ error: { message: canary } }, { status: 503 });
	const options = { apiKey: "synthetic", maxRetries: 0, fetch };
	Object.defineProperty(options, "diagnosticSecrets", {
		get() {
			throw new Error(canary);
		},
	});
	const output = await generateImages(
		{ ...model("openrouter-images"), type: "image", output: ["image"] },
		{ input: [{ type: "text", text: "generated" }] },
		options,
	);
	expect(output.errorMessage).toContain("HTTP 503");
	expect(JSON.stringify(output)).not.toContain(canary);
});

// smarty-dev#5822 T-Astra1: provider bodies/metadata are never a rich diagnostic channel.
describe.each([undefined, false, true])("owned rich-error replacement policy=%s", (oauthDiagnostics) => {
	it.each(["completions", "responses"] as const)("keeps %s HTTP recovery and fixed text", async (adapter) => {
		const options = {
			apiKey: "synthetic",
			oauthDiagnostics,
			maxRetries: 0,
			fetch: async () =>
				Response.json(
					{
						error: {
							message: `service unavailable ${canary}`,
							metadata: { raw: canary },
							details: { nested: [canary] },
						},
					},
					{ status: 503 },
				),
		};
		const stream =
			adapter === "completions"
				? completionsStream(model("openai-completions"), context, options)
				: responsesStream(model("openai-responses"), context, options);
		const events: unknown[] = [];
		for await (const event of stream) events.push(event);
		const output = await stream.result();
		expect(output.errorMessage).toMatch(/^(oauth|provider)_request_failed \(HTTP 503\)$/);
		expect(output.oauthRecovery?.retryable).toBe(true);
		expect(JSON.stringify({ events, output, jsonl: { type: "message", message: output } })).not.toContain(canary);
	});
	it("retains private one-shot throttle wait without gateway diagnostic text", async () => {
		const output = await completionsStream(model("openai-completions"), context, {
			apiKey: "synthetic",
			oauthDiagnostics,
			maxRetries: 0,
			fetch: async () =>
				Response.json(
					{ error: { code: "smarty_limit", throttled: true, message: canary } },
					{ status: 429, headers: { "retry-after": "1" } },
				),
		}).result();
		expect(throttledLimitWait(output)).toEqual({ delayMs: 1000, waitMessage: "Flash runs one request at a time" });
		expect(isRetryableAssistantError(output)).toBe(false);
		expect(output.diagnostics).toEqual([{ type: "provider_limit", timestamp: expect.any(Number) }]);
		expect(JSON.stringify(output)).not.toContain(canary);
	});
});

// smarty-dev#5822 T-Astra1: classification reads original SDK body but normalized output is closed.
it("rebuilds normalization without a body or rich-message contract", () => {
	const output = normalizeProviderError(
		Object.assign(new Error(canary), { status: 503, body: `service unavailable ${canary}` }),
	);
	expect(Object.keys(output).sort()).toEqual(["message", "oauthRecovery", "status"]);
	expect(output.oauthRecovery?.retryable).toBe(true);
	expect(JSON.stringify(output)).not.toContain(canary);
});
