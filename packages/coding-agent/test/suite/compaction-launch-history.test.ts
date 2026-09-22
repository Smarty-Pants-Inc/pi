import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, getMessageText } from "./harness.ts";

// A fresh synthetic retained journal and faux provider; never a live history,
// paid/model probe, native owner, manual compact call or Fabric hook substitute.
describe("memory-only launch compaction override", () => {
	it.each(["stop", "error", "aborted"] as const)(
		"prompts past retained %s usage without a preflight summarizer or history rewrite",
		async (stopReason) => {
			const h = await createHarness({ models: [{ id: "faux-1", contextWindow: 4096, maxTokens: 256 }] });
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
				const parsed = parseArgs(["--no-auto-compaction"]);
				if (parsed.noAutoCompaction) settings.applyOverrides({ compaction: { enabled: false } });
				const resourceLoader = h.session.resourceLoader;
				const modelRuntime = h.session.modelRuntime;
				h.session.dispose();
				h.session.agent.state.messages = reopened.buildSessionContext().messages;
				session = new AgentSession({
					agent: h.session.agent,
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
						// A preflight summary request cannot contain this not-yet-inserted prompt.
						expect(
							context.messages.some(
								(message) => message.role === "user" && getMessageText(message) === "CURRENT ACTIVATION PROMPT",
							),
						).toBe(true);
						return fauxAssistantMessage("activation ready");
					},
				]);
				await session.prompt("CURRENT ACTIVATION PROMPT");
				await settings.flush();
				expect(requests).toBe(1);
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
