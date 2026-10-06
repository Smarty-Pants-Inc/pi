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
// smarty-dev#5822 T-R2-06: capture application events/state and actual persisted SessionManager JSONL.
describe.each([undefined, false, true])("pi-messages journal policy=%s", (oauthDiagnostics) => {
	it.each(["done", "error", "http", "parser", "observer"] as const)("owns %s at application sinks", async (kind) => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("radius", async () => ({ type: "api_key", key: "synthetic-key" }));
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const dir = mkdtempSync(join(tmpdir(), "s3-pi-journal-"));
		const journal = SessionManager.create(dir, dir);
		const callbacks: unknown[] = [];
		const fetch = async () => {
			if (kind === "http")
				return Response.json(
					{ error: { message: `service unavailable ${canary}`, code: canary, details: { nested: canary } } },
					{ status: 503 },
				);
			if (kind === "parser") return new Response(`data: invalid-${canary}\n\n`);
			const events = [
				{ type: "start", extra: canary },
				{ type: "text_start", contentIndex: 0 },
				{ type: "text_delta", contentIndex: 0, delta: "generated" },
				{
					type: kind === "error" ? "error" : "done",
					reason: kind === "error" ? "error" : "stop",
					usage,
					responseId: canary,
					providerThinkingLevel: canary,
					errorMessage: kind === "error" ? canary : undefined,
					rewrite: { policyId: canary },
				},
			];
			return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream", "x-wire": canary },
			});
		};
		const agent = new Agent({
			initialState: { model, tools: [] },
			streamFn: (_model, ctx) =>
				stream(model, normalizeContext(ctx), {
					apiKey: "synthetic",
					oauthDiagnostics,
					fetch,
					onResponse: (...args) => {
						callbacks.push(args);
					},
					onProviderStreamEvent: (...args) => {
						callbacks.push(args);
						if (kind === "observer") throw new Error(canary);
					},
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
		session.subscribe((event) => {
			expect(JSON.stringify(event)).not.toContain(canary);
			events.push(event);
		});
		await session.prompt("synthetic request");
		const file = journal.getSessionFile();
		if (!file) throw new Error("Missing journal");
		const jsonl = readFileSync(file, "utf8");
		expect(
			JSON.stringify({ events, callbacks, messages: session.messages, state: agent.state.errorMessage, jsonl }),
		).not.toContain(canary);
		const last = session.messages.findLast((message) => message.role === "assistant");
		expect(last?.role).toBe("assistant");
		if (last?.role !== "assistant") throw new Error("Missing assistant");
		expect(last.responseId).toBeUndefined();
		expect(last.providerThinkingLevel).toBeUndefined();
		expect(last.usage).not.toHaveProperty("extra");
		expect(last.stopReason).toBe(kind === "done" ? "stop" : "error");
		session.dispose();
	});
});
