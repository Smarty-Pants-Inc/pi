import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
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

function resources(): ResourceLoader {
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

const model: Model<"openai-completions"> = {
	id: "synthetic",
	name: "Synthetic",
	provider: "audit",
	api: "openai-completions",
	baseUrl: "https://mock.invalid",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};
const usage = {
	input: 7,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 9,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};
// pi#141 / security F6: completed effects must be journaled even when publication observers reject.
it.each(
	(["parallel", "sequential"] as const).flatMap((toolExecution) =>
		(["tool_execution_end", "message_start", "message_end"] as const).map((phase) => ({ toolExecution, phase })),
	),
)(
	"persists accepted native outcomes after $phase observer failure ($toolExecution)",
	async ({ toolExecution, phase }) => {
		const executed: string[] = [];
		const tool: AgentTool = {
			name: "native",
			label: "Native",
			description: "Synthetic native tool",
			parameters: Type.Object({}),
			execute: async (id) => {
				executed.push(id);
				return { content: [{ type: "text", text: `receipt:${id}` }], details: { receipt: id }, usage };
			},
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: ["a", "b"].map((id) => ({ type: "toolCall", id, name: "native", arguments: {} })),
			provider: "audit",
			model: "synthetic",
			api: "openai-completions",
			timestamp: 0,
			stopReason: "toolUse",
			usage,
		};
		const agent = new Agent({
			initialState: { model, tools: [tool] },
			toolExecution,
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "toolUse", message: structuredClone(assistant) });
				return stream;
			},
		});
		agent.finishTurn = async () => ({ action: "end" });
		const directory = mkdtempSync(join(tmpdir(), "pi-r141-native-journal-"));
		const session = SessionManager.create(directory, directory);
		let rejected = false;
		agent.subscribe(async (event) => {
			if (
				!rejected &&
				event.type === phase &&
				(phase === "tool_execution_end" || ("message" in event && event.message.role === "toolResult"))
			) {
				rejected = true;
				throw new Error("synthetic end observer failure");
			}
		});
		// Registered after the failing observer: mandatory publication must still reach the journal.
		agent.subscribe(async (event) => {
			if (
				event.type === "message_end" &&
				(event.message.role === "user" ||
					event.message.role === "assistant" ||
					event.message.role === "toolResult" ||
					event.message.role === "system")
			)
				session.appendMessage(event.message);
		});
		await agent.prompt("synthetic request");
		expect(rejected).toBe(true);
		expect(executed.length).toBeGreaterThan(0);
		const file = session.getSessionFile();
		if (!file) throw new Error("Missing test journal");
		const rows = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						message?: {
							role?: string;
							toolCallId?: string;
							details?: { receipt?: string };
							usage?: typeof usage;
							isError?: boolean;
						};
					},
			);
		for (const id of executed) {
			const row = rows.find((entry) => entry.message?.role === "toolResult" && entry.message.toolCallId === id);
			expect(row?.message).toMatchObject({ details: { receipt: id }, usage, isError: false });
			expect(
				agent.state.messages.some((message) => message.role === "toolResult" && message.toolCallId === id),
			).toBe(true);
		}
	},
);

// pi#141: a failed nested end observer must not erase its completed native usage/call summary.
it("persists completed nested outcome summaries through the actual AgentSession handler", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-r141-nested-journal-"));
	const sessionManager = SessionManager.create(directory, directory);
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	vi.spyOn(runtime, "getAuth").mockResolvedValue({ auth: { apiKey: "synthetic-auth" }, source: "runtime" });
	const response: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "parent-call", name: "parent", arguments: {} }],
		provider: "audit",
		model: "synthetic",
		api: "openai-completions",
		timestamp: 0,
		stopReason: "toolUse",
		usage,
	};
	let requests = 0;
	const agent = new Agent({
		initialState: { model },
		streamFn: () => {
			const stream = createAssistantMessageEventStream();
			const message =
				requests++ === 0 ? structuredClone(response) : { ...response, content: [], stopReason: "stop" as const };
			stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
			return stream;
		},
	});
	const settings = SettingsManager.inMemory();
	settings.setRetryEnabled(false);
	settings.setCompactionEnabled(false);
	let executions = 0;
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: settings,
		cwd: directory,
		modelRuntime: runtime,
		resourceLoader: resources(),
		baseToolsOverride: {},
		initialActiveToolNames: ["parent"],
		customTools: [
			{
				name: "parent",
				label: "Parent",
				description: "Synthetic parent",
				parameters: Type.Object({}),
				execute: async (_id, _args, _signal, _update, context) => {
					await context.executeTool("leaf", {});
					return { content: [], details: {} };
				},
			},
			{
				name: "leaf",
				label: "Leaf",
				description: "Synthetic native leaf",
				exposure: "deferred",
				parameters: Type.Object({}),
				execute: async () => {
					executions++;
					return { content: [{ type: "text", text: "accepted native leaf" }], details: {}, usage };
				},
			},
		],
	});
	let rejected = false;
	session.subscribe((event) => {
		if (!rejected && event.type === "tool_execution_end" && event.toolCallId === "parent-call") {
			rejected = true;
			throw new Error("synthetic nested end observer failure");
		}
	});
	try {
		await agent.prompt("synthetic request");
		await session.waitForIdle();
		expect(executions).toBe(1);
		expect(rejected).toBe(true);
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Missing nested journal");
		const rows = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						message?: {
							role?: string;
							toolCallId?: string;
							nestedCalls?: { calls: Array<{ name: string; status: string }> };
							usage?: typeof usage;
						};
					},
			);
		const outcome = rows.find(
			(row) => row.message?.role === "toolResult" && row.message.toolCallId === "parent-call",
		);
		expect(outcome?.message?.nestedCalls?.calls).toMatchObject([{ name: "leaf", status: "ok" }]);
		expect(outcome?.message?.usage).toEqual(usage);
	} finally {
		await session.waitForIdle();
	}
});
