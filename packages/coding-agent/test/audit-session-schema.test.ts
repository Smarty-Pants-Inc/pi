import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/pi-messages";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const canary = "SYNTHETIC_PI_JOURNAL_5822";
const model: Model<"pi-messages"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "pi-messages",
	provider: "radius",
	baseUrl: "https://mock.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 128,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	extra: canary,
};
// Extracted no-cleanup fixture: do not import utilities.ts or suite/harness.ts (#4664).
const resourceLoader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
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
// Defensive acceptance regression for smarty-dev#5822; unknown wire diagnostics are not generated arguments.
describe.each([undefined, false, true])("auditor persisted nested schema policy=%s", (oauthDiagnostics) => {
	it("omits unknown tool-call diagnostics from events, messages and JSONL", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("radius", async () => ({ type: "api_key", key: "synthetic" }));
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const dir = mkdtempSync(join(tmpdir(), "audit-nested-schema-"));
		const journal = SessionManager.create(dir, dir);
		const wire = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call", toolName: "probe" },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: "toolCall",
					id: "call",
					name: "probe",
					arguments: {},
					credentialDiagnostic: canary,
				},
			},
			{ type: "error", reason: "error", usage: { ...usage, extra: undefined } },
		];
		const agent = new Agent({
			initialState: { model, tools: [] },
			streamFn: (_m, ctx) =>
				stream(model, normalizeContext(ctx), {
					apiKey: "synthetic",
					oauthDiagnostics,
					fetch: async () => new Response(wire.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")),
				}),
		});
		const session = new AgentSession({
			agent,
			sessionManager: journal,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			cwd: dir,
			modelRuntime: runtime,
			resourceLoader,
			baseToolsOverride: {},
			initialActiveToolNames: [],
		});
		const events: unknown[] = [];
		session.subscribe((e) => {
			events.push(e);
		});
		await session.prompt("synthetic request");
		const file = journal.getSessionFile();
		if (!file) throw new Error("Missing journal");
		const jsonl = readFileSync(file, "utf8");
		const messages = session.messages;
		session.dispose();
		const surfaces = [JSON.stringify(events), JSON.stringify(messages), jsonl];
		// Verify each sink separately: a failed turn still must not publish unknown diagnostic metadata.
		expect(surfaces.map((s) => s.includes(canary))).toEqual([false, false, false]);
	});
});
