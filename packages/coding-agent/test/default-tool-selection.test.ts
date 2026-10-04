import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { DEFAULT_TOOL_NAMES, SettingsManager } from "../src/core/settings-manager.ts";

// pi#137 A5: explicit empty replacements differ from absent/default modifier baselines.
describe("default tool selection through settings and SDK session creation", () => {
	it.each([
		{ global: ["read", "bash"], project: [], expected: [] },
		{ global: [], project: ["+grep"], expected: ["grep"] },
		{ global: undefined, project: ["+grep"], expected: [...DEFAULT_TOOL_NAMES, "grep"] },
		{ global: [], project: undefined, expected: [] },
		{ global: undefined, project: undefined, expected: undefined },
	])(
		"loads global=$global project=$project without restoring unwanted tools",
		async ({ global, project, expected }) => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-default-tools-"));
			const agentDir = join(cwd, "agent");
			mkdirSync(agentDir);
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: global }));
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: project }));
			try {
				const settingsManager = SettingsManager.create(cwd, agentDir);
				expect(settingsManager.getDefaultTools()).toEqual(expected);
				await settingsManager.reload();
				expect(settingsManager.getDefaultTools()).toEqual(expected);
				const resourceLoader = new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager,
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				});
				await resourceLoader.reload();
				const modelRuntime = await ModelRuntime.create({
					credentials: AuthStorage.inMemory(),
					modelsPath: null,
					allowModelNetwork: false,
				});
				const { session } = await createAgentSession({
					cwd,
					agentDir,
					settingsManager,
					resourceLoader,
					modelRuntime,
					model: getModel("anthropic", "claude-sonnet-4-5"),
					sessionManager: SessionManager.inMemory(cwd),
				});
				try {
					expect(session.getActiveToolNames()).toEqual(expected ?? DEFAULT_TOOL_NAMES);
				} finally {
					session.dispose();
				}
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	);

	it("keeps empty override baselines empty across later modifier layers", () => {
		const settings = SettingsManager.inMemory({ defaultTools: ["read", "+bash"] });
		settings.applyOverrides({ defaultTools: [] });
		expect(settings.getDefaultTools()).toEqual([]);
		settings.applyOverrides({ defaultTools: ["-grep"] });
		expect(settings.getDefaultTools()).toEqual([]);
		settings.applyOverrides({ defaultTools: ["+grep"] });
		expect(settings.getDefaultTools()).toEqual(["grep"]);
	});
});
