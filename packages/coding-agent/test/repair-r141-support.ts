import { Agent } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { AgentSession } from "../src/core/agent-session.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

export const repairModel: Model<"openai-completions"> = {
	id: "requested-A",
	name: "Synthetic A",
	provider: "synthetic",
	api: "openai-completions",
	baseUrl: "https://mock.invalid",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};

export function repairResources(): ResourceLoader {
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export async function repairSession(
	agent = new Agent({
		initialState: { model: repairModel },
		streamFn: () => {
			throw new Error("Synthetic stream not configured");
		},
	}),
) {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const manager = SessionManager.inMemory(process.cwd());
	const settings = SettingsManager.inMemory();
	settings.setRetryEnabled(false);
	settings.setCompactionEnabled(false);
	settings.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 128 } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager: settings,
		cwd: process.cwd(),
		modelRuntime: runtime,
		resourceLoader: repairResources(),
		baseToolsOverride: {},
		initialActiveToolNames: [],
	});
	return { session, manager, settings, agent, runtime };
}
