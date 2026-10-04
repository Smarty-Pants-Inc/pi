import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../../ai/src/auth/credential-store.ts";
import { InMemoryModelsStore } from "../../ai/src/models-store.ts";
import type { Model } from "../../ai/src/types.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const model: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "audit-faux",
	id: "audit-faux",
	name: "Audit Faux",
	baseUrl: "http://mock.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

async function construct(seed: boolean, mutateDuringPreparation: boolean) {
	const manager = SessionManager.inMemory(process.cwd());
	if (seed) manager.appendMessage({ role: "user", content: "before-resource-preparation", timestamp: 1 });
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	let prepared = false;
	const resourceLoader: ResourceLoader = {
		getExtensions: () => {
			if (!prepared && mutateDuringPreparation)
				manager.appendMessage({ role: "user", content: "during-resource-preparation", timestamp: 2 });
			prepared = true;
			return extensionsResult;
		},
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
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir: tmpdir(),
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory(),
		modelRuntime: runtime,
		resourceLoader,
		model,
		tools: [],
	});
	try {
		const observed = structuredClone(session.messages);
		const canonical = structuredClone(manager.buildSessionContext().messages);
		console.log(`SDK_AUDIT_RECEIPT ${JSON.stringify({ seed, mutateDuringPreparation, observed, canonical })}`);
		return { observed, canonical };
	} finally {
		session.dispose();
	}
}

// PR #131: AU-CV-P2 regression controls from the independent audit.
describe("independent SDK snapshot freshness", () => {
	it.each([false, true])(
		"retains canonical messages arriving during resource preparation; seeded=%s",
		async (seed) => {
			const result = await construct(seed, true);
			expect(result.observed).toEqual(result.canonical);
			expect(
				result.canonical.some(
					(message) => "content" in message && message.content === "during-resource-preparation",
				),
			).toBe(true);
		},
	);
	it("stable resource preparation does not lose existing messages", async () => {
		const result = await construct(true, false);
		expect(result.observed).toEqual(result.canonical);
	});
});
