import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { filterOmittedProviders } from "../scripts/model-data.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("strict model generation", () => {
	// Refs smarty-dev#3155: replay the pinned snapshot without network or credentials.
	it("replays offline data with upstream corrections and without fetching catalogs", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-offline-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		const dataDir = join(packageRoot, "src/providers/data");
		const models = readdirSync(dataDir)
			.filter((name) => name.endsWith(".json") && !name.startsWith("."))
			.flatMap((name) => {
				const data = JSON.parse(readFileSync(join(dataDir, name), "utf8")) as Record<
					string,
					Record<string, unknown>
				>;
				return Object.values(data).flatMap((catalog) => Object.values(catalog));
			});
		const inputPath = join(fixtureRoot, "models.json");
		writeFileSync(inputPath, JSON.stringify(models));
		const preloadPath = join(fixtureRoot, "no-fetch.mjs");
		writeFileSync(preloadPath, 'globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };\n');
		const generatedPath = join(isolatedPackageRoot, "src/models.generated.ts");
		const generatedBefore = readFileSync(generatedPath, "utf8");
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--strict",
				"--data-only",
				"--offline-data",
				inputPath,
			],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 20_000 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).not.toContain("NETWORK_FORBIDDEN");
		expect(readFileSync(generatedPath, "utf8")).toBe(generatedBefore);
		const codex = JSON.parse(
			readFileSync(join(isolatedPackageRoot, "src/providers/data/openai-codex.json"), "utf8"),
		) as Record<string, Record<string, { id: string }>>;
		expect(
			Object.values(codex)
				.flatMap((catalog) => Object.values(catalog))
				.some((model) => model.id === "gpt-6.1-sol"),
		).toBe(true);
	});
	it("omits Kimi while retaining other providers", () => {
		const models = [
			{ provider: "kimi-coding", id: "k3" },
			{ provider: "anthropic", id: "claude-sonnet" },
		];

		expect(filterOmittedProviders(models, new Set(["kimi-coding"]))).toEqual([
			{ provider: "anthropic", id: "claude-sonnet" },
		]);
	});

	it("fails before mutating generated data when an Individual model loses tool support", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
		const modelIds = [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-flash",
			"qwen3.8-max",
			"qwen3.8-max-preview",
		];
		const sourceModels = Object.fromEntries(
			modelIds.map((id) => [
				id,
				{
					id,
					name: id,
					tool_call: id !== "deepseek-v4-flash-0731",
				},
			]),
		);
		const catalog = { "alibaba-token-plan": { models: sourceModels } };
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  if (String(input) === "https://models.dev/api.json") {\n` +
				`    return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  }\n` +
				`  throw new Error(\`Unexpected fetch: \${String(input)}\`);\n` +
				`};\n`,
		);

		const generatedPaths = [
			"src/models.generated.ts",
			"src/providers/qwen-token-plan-individual.models.ts",
			"src/providers/data/qwen-token-plan-individual.json",
			"src/providers/data/.manifest.json",
		];
		const sourceBefore = generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"));
		const isolatedBefore = generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"));

		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict"],
			{
				cwd: isolatedPackageRoot,
				encoding: "utf8",
				timeout: 10_000,
			},
		);

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"qwen-token-plan-individual model IDs do not match (missing: deepseek-v4-flash-0731)",
		);
		expect(generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"))).toEqual(
			isolatedBefore,
		);
		expect(generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"))).toEqual(sourceBefore);
	});
});
