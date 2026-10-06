import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool, runToolCall } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const canary = "SYNTHETIC_TOOL_SECRET_5822";
const model: Model<"openai-completions"> = {
	id: "synthetic",
	name: "Synthetic",
	provider: "openai",
	api: "openai-completions",
	baseUrl: "https://mock.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 128,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const call = { type: "toolCall" as const, id: "accepted-native", name: "native", arguments: {} };
const usage = {
	input: 7,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 9,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
// Extracted from suite/harness.ts and utilities.ts without their HOME access/removal fixtures (#4664).
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

// smarty-dev#5822 / T-R2-01: policy failure never publishes or persists the accepted native content/receipt.
it.each(["uncloneable", "rejecting", "mutating"] as const)(
	"withholds after-policy %s result through real AgentSession and JSONL",
	async (kind) => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: canary }],
			details: kind === "uncloneable" ? { receipt: canary, callback: () => canary } : { receipt: canary },
			usage: structuredClone(usage),
			terminate: true,
		}));
		const tool: AgentTool = {
			name: "native",
			label: "Native",
			description: "Synthetic",
			parameters: Type.Object({}),
			execute,
		};
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai", async () => ({ type: "api_key", key: "synthetic-key" }));
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const dir = mkdtempSync(join(tmpdir(), "s3-after-policy-"));
		const journal = SessionManager.create(dir, dir);
		const agent = new Agent({
			initialState: { model, tools: [tool] },
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				stream.push({
					type: "done",
					reason: "toolUse",
					message: {
						...fauxAssistantMessage([call], { stopReason: "toolUse" }),
						api: model.api,
						provider: model.provider,
						model: model.id,
					},
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: journal,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			cwd: dir,
			modelRuntime: runtime,
			resourceLoader,
			baseToolsOverride: { native: tool },
			initialActiveToolNames: ["native"],
		});
		const after = vi.fn(async ({ result }: { result: { content: unknown[]; details: unknown } }) => {
			if (kind === "mutating") {
				result.content.length = 0;
				(result.details as { receipt: string }).receipt = "changed";
			}
			throw new Error(canary);
		});
		agent.afterToolCall = after;
		const events: unknown[] = [];
		session.subscribe((event) => {
			events.push(event);
		});
		await session.prompt("synthetic request");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(after).toHaveBeenCalledTimes(kind === "uncloneable" ? 0 : 1);
		const file = journal.getSessionFile();
		if (!file) throw new Error("Missing persistent journal");
		const jsonl = readFileSync(file, "utf8");
		expect(JSON.stringify({ events, state: agent.state.errorMessage, jsonl })).not.toContain(canary);
		const output = session.messages.find((message) => message.role === "toolResult");
		expect(output).toMatchObject({
			content: [{ type: "text", text: "tool_result_withheld (after_policy_failed)" }],
			isError: true,
			usage,
		});
		expect(output).not.toHaveProperty("completedResult");
		expect(output?.details).toBeUndefined();
		session.dispose();
	},
);

// smarty-dev#5822 / T-R2-01: direct tool API has no public escape hatch for raw native receipt or hook error.
it("keeps accepted-effect receipt private for direct callers", async () => {
	const native = {
		content: [{ type: "text" as const, text: canary }],
		details: { receipt: canary },
		usage,
		terminate: true,
	};
	const tool: AgentTool = {
		name: "native",
		label: "Native",
		description: "Synthetic",
		parameters: Type.Object({}),
		execute: async () => native,
	};
	const outcome = await runToolCall(call, {
		tools: [tool],
		context: { messages: [], tools: [tool] },
		assistantMessage: fauxAssistantMessage([call], { stopReason: "toolUse" }),
		afterToolCall: async () => {
			throw Object.assign(new Error(canary), { receipt: canary });
		},
	});
	expect(JSON.stringify(outcome)).not.toContain(canary);
	expect(outcome).not.toHaveProperty("completedResult");
	expect(outcome.result.details).toBeUndefined();
	expect(outcome.result.usage).toEqual(usage);
	expect(native.details.receipt).toBe(canary);
	expect(outcome.publicationFailure?.error).toMatchObject({ message: "tool_result_withheld (after_policy_failed)" });
});
