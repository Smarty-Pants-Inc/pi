import { cpSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai/utils/overflow";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { assertContextFitsWindow, estimateTokens } from "../../src/core/compaction/compaction.ts";
import { SessionManager, type SessionMessageEntry } from "../../src/core/session-manager.ts";
import { UNSENT_INPUT_TYPE } from "../../src/core/unsent-input.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function overflow() {
	const response = fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
	response.recovery = { recovery: "context_length_exceeded", retryable: false };
	return response;
}

function resultTool(name: string, text: string): AgentTool {
	return {
		name,
		label: name,
		description: "Returns retained context for the overflow regression",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text }], details: {} }),
	};
}

// smarty-dev#19998: use the actual AgentSession/ModelRuntime/provider loop, not recovery method doubles.
describe("AgentSession native tool-result context repair", () => {
	const harnesses: Harness[] = [];
	const runtimes: AgentSessionRuntime[] = [];
	afterEach(async () => {
		while (runtimes.length) await runtimes.pop()?.dispose({ operatorExit: true });
		while (harnesses.length) {
			const h = harnesses.pop()!;
			// Optional private evidence capture, before the harness removes its synthetic journal.
			const traceDir = process.env.PI337_F1_TRACE_DIR;
			if (traceDir) cpSync(h.tempDir, join(traceDir, basename(h.tempDir)), { recursive: true });
			await h.cleanup();
		}
	});

	async function createRecoveredRequest(payload: string, contextWindow = 1_000_000) {
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow, maxTokens: 100 }],
			settings: {
				retry: { enabled: false },
				compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 },
			},
		});
		harnesses.push(h);
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime: h.modelRuntime,
				settingsManager: h.settingsManager,
				resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: h.getModel(),
					noTools: "all",
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: h.tempDir,
			agentDir: h.tempDir,
			sessionManager: SessionManager.create(h.tempDir, join(h.tempDir, "initial")),
		});
		runtimes.push(runtime);
		await runtime.session.bindExtensions({});
		const manager = SessionManager.create(h.tempDir, join(h.tempDir, "recovered"));
		manager.appendModelChange(h.getModel().provider, h.getModel().id);
		manager.appendMessage({ role: "user", content: "previous completed request", timestamp: Date.now() - 10_000 });
		manager.appendMessage(fauxAssistantMessage("previous completed answer", { timestamp: Date.now() - 9_000 }));
		const message = { role: "user" as const, content: payload, timestamp: Date.now() };
		const outboxId = manager.appendCustomEntry(UNSENT_INPUT_TYPE, {
			mode: "steer",
			message,
			origin: { sessionId: manager.getSessionId(), host: hostname(), uid: userInfo().uid },
		});
		const file = manager.getSessionFile()!;
		const savedPrefix = readFileSync(file);
		await expect(runtime.switchSession(file)).resolves.toEqual({ cancelled: false });
		await runtime.session.bindExtensions({});
		const events: Harness["events"] = [];
		runtime.session.subscribe((event) => events.push(event));
		// Native receiver/bootstrap discovers the outbox without submitting it or forging a delivery link.
		expect(runtime.session.recoveredInputCount).toBe(1);
		expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
		expect(h.faux.state.callCount).toBe(0);
		return { h, runtime, message, outboxId, file, savedPrefix, events };
	}

	// PR #337 F1; keep reason: fitting evidence and accepted-input data safety through the real recovery caller.
	it("preserves a necessary fitting 2 KiB tool result after a length-only output stop", async () => {
		const instruction = "Read the deployment evidence and report the exact deployment code from its final line.";
		const payload = `${"necessary evidence\n".repeat(120)}deployment-code=F1-TOOL-KEEP`;
		const h = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: {
				retry: { enabled: false },
				compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 },
			},
			tools: [resultTool("deployment_evidence", payload)],
		});
		harnesses.push(h);
		const requests: AgentMessage[][] = [];
		let rawPrefix = Buffer.alloc(0);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("deployment_evidence", {}), { stopReason: "toolUse" }),
			(context) => {
				requests.push(structuredClone(context.messages));
				rawPrefix = readFileSync(h.session.sessionFile!);
				return fauxAssistantMessage("Deployment code:", { stopReason: "length" });
			},
			(context) => {
				requests.push(structuredClone(context.messages));
				return fauxAssistantMessage(
					context.messages.some((message) => getMessageText(message) === payload)
						? "F1-TOOL-KEEP"
						: "UNANSWERABLE: necessary tool evidence was removed",
				);
			},
			fauxAssistantMessage("must not dispatch a second recovery"),
		]);

		await h.session.prompt(instruction);

		const entries = h.sessionManager.getEntries();
		const stopped = entries.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "length",
		);
		if (!stopped || stopped.type !== "message" || stopped.message.role !== "assistant")
			throw new Error("Missing actual length-stop response");
		expect(stopped.message.errorMessage).toBeUndefined();
		expect(stopped.message.usage.output).toBeGreaterThan(0);
		expect(stopped.message.usage.output).toBeLessThan(h.getModel().maxTokens);
		expect(isContextOverflow(stopped.message, h.getModel().contextWindow)).toBe(false);
		expect(isRecoverableLength(stopped.message, h.getModel().maxTokens)).toBe(true);
		expect(Buffer.byteLength(payload)).toBeGreaterThan(2 * 1024);
		expect(Buffer.byteLength(payload)).toBeLessThan(3 * 1024);
		expect(() => assertContextFitsWindow(requests[0], h.getModel())).not.toThrow();
		expect(requests[0].reduce((tokens, message) => tokens + estimateTokens(message), 0)).toBeLessThan(10_000);
		expect(h.faux.state.callCount).toBeGreaterThanOrEqual(2);
		expect(h.faux.state.callCount).toBeLessThanOrEqual(3);
		expect(
			h.eventsOfType("compaction_start").filter((event) => event.reason === "overflow").length,
		).toBeLessThanOrEqual(1);
		expect(h.session.isIdle).toBe(true);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		expect(entries.filter((entry) => entry.type === "compaction")).toEqual([]);
		const rawResult = entries.find(
			(entry): entry is SessionMessageEntry & { message: ToolResultMessage } =>
				entry.type === "message" && entry.message.role === "toolResult",
		);
		if (!rawResult || rawResult.type !== "message") throw new Error("Missing raw tool result");
		expect(getMessageText(rawResult.message)).toBe(payload);
		expect(readFileSync(h.session.sessionFile!).subarray(0, rawPrefix.length).equals(rawPrefix)).toBe(true);
		const reopened = SessionManager.open(h.session.sessionFile!);
		expect(reopened.getEntry(rawResult.id)).toEqual(rawResult);
		for (const request of requests)
			expect(request.filter((message) => message.role === "user").map(getMessageText)).toContain(instruction);
		const projectedResult = reopened
			.buildSessionProjection()
			.messages.find((message) => message.role === "toolResult");
		// This is the causal F1 assertion: raw retention does not excuse erasing a fitting model-visible result.
		expect.soft(projectedResult?.content).toEqual(rawResult.message.content);
		for (const request of requests)
			expect.soft(request.filter((message) => message.role === "toolResult").map(getMessageText)).toContain(payload);
		expect
			.soft(entries.filter((entry) => entry.type === "context_edit" && entry.targetId === rawResult.id))
			.toEqual([]);
	});

	it("preserves a necessary fitting 2 KiB recovered user instruction after a length-only output stop", async () => {
		const payload = `Use only the attached rules. ${"mandatory rule; ".repeat(135)}Return exactly F1-USER-KEEP, not a summary.`;
		const { h, runtime, message, outboxId, file, savedPrefix, events } = await createRecoveredRequest(payload);
		const requests: AgentMessage[][] = [];
		let rawPrefix = Buffer.alloc(0);
		h.setResponses([
			(context) => {
				requests.push(structuredClone(context.messages));
				rawPrefix = readFileSync(file);
				return fauxAssistantMessage("Following the rules:", { stopReason: "length" });
			},
			(context) => {
				requests.push(structuredClone(context.messages));
				return fauxAssistantMessage(
					context.messages.some((input) => getMessageText(input) === payload)
						? "F1-USER-KEEP"
						: "UNANSWERABLE: accepted user instruction was removed",
				);
			},
			fauxAssistantMessage("must not dispatch a second recovery"),
		]);

		await runtime.session.resumeUnsentInputs();

		const entries = runtime.session.sessionManager.getEntries();
		const stopped = entries.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "length",
		);
		if (!stopped || stopped.type !== "message" || stopped.message.role !== "assistant")
			throw new Error("Missing actual length-stop response");
		expect(stopped.message.errorMessage).toBeUndefined();
		expect(stopped.message.usage.output).toBeGreaterThan(0);
		expect(stopped.message.usage.output).toBeLessThan(h.getModel().maxTokens);
		expect(isContextOverflow(stopped.message, h.getModel().contextWindow)).toBe(false);
		expect(isRecoverableLength(stopped.message, h.getModel().maxTokens)).toBe(true);
		expect(Buffer.byteLength(payload)).toBeGreaterThan(2 * 1024);
		expect(Buffer.byteLength(payload)).toBeLessThan(3 * 1024);
		expect(estimateTokens(message)).toBeLessThan(1_000);
		expect(() => assertContextFitsWindow(requests[0], h.getModel())).not.toThrow();
		expect(requests[0].filter((input) => input.role === "user").map(getMessageText)).toContain(payload);
		expect(h.faux.state.callCount).toBeGreaterThanOrEqual(1);
		expect(h.faux.state.callCount).toBeLessThanOrEqual(2);
		expect(
			events.filter((event) => event.type === "compaction_start" && event.reason === "overflow").length,
		).toBeLessThanOrEqual(1);
		expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(1);
		expect(runtime.session.recoveredInputCount).toBe(0);
		expect(runtime.session.pendingMessageCount).toBe(0);
		expect(runtime.session.isIdle).toBe(true);
		expect(entries.filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(entries.filter((entry) => entry.unsentInputId === outboxId)).toHaveLength(1);
		const delivered = entries.find((entry) => entry.unsentInputId === outboxId);
		if (!delivered || delivered.type !== "message") throw new Error("Missing native recovered-input delivery");
		expect(delivered.message).toEqual(message);
		expect(rawPrefix.length).toBeGreaterThan(savedPrefix.length);
		expect(readFileSync(file).subarray(0, rawPrefix.length).equals(rawPrefix)).toBe(true);
		const reopened = SessionManager.open(file);
		expect(reopened.getEntry(delivered.id)).toEqual(delivered);
		expect(reopened.getEntry(outboxId)).toEqual(entries.find((entry) => entry.id === outboxId));
		const projectedUser = reopened
			.buildSessionProjection()
			.messages.find(
				(input): input is UserMessage => input.role === "user" && input.timestamp === message.timestamp,
			);
		expect.soft(projectedUser?.content).toEqual(payload);
		for (const request of requests)
			expect.soft(request.filter((input) => input.role === "user").map(getMessageText)).toContain(payload);
		expect
			.soft(entries.filter((entry) => entry.type === "context_edit" && entry.targetId === delivered.id))
			.toEqual([]);
	});

	// PR #337 F1 counter: a real provider rejection below the advertised window must remain repairable.
	it.each([false, true])(
		"still repairs a below-cap tool after actual provider overflow (repeat failure: %s)",
		async (repeat) => {
			const payload = `provider-rejected evidence:${"x".repeat(2 * 1024)}`;
			const instruction = "Read the evidence and answer the original request after recovery.";
			const h = await createHarness({
				persistSession: true,
				models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
				settings: {
					retry: { enabled: false },
					compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 },
				},
				tools: [resultTool("rejected_evidence", payload)],
			});
			harnesses.push(h);
			let rawPrefix = Buffer.alloc(0);
			let retry: AgentMessage[] = [];
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("rejected_evidence", {}), { stopReason: "toolUse" }),
				(context) => {
					expect(() => assertContextFitsWindow(context.messages, h.getModel())).not.toThrow();
					expect(context.messages.some((message) => getMessageText(message) === payload)).toBe(true);
					rawPrefix = readFileSync(h.session.sessionFile!);
					return overflow();
				},
				(context) => {
					retry = structuredClone(context.messages);
					return repeat ? overflow() : fauxAssistantMessage("below-cap provider overflow answered");
				},
				fauxAssistantMessage("must not dispatch a second recovery"),
			]);

			await h.session.prompt(instruction);

			expect(h.faux.state.callCount).toBe(3);
			expect(h.getPendingResponseCount()).toBe(1);
			expect(h.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(1);
			expect(h.session.isIdle).toBe(true);
			expect(h.eventsOfType("agent_settled").at(-1)?.outcome).toBe(repeat ? "error" : "completed");
			if (repeat)
				expect(h.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain(
					"after one compact-and-retry attempt",
				);
			else expect(h.session.getLastAssistantText()).toBe("below-cap provider overflow answered");
			expect(retry.filter((message) => message.role === "user").map(getMessageText)).toContain(instruction);
			expect(JSON.stringify(retry)).not.toContain(payload);
			const entries = h.sessionManager.getEntries();
			const raw = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
			if (!raw || raw.type !== "message") throw new Error("Missing raw provider-rejected result");
			expect(getMessageText(raw.message)).toBe(payload);
			expect(JSON.stringify(retry)).toContain(`raw session entry ${raw.id}`);
			expect(entries.filter((entry) => entry.type === "context_edit" && entry.targetId === raw.id)).toHaveLength(1);
			expect(entries.filter((entry) => entry.type === "compaction")).toEqual([]);
			expect(readFileSync(h.session.sessionFile!).subarray(0, rawPrefix.length).equals(rawPrefix)).toBe(true);
		},
	);

	it.each([
		{ contextWindow: 1_000_000, repeat: false },
		{ contextWindow: 1_000_000, repeat: true },
		{ contextWindow: 60_000, repeat: false },
		{ contextWindow: 60_000, repeat: true },
	])(
		"still repairs a 300 KiB recovered request on actual overflow ($contextWindow-token window; repeat failure: $repeat)",
		async ({ contextWindow, repeat }) => {
			const payload = `accepted original instruction:${"x".repeat(300 * 1024)}`;
			const { h, runtime, message, outboxId, file, savedPrefix, events } = await createRecoveredRequest(
				payload,
				contextWindow,
			);
			let rawPrefix = Buffer.alloc(0);
			const requests: AgentMessage[][] = [];
			h.setResponses([
				(context) => {
					requests.push(structuredClone(context.messages));
					rawPrefix = readFileSync(file);
					return contextWindow === 1_000_000 || repeat
						? overflow()
						: fauxAssistantMessage("accepted input answered after local admission repair");
				},
				(context) => {
					requests.push(structuredClone(context.messages));
					return repeat ? overflow() : fauxAssistantMessage("accepted input answered after provider repair");
				},
				fauxAssistantMessage("must not dispatch a second recovery"),
			]);

			await runtime.session.resumeUnsentInputs();

			expect(h.faux.state.callCount).toBe(contextWindow === 1_000_000 ? 2 : 1);
			expect(h.getPendingResponseCount()).toBe(contextWindow === 1_000_000 ? 1 : 2);
			expect(
				events.filter((event) => event.type === "compaction_start" && event.reason === "overflow"),
			).toHaveLength(1);
			expect(events.filter((event) => event.type === "agent_settled").at(-1)).toMatchObject({
				outcome: repeat ? "error" : "completed",
			});
			expect(runtime.session.isIdle).toBe(true);
			expect(runtime.session.recoveredInputCount).toBe(0);
			expect(runtime.session.pendingMessageCount).toBe(0);
			const entries = runtime.session.sessionManager.getEntries();
			const raw = entries.find((entry) => entry.unsentInputId === outboxId);
			if (!raw || raw.type !== "message") throw new Error("Missing raw recovered instruction");
			expect(raw.message).toEqual(message);
			expect(entries.filter((entry) => entry.unsentInputId === outboxId)).toHaveLength(1);
			expect(entries.filter((entry) => entry.type === "context_edit" && entry.targetId === raw.id)).toHaveLength(1);
			expect(entries.filter((entry) => entry.type === "compaction")).toEqual([]);
			if (contextWindow === 1_000_000) {
				expect(estimateTokens(message)).toBeLessThan(contextWindow);
				expect(() => assertContextFitsWindow(requests[0], h.getModel())).not.toThrow();
				expect(requests[0].some((input) => getMessageText(input) === payload)).toBe(true);
			} else {
				expect(estimateTokens(message)).toBeGreaterThan(contextWindow);
				expect(
					entries.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							/^Context exceeds window: estimated \d+ input tokens, window 60000\./.test(
								entry.message.errorMessage ?? "",
							),
					),
				).toBe(true);
			}
			expect(JSON.stringify(requests.at(-1))).not.toContain(payload);
			expect(JSON.stringify(requests.at(-1))).toContain(`raw session entry ${raw.id}`);
			if (repeat) {
				expect(runtime.session.getLastAssistantText()).toBeUndefined();
				expect(events.filter((event) => event.type === "compaction_end").at(-1)).toMatchObject({
					errorMessage: expect.stringContaining("after one compact-and-retry attempt"),
					willRetry: false,
				});
				expect(
					entries.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.stopReason === "error",
					),
				).toHaveLength(2);
			} else expect(runtime.session.getLastAssistantText()).toContain("accepted input answered after");
			expect(readFileSync(file).subarray(0, savedPrefix.length).equals(savedPrefix)).toBe(true);
			expect(readFileSync(file).subarray(0, rawPrefix.length).equals(rawPrefix)).toBe(true);
			const reopened = SessionManager.open(file);
			expect(reopened.getEntry(raw.id)).toEqual(raw);
			expect(reopened.getEntry(outboxId)).toEqual(entries.find((entry) => entry.id === outboxId));
			expect(JSON.stringify(reopened.buildSessionProjection().messages)).not.toContain(payload);
		},
	);

	it("answers after a 3 MiB provider overflow even when the repaired short history needs no summary", async () => {
		const payload = `giant-raw-tool-reply:${"x".repeat(3 * 1024 * 1024)}`;
		const h = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 } },
			tools: [resultTool("giant_reply", payload)],
		});
		harnesses.push(h);
		let rawPrefix = Buffer.alloc(0);
		let retry: AgentMessage[] = [];
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("giant_reply", {}), { stopReason: "toolUse" }),
			(context) => {
				expect(context.messages.some((message) => getMessageText(message) === payload)).toBe(true);
				rawPrefix = readFileSync(h.session.sessionFile!);
				return overflow();
			},
			(context) => {
				retry = structuredClone(context.messages);
				return fauxAssistantMessage("answered after native repair");
			},
		]);

		await h.session.prompt("Run the giant tool and answer this request.");

		expect(h.faux.state.callCount).toBe(3);
		expect(h.session.getLastAssistantText()).toBe("answered after native repair");
		expect(h.session.isIdle).toBe(true);
		expect(h.getPendingResponseCount()).toBe(0);
		const file = h.session.sessionFile!;
		expect(rawPrefix.byteLength).toBeGreaterThan(3 * 1024 * 1024);
		expect(readFileSync(file).subarray(0, rawPrefix.length).equals(rawPrefix)).toBe(true);
		const rawResult = h.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		if (!rawResult || rawResult.type !== "message" || rawResult.message.role !== "toolResult")
			throw new Error("Missing raw tool result");
		expect(getMessageText(rawResult.message)).toBe(payload);
		const bytes = Buffer.byteLength(JSON.stringify(rawResult.message.content), "utf8");
		const resultText = retry
			.filter((message) => message.role === "toolResult")
			.map(getMessageText)
			.join("\n");
		expect(resultText).toContain(`${bytes} UTF-8 bytes`);
		expect(resultText).toContain(rawResult.id);
		expect(JSON.stringify(retry)).not.toContain(payload);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(h.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({ reason: "overflow", aborted: false, willRetry: true }),
		);

		const reopened = SessionManager.open(file);
		expect(readFileSync(file).subarray(0, rawPrefix.length).equals(rawPrefix)).toBe(true);
		expect(
			reopened
				.buildSessionProjection()
				.messages.filter((message) => message.role === "toolResult")
				.map(getMessageText)
				.join("\n"),
		).toBe(resultText);
		expect(JSON.stringify(reopened.buildSessionProjection().messages)).not.toContain(payload);
		expect(reopened.getEntry(rawResult.id)).toEqual(rawResult);
	});

	it("repairs multiple oversized results largest first using UTF-8 bytes and keeps a small result", async () => {
		const texts = {
			unicode_reply: "🙂".repeat(300_000),
			largest_reply: "z".repeat(2_000_000),
			small_reply: "normal small result",
		};
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 } },
			tools: Object.entries(texts).map(([name, text]) => resultTool(name, text)),
		});
		harnesses.push(h);
		let retry: AgentMessage[] = [];
		h.setResponses([
			fauxAssistantMessage(
				Object.keys(texts).map((name) => fauxToolCall(name, {})),
				{ stopReason: "toolUse" },
			),
			overflow(),
			(context) => {
				retry = structuredClone(context.messages);
				return fauxAssistantMessage("multiple results repaired");
			},
		]);

		await h.session.prompt("Run all three tools, then answer.");

		expect(h.session.getLastAssistantText()).toBe("multiple results repaired");
		const entries = h.sessionManager.getEntries();
		const rawResults = entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		const editedIds = entries.flatMap((entry) =>
			entry.type === "context_edit" && rawResults.some((raw) => raw.id === entry.targetId) ? [entry.targetId] : [],
		);
		const idsByName = new Map(
			rawResults.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" ? [[entry.message.toolName, entry.id]] : [],
			),
		);
		expect(editedIds).toEqual([idsByName.get("largest_reply"), idsByName.get("unicode_reply")]);
		expect(retry.some((message) => getMessageText(message) === texts.small_reply)).toBe(true);
		const unicode = retry.find((message) => message.role === "toolResult" && message.toolName === "unicode_reply");
		if (!unicode) throw new Error("Missing projected Unicode result");
		expect(getMessageText(unicode)).toContain(
			`${Buffer.byteLength(JSON.stringify([{ type: "text", text: texts.unicode_reply }]), "utf8")} UTF-8 bytes`,
		);
		expect(JSON.stringify(retry)).not.toContain(texts.largest_reply);
		expect(JSON.stringify(retry)).not.toContain(texts.unicode_reply);
		expect(h.faux.state.callCount).toBe(3);
	});

	it("proactively repairs an oversized tool result before threshold planning without needing a summary", async () => {
		const payload = "x".repeat(9_000);
		let summaries = 0;
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [resultTool("large_reply", payload)],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => {
						summaries++;
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("large_reply", {}), { stopReason: "toolUse" }),
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain(payload);
				expect(JSON.stringify(context.messages)).toContain("Tool result omitted from model context");
				return fauxAssistantMessage("answered without a summary");
			},
		]);

		await h.session.prompt("run the large tool");

		expect(h.faux.state.callCount).toBe(2);
		expect(h.session.getLastAssistantText()).toBe("answered without a summary");
		expect(summaries).toBe(0);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(1);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("caps retained results before ordinary manual compaction planning", async () => {
		const payload = `oversized-retained-result:${"x".repeat(3 * 1024 * 1024)}`;
		let planned = "";
		const h = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						planned = JSON.stringify(event.preparation);
						return {
							compaction: {
								summary: "bounded native context",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(h);
		const now = Date.now() - 10_000;
		h.sessionManager.appendMessage({ role: "user", content: "old request", timestamp: now });
		const call = fauxToolCall("read", {});
		h.sessionManager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse", timestamp: now + 1 }));
		const id = h.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: "read",
			content: [{ type: "text", text: payload }],
			isError: false,
			timestamp: now + 2,
		});
		h.sessionManager.appendMessage(fauxAssistantMessage("completed old request", { timestamp: now + 3 }));
		h.sessionManager.appendMessage({ role: "user", content: "keep this request", timestamp: now + 4 });
		h.session.agent.state.messages = h.sessionManager.buildSessionProjection().messages;
		const prefix = readFileSync(h.session.sessionFile!);

		await h.session.compact();

		expect(planned).not.toContain(payload);
		expect(planned).toContain(`raw session entry ${id}`);
		expect(h.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "context_edit", targetId: id }),
		);
		expect(readFileSync(h.session.sessionFile!).subarray(0, prefix.length).equals(prefix)).toBe(true);
	});

	it.each(["during repair", "completion"] as const)(
		"does not retry a repaired context cancelled at %s",
		async (phase) => {
			const h = await createHarness({
				models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
				settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 } },
				tools: [resultTool("giant_reply", "x".repeat(3 * 1024 * 1024))],
			});
			harnesses.push(h);
			h.session.subscribe((event) => {
				if (
					(phase === "during repair" &&
						event.type === "entry_appended" &&
						event.entry.type === "context_edit" &&
						JSON.stringify(event.entry).includes("Tool result omitted")) ||
					(phase === "completion" && event.type === "compaction_end" && !event.aborted)
				)
					h.session.abortCompaction();
			});
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("giant_reply", {}), { stopReason: "toolUse" }),
				overflow(),
				fauxAssistantMessage("must not retry"),
			]);

			await h.session.prompt("run the tool");

			expect(h.faux.state.callCount).toBe(2);
			expect(h.getPendingResponseCount()).toBe(1);
			if (phase === "during repair")
				expect(h.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "overflow", aborted: true });
			expect(h.eventsOfType("agent_settled").at(-1)).toMatchObject({ outcome: "aborted", aborted: true });
			expect(h.session.isIdle).toBe(true);
		},
	);

	it("spends only the existing single retry and preserves accepted input on repeated overflow", async () => {
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 } },
			tools: [resultTool("giant_reply", "x".repeat(3 * 1024 * 1024))],
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("giant_reply", {}), { stopReason: "toolUse" }),
			overflow(),
			async () => {
				await h.session.followUp("distinct accepted input waiting after failure");
				return overflow();
			},
			fauxAssistantMessage("must not dispatch a second recovery"),
		]);

		await h.session.prompt("run the tool");

		expect(h.faux.state.callCount).toBe(3);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(1);
		expect(h.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain("after one compact-and-retry attempt");
		expect(h.session.getFollowUpMessages()).toEqual(["distinct accepted input waiting after failure"]);
		expect(h.session.agent.hasQueuedMessages()).toBe(true);
		expect(h.session.isIdle).toBe(true);
	});
});
