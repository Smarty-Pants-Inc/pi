import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, streamSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, getMessageText } from "./harness.ts";

// A fresh synthetic retained journal and faux provider; never a live history,
// paid/model probe, native owner, manual compact call or Fabric hook substitute.
describe("memory-only launch compaction override", () => {
	it.each(
		(["stop", "error", "aborted"] as const).flatMap((stopReason) =>
			[4096, 100_000].map((contextWindow) => ({ stopReason, contextWindow })),
		),
	)(
		// #2742: disabled compaction keeps the local bound and fitting retained input.
		"preserves retained $stopReason history with a $contextWindow-token launch window",
		async ({ stopReason, contextWindow }) => {
			const h = await createHarness({ models: [{ id: "faux-1", contextWindow, maxTokens: 256 }] });
			let session: AgentSession | undefined;
			try {
				const cwd = join(h.tempDir, "project");
				const agentDir = join(h.tempDir, "agent");
				mkdirSync(join(cwd, ".pi"), { recursive: true });
				mkdirSync(agentDir);
				const globalPath = join(agentDir, "settings.json");
				const projectPath = join(cwd, ".pi", "settings.json");
				const globalBytes =
					'{\n  "compaction": {"enabled": true, "reserveTokens": 100, "keepRecentTokens": 100}\n}\n';
				const projectBytes = '{\n  "compaction": {"enabled": true}\n}\n';
				writeFileSync(globalPath, globalBytes);
				writeFileSync(projectPath, projectBytes);
				const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
				const model = h.getModel();
				const retained = SessionManager.create(cwd, join(h.tempDir, "journals"));
				for (let i = 0; i < 6; i++) {
					retained.appendMessage({
						role: "user",
						content: `retained ${i}: ${"old context ".repeat(512)}`,
						timestamp: Date.now() - 2000,
					});
					retained.appendMessage({
						...fauxAssistantMessage(`retained answer ${i}`, {
							stopReason,
							errorMessage: stopReason === "error" ? "maximum context length exceeded" : undefined,
						}),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 5000,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 5000,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					});
				}
				const path = retained.getSessionFile();
				if (!path) throw new Error("RETAINED_JOURNAL_REQUIRED");
				const history = readFileSync(path);
				const reopened = SessionManager.open(path);
				const entries = structuredClone(reopened.getEntries());
				const expectedUserTexts = [
					...reopened
						.buildSessionContext()
						.messages.filter((message) => message.role === "user")
						.map(getMessageText),
					"CURRENT ACTIVATION PROMPT",
				];
				const parsed = parseArgs(["--no-auto-compaction"]);
				if (parsed.noAutoCompaction) settings.applyOverrides({ compaction: { enabled: false } });
				const resourceLoader = h.session.resourceLoader;
				const modelRuntime = h.session.modelRuntime;
				h.session.dispose();
				// #2742: a resumed launch creates a fresh Agent, as createAgentSession does.
				// Reusing the disposed harness Agent chains hooks that still project its empty journal.
				let convertedUserTexts: string[] = [];
				const agent = new Agent({
					initialState: { model, systemPrompt: "", tools: [], messages: reopened.buildSessionContext().messages },
					getApiKey: () => "faux-key",
					streamFn: streamSimple,
					convertToLlm: (messages) => {
						const converted = convertToLlm(messages);
						convertedUserTexts = converted.filter((message) => message.role === "user").map(getMessageText);
						return converted;
					},
				});
				session = new AgentSession({
					agent,
					sessionManager: reopened,
					settingsManager: settings,
					cwd,
					resourceLoader,
					modelRuntime,
					baseToolsOverride: {},
				});
				const events: AgentSessionEvent[] = [];
				session.subscribe((event) => events.push(event));
				let requests = 0;
				h.setResponses([
					(context) => {
						requests++;
						// Fitting requests carry the complete retained user input, not a preflight summary.
						expect(context.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual(
							expectedUserTexts,
						);
						return fauxAssistantMessage("activation ready");
					},
				]);
				await session.prompt("CURRENT ACTIVATION PROMPT");
				await settings.flush();
				// Verify the provider-visible conversion retained the journal, not just a zero request count.
				expect(convertedUserTexts).toEqual(expectedUserTexts);
				const fits = contextWindow === 100_000;
				expect(requests).toBe(fits ? 1 : 0);
				expect(h.faux.state.callCount).toBe(fits ? 1 : 0);
				if (fits) expect(session.getLastAssistantText()).toBe("activation ready");
				else
					expect(session.messages.at(-1)).toMatchObject({
						role: "assistant",
						stopReason: "error",
						errorMessage: expect.stringMatching(/context exceeds window/i),
					});
				expect(
					events.filter(
						(event) => event.type === "compaction_start" || event.type === "summarization_retry_attempt_start",
					),
				).toEqual([]);
				expect(session.autoCompactionEnabled).toBe(false);
				expect(readFileSync(globalPath, "utf8")).toBe(globalBytes);
				expect(readFileSync(projectPath, "utf8")).toBe(projectBytes);
				expect(settings.getGlobalSettings().compaction?.enabled).toBe(true);
				expect(readFileSync(path).subarray(0, history.length)).toEqual(history);
				expect(reopened.getEntries().slice(0, entries.length)).toEqual(entries);
				expect(reopened.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			} finally {
				session?.dispose();
				h.cleanup();
			}
		},
	);
});
