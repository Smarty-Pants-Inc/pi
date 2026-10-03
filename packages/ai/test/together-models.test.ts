import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import type { Model } from "../src/types.ts";

const originalTogetherApiKey = process.env.TOGETHER_API_KEY;
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	if (originalTogetherApiKey === undefined) {
		delete process.env.TOGETHER_API_KEY;
	} else {
		process.env.TOGETHER_API_KEY = originalTogetherApiKey;
	}
});

describe("Together models", () => {
	// Regression for Smarty-Pants-Inc/pi#100: K2.6 was removed from Together's catalog.
	it("registers the default Kimi K3 model via OpenAI-compatible Chat Completions API", () => {
		const model = getModel("together", "moonshotai/Kimi-K3");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("together");
		expect(model.baseUrl).toBe("https://api.together.ai/v1");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null });
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1048576);
		expect(model.maxTokens).toBe(131072);
		expect(model.cost).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 0,
		});
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "together",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		});
	});

	it("models Together reasoning controls from the Together API surface", () => {
		const gptOss = getModel("together", "openai/gpt-oss-120b");
		expect(gptOss.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			max: null,
			xhigh: null,
		});
		expect(gptOss.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		});

		const minimax = getModel("together", "MiniMaxAI/MiniMax-M2.7");
		expect(minimax.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null });
		expect(minimax.compat?.thinkingFormat).toBeUndefined();
		expect(minimax.compat?.supportsReasoningEffort).toBe(false);
	});

	// Regression for Smarty-Pants-Inc/pi#125: retired IDs must not depend on the live catalog.
	it("preserves Together toggle-plus-effort controls with a generator fixture", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-together-generation-"));
		temporaryRoots.push(root);
		const preloadPath = join(root, "mock-catalog.mjs");
		const outputPath = join(root, "catalog");
		const modelId = "deepseek-ai/DeepSeek-V4-Pro";
		const catalog = {
			together: { models: { [modelId]: { id: modelId, tool_call: true, reasoning: true } } },
		};
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  const url = String(input);\n` +
				`  if (url === "https://models.dev/api.json") return Response.json(catalog);\n` +
				`  if (url === "https://models.dev/models.json?type=decision") return Response.json({ "typesafe/jev-latest": { name: "Jev", type: "decision" } });\n` +
				`  if (url.startsWith("https://openrouter.ai/api/v1/models") || url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({ data: [] });\n` +
				`  if (url === "https://radius.pi.dev/v1/config") return Response.json({ baseUrl: "https://radius.pi.dev", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 }] });\n` +
				`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
				`};\n`,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--json-only",
				"--json-output",
				outputPath,
			],
			{ cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 10_000 },
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stderr).toBe("");
		const models = JSON.parse(readFileSync(join(outputPath, "providers/together.json"), "utf8")) as Record<
			string,
			Model<"openai-completions">
		>;
		const deepSeekV4 = models[modelId];
		expect(deepSeekV4.thinkingLevelMap).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
		});
		expect(deepSeekV4.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "together",
		});
	});

	it("resolves TOGETHER_API_KEY from the environment", () => {
		process.env.TOGETHER_API_KEY = "test-together-key";

		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});
});
