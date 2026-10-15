import { readFileSync } from "node:fs";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { AgentSessionRuntime, type AgentSessionServices } from "../../../src/core/agent-session-runtime.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { receiveInput } from "../../../src/core/received-input.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { UNSENT_INPUT_TYPE, type UnsentInput } from "../../../src/core/unsent-input.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// #QUITBUSY / smarty-dev#13108: data-safety and cancellation paths use real sessions, no internal stubs.
describe("operator exit and compaction settlement", () => {
	const harnesses: Harness[] = [];
	const extraSessions: AgentSession[] = [];
	const releases: Array<() => void> = [];
	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		for (const session of [...extraSessions.splice(0), ...harnesses.map((h) => h.session)]) {
			if (session.isDisposed) continue;
			session.cancelForShutdown();
			await session.abort();
			session.clearQueue();
			session.dispose();
		}
		// Deliberately retain fixture directories: this lane is not authorized to execute deletion.
		for (const h of harnesses.splice(0)) h.faux.unregister();
	});

	it.each(["manual", "automatic", "completion"] as const)(
		"Escape cancels %s compaction and the next prompt works",
		async (mode) => {
			const entered = gate();
			const held = gate();
			releases.push(held.resolve);
			const h = await createHarness({
				models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 100 }],
				settings: {
					compaction: { enabled: mode !== "manual", reserveTokens: 10_000, keepRecentTokens: 1 },
					retry: { enabled: false },
				},
				tools: [
					{
						name: "large",
						label: "large",
						description: "large result",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "x".repeat(50_000) }], details: {} }),
					},
				],
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							entered.resolve();
							if (mode !== "completion") await held.promise;
							return {
								compaction: {
									summary: "summary",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			harnesses.push(h);
			if (mode !== "completion") {
				h.setResponses([fauxAssistantMessage("original")]);
				await h.session.prompt("original input");
			} else h.setResponses([fauxAssistantMessage(fauxToolCall("large", {}), { stopReason: "toolUse" })]);
			if (mode === "completion")
				h.session.subscribe((event) => {
					if (event.type === "compaction_end" && event.result) h.session.abortCompaction();
				});
			// A large new user message crosses the threshold only after admission: pre-response, not post-run.
			const run = (
				mode === "manual"
					? h.session.compact()
					: h.session.prompt(mode === "automatic" ? "large input ".repeat(6000) : "use large")
			).catch((error: unknown) => error);
			await entered.promise;
			if (mode !== "completion") h.session.abortCompaction();
			await run;
			await h.session.waitForIdle();
			expect(h.session.isIdle).toBe(true);
			expect(h.session.state.streamingMessage).toBeUndefined();
			expect(h.session.state.isStreaming).toBe(false);
			if (mode !== "manual")
				expect(h.eventsOfType("agent_settled").at(-1)).toMatchObject({ outcome: "aborted", aborted: true });
			held.resolve();
			h.settingsManager.applyOverrides({ compaction: { enabled: false } });
			h.setResponses([fauxAssistantMessage("next reply")]);
			await h.session.prompt("next prompt");
			expect(h.session.getLastAssistantText()).toBe("next reply");
			expect(h.session.isIdle).toBe(true);
		},
	);

	it("replay preserves extension metadata identity and an admitted input", async () => {
		const entered = gate();
		const held = gate();
		releases.push(held.resolve);
		let receipt: Promise<unknown> | undefined;
		const h = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "request") {
							receipt = pi.sendUserMessage("extension payload", { metadata: { kind: "retained" } });
							void receipt.catch(() => {});
							return { action: "handled" };
						}
						if (event.text === "extension payload") {
							entered.resolve();
							await held.promise;
						}
					});
				},
			],
		});
		harnesses.push(h);
		await h.session.prompt("request");
		await entered.promise;
		const release = h.session.prepareOperatorExit();
		h.session.cancelForShutdown();
		await h.session.abort();
		release();
		await expect(receipt).rejects.toThrow("INPUT_ADMISSION_ABORTED");
		h.session.dispose();
		const saved = SessionManager.open(h.sessionManager.getSessionFile()!);
		const outbox = saved
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
		expect(outbox?.type).toBe("custom");
		if (outbox?.type !== "custom") throw new Error("missing outbox");
		const input = outbox.data as UnsentInput;
		expect(input.metadata).toEqual({ kind: "retained" });
		expect(input.metadataSource?.kind).toBe("extension");
		const resumed = new AgentSession({
			agent: new Agent({ streamFn: streamSimple, convertToLlm, initialState: { model: h.getModel(), tools: [] } }),
			sessionManager: saved,
			settingsManager: h.settingsManager,
			modelRuntime: h.modelRuntime,
			resourceLoader: h.resourceLoader,
			cwd: h.tempDir,
		});
		extraSessions.push(resumed);
		h.setResponses([fauxAssistantMessage("reply")]);
		await resumed.resumeUnsentInputs();
		const delivered = saved.getEntries().find((entry) => entry.unsentInputId === outbox.id);
		expect(delivered?.type).toBe("message");
		if (delivered?.type !== "message") throw new Error("missing delivery");
		expect(delivered.metadata).toEqual(input.metadata);
		expect(delivered.metadataSource).toEqual(input.metadataSource);
		expect(delivered.provenance).toEqual(input.provenance);
	});

	// smarty-dev#13108: --no-session requires explicit consent, never creates a session file.
	it("nonpersistent operator exit retains queued input until explicit discard consent", async () => {
		const h = await createHarness({ persistSession: false, settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		const entered = gate();
		h.setResponses([
			async (_context, options) => {
				entered.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);
		const run = h.session.prompt("active");
		await entered.promise;
		await h.session.steer("keep steer");
		await h.session.followUp("keep follow-up");
		const services: AgentSessionServices = {
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.modelRuntime,
			settingsManager: h.settingsManager,
			resourceLoader: h.resourceLoader,
			diagnostics: [],
		};
		const runtime = new AgentSessionRuntime(h.session, services, async () => {
			throw new Error("replacement must refuse before construction");
		});
		const queued = h.session.agent.getQueuedMessages();
		await expect(runtime.dispose({ operatorExit: true })).rejects.toThrow(
			"2 queued messages are not saved (no session file). /quit again to discard them and exit.",
		);
		expect(h.session.agent.getQueuedMessages()).toEqual(queued);
		expect(h.session.isDisposed).toBe(false);
		expect(h.session.shutdownSignal.aborted).toBe(false);
		expect(h.sessionManager.isPersisted()).toBe(false);
		expect(h.sessionManager.getSessionFile()).toBeUndefined();
		await expect(runtime.newSession()).rejects.toThrow("INPUT_ADMISSION_BUSY");
		await expect(runtime.switchSession("missing")).rejects.toThrow("INPUT_ADMISSION_BUSY");
		await expect(runtime.dispose()).rejects.toThrow("INPUT_ADMISSION_BUSY");
		await expect(runtime.dispose({ discardUnsentInput: true })).rejects.toThrow("INPUT_ADMISSION_BUSY");
		await runtime.dispose({ operatorExit: true, discardUnsentInput: true });
		await run;
		expect(h.session.isDisposed).toBe(true);
		expect(h.session.agent.getQueuedMessages()).toEqual([]);
		expect(h.sessionManager.getSessionFile()).toBeUndefined();
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
		).toEqual([]);
	});

	it("operator exit saves steer/follow-up/images/duplicate text and resume consumes each once", async () => {
		const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		const entered = gate();
		h.setResponses([
			async (_context, options) => {
				entered.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);
		const run = h.session.prompt("active");
		await entered.promise;
		const image = { type: "image" as const, mimeType: "image/png", data: "original-image-bytes" };
		await h.session.steer("duplicate", [image]);
		await h.session.followUp("duplicate");
		await h.session.sendCustomMessage(
			{ customType: "aside", content: "next context", display: true },
			{ deliverAs: "nextTurn" },
		);
		const staged = receiveInput("mode pending", [image]);
		let pending = true;
		await h.session.bindExtensions({
			getPendingInputs: () => (pending ? [{ input: staged, mode: "followUp" }] : []),
			clearPendingInputs: () => {
				pending = false;
			},
			hasPendingInput: () => pending,
		});
		const services: AgentSessionServices = {
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.modelRuntime,
			settingsManager: h.settingsManager,
			resourceLoader: h.resourceLoader,
			diagnostics: [],
		};
		const runtime = new AgentSessionRuntime(h.session, services, async () => {
			throw new Error("replacement must refuse before construction");
		});
		await expect(runtime.newSession()).rejects.toThrow("INPUT_ADMISSION_BUSY");
		await expect(runtime.switchSession("missing")).rejects.toThrow("INPUT_ADMISSION_BUSY");
		await expect(runtime.dispose()).rejects.toThrow("INPUT_ADMISSION_BUSY");
		await runtime.dispose({ operatorExit: true });
		await run;
		expect(h.session.isDisposed).toBe(true);
		const file = h.sessionManager.getSessionFile()!;
		const saved = SessionManager.open(file);
		expect(
			saved.getEntries().filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
		).toHaveLength(4);
		expect(
			saved
				.buildSessionContext()
				.messages.filter((message) => message.role === "user")
				.map(getMessageText),
		).toEqual(["active"]);
		const resumed = new AgentSession({
			agent: new Agent({ streamFn: streamSimple, convertToLlm, initialState: { model: h.getModel(), tools: [] } }),
			sessionManager: saved,
			settingsManager: h.settingsManager,
			modelRuntime: h.modelRuntime,
			resourceLoader: h.resourceLoader,
			cwd: h.tempDir,
		});
		extraSessions.push(resumed);
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		await resumed.resumeUnsentInputs();
		expect(resumed.isIdle).toBe(true);
		const delivered = saved.getEntries().filter((entry) => entry.unsentInputId);
		expect(delivered).toHaveLength(4);
		expect(new Set(delivered.map((entry) => entry.unsentInputId)).size).toBe(4);
		const userEntries = saved
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user");
		expect(userEntries.map((entry) => (entry.type === "message" ? getMessageText(entry.message) : ""))).toEqual([
			"active",
			"duplicate",
			"duplicate",
			"mode pending",
		]);
		expect(readFileSync(file, "utf8")).toContain("original-image-bytes");
		for (const entry of delivered) {
			const original = saved.getEntry(entry.unsentInputId!);
			if (original?.type === "custom" && entry.type === "message")
				expect(entry.provenance).toEqual((original.data as UnsentInput).provenance);
		}
		resumed.dispose();
		const secondManager = SessionManager.open(file);
		const second = new AgentSession({
			agent: new Agent({ streamFn: streamSimple, initialState: { model: h.getModel(), tools: [] } }),
			sessionManager: secondManager,
			settingsManager: h.settingsManager,
			modelRuntime: h.modelRuntime,
			resourceLoader: h.resourceLoader,
			cwd: h.tempDir,
		});
		extraSessions.push(second);
		const before = secondManager.getEntryCount();
		await second.resumeUnsentInputs();
		expect(second.agent.hasQueuedMessages()).toBe(false);
		expect(secondManager.getEntryCount()).toBe(before);
	});
});
