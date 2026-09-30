import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { DEFAULT_TOOL_NAMES, SettingsManager } from "../src/core/settings-manager.ts";
import { createCodemodeExtension } from "../src/extensions/codemode/index.ts";

interface SelectionCase {
	name: string;
	global?: string[];
	project?: string[];
	overrides?: string[][];
	expected: string[];
}

// smarty-dev#2241 A10: prove settings layering through the SDK's real active-tool loadout.
const cases: SelectionCase[] = [
	{ name: "unspecified settings retain defaults", expected: [...DEFAULT_TOOL_NAMES] },
	{ name: "an empty project list replaces global tools", global: ["read", "bash"], project: [], expected: [] },
	{
		name: "project modifiers retain an empty global baseline",
		global: [],
		project: ["+codemode"],
		expected: ["codemode"],
	},
	{ name: "an unspecified project preserves global tools", global: ["read", "bash"], expected: ["read", "bash"] },
	{
		name: "plain project names replace global tools",
		global: ["read", "bash"],
		project: ["grep"],
		expected: ["grep"],
	},
	{
		name: "modifiers on an unspecified baseline retain defaults",
		project: ["-write", "+codemode"],
		expected: ["read", "bash", "edit", "codemode"],
	},
	{
		name: "project and invocation modifiers apply in order",
		global: ["read", "bash", "+codemode"],
		project: ["-codemode", "+grep"],
		overrides: [["-bash", "+codemode", "+read"]],
		expected: ["read", "grep", "codemode"],
	},
	{
		name: "an empty invocation replaces the inherited selection",
		global: ["read", "bash"],
		overrides: [[]],
		expected: [],
	},
	{
		name: "invocation modifiers do not restore tools after an empty replacement",
		global: ["read", "bash"],
		overrides: [[], ["+codemode"], ["-codemode", "+grep"]],
		expected: ["grep"],
	},
	{
		name: "removing the entire inherited selection keeps an empty baseline",
		global: ["read"],
		project: ["-read"],
		overrides: [["+codemode"]],
		expected: ["codemode"],
	},
	{
		name: "plain invocation names replace an empty baseline before modifiers",
		global: [],
		project: ["+codemode"],
		overrides: [["read", "+grep", "-read"]],
		expected: ["grep"],
	},
];

describe("security: explicit default-tool selections", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-security-tool-settings-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it.each(cases)("$name", async ({ global, project, overrides, expected }) => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: global, cacheWarming: "off" }));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: project }));
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [createCodemodeExtension()],
		});
		await resourceLoader.reload();
		// Reload restores persisted layers. Apply invocation-only settings after bootstrap, as the
		// CLI and examples/sdk/14-codemode-mcp.ts do; supplied loaders are not reloaded by the SDK.
		for (const defaultTools of overrides ?? []) settingsManager.applyOverrides({ defaultTools });
		expect(settingsManager.getDefaultTools() ?? [...DEFAULT_TOOL_NAMES]).toEqual(expected);
		expect(settingsManager.getGlobalSettings().defaultTools).toEqual(global);
		expect(settingsManager.getProjectSettings().defaultTools).toEqual(project);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			modelRuntime,
			model: modelRuntime.getModel("anthropic", "claude-sonnet-4-5"),
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			expect(settingsManager.drainErrors()).toEqual([]);
			expect(session.getActiveToolNames()).toEqual(expected);
			expect(session.getAllTools().map((tool) => tool.name)).toContain("codemode");
		} finally {
			session.dispose();
		}
	});
});
