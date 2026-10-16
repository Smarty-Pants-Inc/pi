import { readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession, UnsupportedUnsentInputError } from "../../../src/core/agent-session.ts";
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
		const warnedRevision = h.session.queuedInputRevision;
		expect(typeof warnedRevision).toBe("number");
		expect(h.session.queuedInputRevision).toBe(warnedRevision);
		const updatesBeforeCustom = h.eventsOfType("queue_update").length;
		await h.session.sendCustomMessage(
			{ customType: "aside", content: "new after warning", display: true },
			{ deliverAs: "nextTurn" },
		);
		expect(h.session.queuedInputRevision).toBeGreaterThan(warnedRevision);
		expect(h.eventsOfType("queue_update").length).toBeGreaterThan(updatesBeforeCustom);
		await expect(runtime.dispose({ operatorExit: true })).rejects.toThrow("3 queued messages are not saved");
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

	// smarty-dev#13108: foreign outboxes are editor drafts, not executable restored receipts.
	it.each(["absent", "session", "host", "uid"] as const)(
		"%s origin resumes only as one-time drafts",
		async (mismatch) => {
			const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
			harnesses.push(h);
			const image = { type: "image" as const, mimeType: "image/png", data: "complete-original-bytes" };
			await h.session.followUp("full user text", [image]);
			await h.session.sendCustomMessage(
				{ customType: "aside", content: [{ type: "text", text: "full custom text" }, image], display: true },
				{ deliverAs: "nextTurn" },
			);
			const release = h.session.prepareOperatorExit();
			h.session.cancelForShutdown();
			await h.session.abort();
			release();
			h.session.dispose();
			const file = h.sessionManager.getSessionFile()!;
			const lines = readFileSync(file, "utf8")
				.trimEnd()
				.split("\n")
				.map((line) => {
					const entry: {
						type: string;
						customType?: string;
						data: {
							origin?: UnsentInput["origin"];
							provenance?: unknown;
							metadata?: unknown;
							metadataSource?: unknown;
						};
					} = JSON.parse(line);
					if (entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE) {
						if (mismatch === "absent") delete entry.data.origin;
						else if (mismatch === "session") entry.data.origin!.sessionId = "imported-session";
						else if (mismatch === "host") entry.data.origin!.host = `${hostname()}-foreign`;
						else entry.data.origin!.uid = userInfo().uid + 1;
						// A foreign attribution claim must not be converted into a fresh terminal receipt.
						entry.data.provenance = { v: 1, channel: "fabric", sender: { id: "foreign" } };
						entry.data.metadata = { untrusted: true };
						entry.data.metadataSource = { kind: "extension", id: "foreign" };
					}
					return JSON.stringify(entry);
				});
			writeFileSync(file, `${lines.join("\n")}\n`);
			const saved = SessionManager.open(file);
			let providerRequests = 0;
			h.setResponses([
				async () => {
					providerRequests++;
					return fauxAssistantMessage("must not send");
				},
			]);
			const resumed = new AgentSession({
				agent: new Agent({
					streamFn: streamSimple,
					convertToLlm,
					initialState: { model: h.getModel(), tools: [] },
				}),
				sessionManager: saved,
				settingsManager: h.settingsManager,
				modelRuntime: h.modelRuntime,
				resourceLoader: h.resourceLoader,
				cwd: h.tempDir,
			});
			extraSessions.push(resumed);
			expect(resumed.agent.getQueuedMessages()).toEqual([]);
			await resumed.resumeUnsentInputs();
			expect(providerRequests).toBe(0);
			expect(h.getPendingResponseCount()).toBe(1);
			const drafts = resumed.takeUnsentInputDrafts();
			expect(drafts).toEqual([
				{ role: "user", content: [{ type: "text", text: "full user text" }, image], timestamp: expect.any(Number) },
				{
					role: "user",
					content: [{ type: "text", text: "full custom text" }, image],
					timestamp: expect.any(Number),
				},
			]);
			expect(resumed.takeUnsentInputDrafts()).toEqual([]);
			expect(saved.getEntries().filter((entry) => entry.unsentInputId)).toEqual([]);
		},
	);

	// smarty-dev#13108: even matching origins cannot turn assistant/tool payloads into work.
	it.each(["assistant", "toolResult", "unknown", "toolCall"])("rejects unsupported outbox %s", async (kind) => {
		const h = await createHarness();
		harnesses.push(h);
		h.sessionManager.appendCustomEntry(UNSENT_INPUT_TYPE, {
			origin: { sessionId: h.sessionManager.getSessionId(), host: hostname(), uid: userInfo().uid },
			mode: "steer",
			message: {
				role: kind === "toolCall" ? "user" : kind,
				content: kind === "toolCall" ? [{ type: "toolCall", id: "bad", name: "bash", arguments: {} }] : "bad",
				timestamp: Date.now(),
			},
		});
		expect(
			() =>
				new AgentSession({
					agent: new Agent({ streamFn: streamSimple, initialState: { model: h.getModel(), tools: [] } }),
					sessionManager: h.sessionManager,
					settingsManager: h.settingsManager,
					modelRuntime: h.modelRuntime,
					resourceLoader: h.resourceLoader,
					cwd: h.tempDir,
				}),
		).toThrow("Invalid unsent input entry");
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
	});

	// smarty-dev#13108: raw SDK queue mutations also invalidate operator discard consent.
	it("queue revision observes raw native enqueue and removal without changing on reads", async () => {
		const h = await createHarness();
		harnesses.push(h);
		let revision = h.session.queuedInputRevision;
		const message = { role: "user" as const, content: "raw input", timestamp: Date.now() };
		h.session.agent.steer(message);
		expect(h.session.queuedInputRevision).toBeGreaterThan(revision);
		revision = h.session.queuedInputRevision;
		h.session.agent.removeQueuedMessages((queued) => queued === message);
		expect(h.session.queuedInputRevision).toBeGreaterThan(revision);
		revision = h.session.queuedInputRevision;
		h.session.agent.followUp(message);
		expect(h.session.queuedInputRevision).toBeGreaterThan(revision);
		revision = h.session.queuedInputRevision;
		h.session.agent.clearAllQueues();
		expect(h.session.queuedInputRevision).toBeGreaterThan(revision);
		revision = h.session.queuedInputRevision;
		expect(h.session.queuedInputRevision).toBe(revision);
		let beforeRawPersistence = -1;
		h.session.subscribe((event) => {
			if (event.type === "message_end" && event.message === message)
				beforeRawPersistence = h.session.queuedInputRevision;
		});
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		h.session.agent.followUp(message);
		await h.session.prompt("active");
		expect(beforeRawPersistence).toBeGreaterThan(0);
		expect(h.session.queuedInputRevision).toBeGreaterThan(beforeRawPersistence);
		expect(h.session.agent.getQueuedMessages()).toEqual([]);
	});

	// smarty-dev#13156 / pi#262: Agent accepts all roles, but quit must refuse unreplayable input atomically.
	it.each(
		(["steer", "followUp"] as const).flatMap((mode) =>
			(["assistant", "toolResult", "system"] as const).flatMap((role) =>
				[false, true].map((beforeAttachment) => ({ mode, role, beforeAttachment })),
			),
		),
	)("P1-B $mode refuses $role quit (pre-attached: $beforeAttachment)", async ({ mode, role, beforeAttachment }) => {
		const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		const agent = beforeAttachment
			? new Agent({ streamFn: streamSimple, convertToLlm, initialState: { model: h.getModel(), tools: [] } })
			: h.session.agent;
		if (beforeAttachment) h.session.dispose();
		const user: AgentMessage = { role: "user", content: "keep user", timestamp: 1 };
		const custom: AgentMessage = {
			role: "custom",
			customType: "keep-custom",
			content: "keep custom",
			display: true,
			details: { original: "caller metadata" },
			timestamp: 1,
		};
		const unsupported: AgentMessage =
			role === "assistant"
				? fauxAssistantMessage("keep assistant")
				: role === "toolResult"
					? {
							role,
							toolCallId: "raw-tool-call",
							toolName: "raw-tool",
							content: [{ type: "text", text: "keep tool result" }],
							isError: false,
							timestamp: 1,
						}
					: { role, content: "keep system", timestamp: 1 };
		for (const message of [user, unsupported, custom, user]) agent[mode](message);
		const session = beforeAttachment
			? new AgentSession({
					agent,
					sessionManager: h.sessionManager,
					settingsManager: h.settingsManager,
					modelRuntime: h.modelRuntime,
					resourceLoader: h.resourceLoader,
					cwd: h.tempDir,
				})
			: h.session;
		if (beforeAttachment) extraSessions.push(session);
		const runtime = new AgentSessionRuntime(
			session,
			{
				cwd: h.tempDir,
				agentDir: h.tempDir,
				modelRuntime: h.modelRuntime,
				settingsManager: h.settingsManager,
				resourceLoader: h.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("replacement must not run");
			},
		);
		const occurrences = agent.getQueuedMessageOccurrences();
		const messages = structuredClone(agent.getQueuedMessages());
		const entries = structuredClone(h.sessionManager.getEntries());
		const observations: string[] = [];
		const detach = agent.observeLifecycle((event) => observations.push(event.type));
		try {
			const failure = await runtime.dispose({ operatorExit: true }).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(UnsupportedUnsentInputError);
			expect(failure).toMatchObject({ role, mode, code: "INPUT_ADMISSION_BUSY" });
			expect(agent.getQueuedMessageOccurrences()).toEqual(occurrences);
			expect(agent.getQueuedMessages()).toEqual(messages);
			expect(agent.getQueuedMessages(mode)).toEqual([user, unsupported, custom, user]);
			expect(h.sessionManager.getEntries()).toEqual(entries);
			expect(observations).toEqual(["attached"]);
			expect(session.inputsFenced).toBe(false);
			expect(session.shutdownSignal.aborted).toBe(false);
			expect(session.isDisposed).toBe(false);
			expect(h.faux.state.callCount).toBe(0);
		} finally {
			detach();
		}
	});

	// smarty-dev#13554: refuse unreplayable batches before native listeners can half-publish them.
	it.each(
		(["steer", "followUp"] as const).flatMap((mode) =>
			(["assistant", "toolResult"] as const).flatMap((role) =>
				(["all", "one-at-a-time"] as const).flatMap((queueMode) =>
					[0, 1, 2].map((position) => ({ mode, role, queueMode, position })),
				),
			),
		),
	)("P1 active raw $mode $role $queueMode $position", async ({ mode, role, queueMode, position }) => {
		const h = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(h);
		h.session.dispose();
		const unsupported: AgentMessage =
			role === "assistant"
				? fauxAssistantMessage("raw assistant")
				: {
						role: "toolResult",
						toolCallId: "raw-call",
						toolName: "raw-tool",
						content: [{ type: "text", text: "raw result" }],
						isError: false,
						timestamp: 1,
					};
		const valid: AgentMessage[] = [
			{ role: "user", content: "valid before or after", timestamp: 1 },
			{ role: "custom", customType: "valid-aside", content: "valid custom", display: true, timestamp: 1 },
		];
		const batch = [...valid];
		batch.splice(position, 0, unsupported);
		const agent = new Agent({
			streamFn: streamSimple,
			convertToLlm,
			initialState: { model: h.getModel(), tools: [] },
			steeringMode: queueMode,
			followUpMode: queueMode,
		});
		let rawStarts = 0;
		agent.subscribe((event) => {
			if (event.type === "message_start" && event.message === unsupported) {
				rawStarts++;
				throw new Error("P1 earlier native listener rejected raw role");
			}
		});
		const session = new AgentSession({
			agent,
			sessionManager: h.sessionManager,
			settingsManager: h.settingsManager,
			modelRuntime: h.modelRuntime,
			resourceLoader: h.resourceLoader,
			cwd: h.tempDir,
		});
		extraSessions.push(session);
		let occurrences: ReturnType<Agent["getQueuedMessageOccurrences"]> = [];
		h.setResponses([
			async () => {
				expect(agent.signal).toBeDefined();
				for (const message of batch) agent[mode](message);
				occurrences = agent.getQueuedMessageOccurrences();
				return fauxAssistantMessage("active reply");
			},
			fauxAssistantMessage("valid prefix reply"),
			fauxAssistantMessage("valid prefix reply two"),
		]);
		const failure = await session.prompt("active").catch((error: unknown) => error);
		const retained = queueMode === "all" ? occurrences : occurrences.slice(position);
		expect.soft(rawStarts).toBe(0);
		expect.soft(agent.getQueuedMessageOccurrences()).toEqual(retained);
		expect(failure).toBeInstanceOf(UnsupportedUnsentInputError);
		expect(failure).toMatchObject({ role, mode, code: "INPUT_ADMISSION_BUSY" });
		expect(
			h.sessionManager
				.getEntries()
				.some((entry) => entry.type === "message" && isDeepStrictEqual(entry.message, unsupported)),
		).toBe(false);
		const beforeExit = structuredClone(h.sessionManager.getEntries());
		expect(() => session.prepareOperatorExit()).toThrow(UnsupportedUnsentInputError);
		expect(h.sessionManager.getEntries()).toEqual(beforeExit);
		expect(agent.getQueuedMessageOccurrences()).toEqual(retained);
		// Removing only the unsupported occurrence must unblock the original valid FIFO suffix.
		agent.removeQueuedMessages((message) => message === unsupported);
		h.setResponses([
			fauxAssistantMessage("recovered one"),
			fauxAssistantMessage("recovered two"),
			fauxAssistantMessage("recovered three"),
		]);
		await session.prompt("recover");
		expect(agent.getQueuedMessages()).toEqual([]);
		const entries = h.sessionManager.getEntries();
		const delivered = entries.filter(
			(entry) =>
				(entry.type === "message" && isDeepStrictEqual(entry.message, valid[0])) ||
				(entry.type === "custom_message" && entry.customType === "valid-aside"),
		);
		expect(delivered.map((entry) => entry.type)).toEqual(["message", "custom_message"]);
	});

	// smarty-dev#13554: session policy must not narrow standalone Agent's all-role queue contract.
	it.each(
		(["steer", "followUp"] as const).flatMap((mode) =>
			(["all", "one-at-a-time"] as const).map((queueMode) => ({ mode, queueMode })),
		),
	)("P1 standalone raw $mode $queueMode still delivers all roles", async ({ mode, queueMode }) => {
		const h = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		h.session.dispose();
		const agent = new Agent({
			streamFn: streamSimple,
			convertToLlm,
			initialState: { model: h.getModel(), tools: [] },
			steeringMode: queueMode,
			followUpMode: queueMode,
		});
		const messages: AgentMessage[] = [
			{ role: "user", content: "raw user", timestamp: 1 },
			{ role: "custom", customType: "standalone", content: "raw custom", display: true, timestamp: 1 },
			fauxAssistantMessage("raw assistant"),
			{
				role: "toolResult",
				toolCallId: "raw-call",
				toolName: "raw-tool",
				content: [],
				isError: false,
				timestamp: 1,
			},
			{ role: "system", content: "raw system", timestamp: 1 },
		];
		const starts: AgentMessage[] = [];
		const ends: AgentMessage[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_start" && messages.includes(event.message)) starts.push(event.message);
			if (event.type === "message_end" && messages.includes(event.message)) ends.push(event.message);
		});
		h.setResponses([
			async () => {
				for (const message of messages) agent[mode](message);
				return fauxAssistantMessage("first");
			},
			...messages.map(() => fauxAssistantMessage("next")),
		]);
		await agent.prompt("active");
		expect(starts).toEqual(messages);
		expect(ends).toEqual(messages);
		expect(agent.getQueuedMessageOccurrences()).toEqual([]);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	// smarty-dev#13554: disposal detaches the Session validator from direct Agent reuse.
	it.each(
		(["steer", "followUp"] as const).flatMap((mode) =>
			(["all", "one-at-a-time"] as const).map((queueMode) => ({ mode, queueMode })),
		),
	)("P2 post-dispose raw $mode assistant/toolResult $queueMode still delivers", async ({ mode, queueMode }) => {
		const h = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		const agent = h.session.agent;
		agent.steeringMode = queueMode;
		agent.followUpMode = queueMode;
		h.session.dispose();
		const messages: AgentMessage[] = [
			fauxAssistantMessage("raw assistant"),
			{
				role: "toolResult",
				toolCallId: "raw-call",
				toolName: "raw-tool",
				content: [],
				isError: false,
				timestamp: 1,
			},
		];
		const starts: AgentMessage[] = [];
		const ends: AgentMessage[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_start" && messages.includes(event.message)) starts.push(event.message);
			if (event.type === "message_end" && messages.includes(event.message)) ends.push(event.message);
		});
		h.setResponses([
			async () => {
				for (const message of messages) agent[mode](message);
				return fauxAssistantMessage("active");
			},
			...messages.map(() => fauxAssistantMessage("next")),
		]);
		await agent.prompt("active");
		expect(starts).toEqual(messages);
		expect(ends).toEqual(messages);
		expect(agent.getQueuedMessageOccurrences()).toEqual([]);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	// smarty-dev#13554: continue uses the same validation, including pre-attachment queues.
	it.each(
		(["steer", "followUp"] as const).flatMap((mode) =>
			(["assistant", "toolResult"] as const).map((role) => ({ mode, role })),
		),
	)("P1 queued continue $mode $role refuses before run start", async ({ mode, role }) => {
		const h = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		h.session.dispose();
		const message: AgentMessage =
			role === "assistant"
				? fauxAssistantMessage("raw")
				: {
						role: "toolResult",
						toolCallId: "raw-call",
						toolName: "raw-tool",
						content: [],
						isError: false,
						timestamp: 1,
					};
		const agent = new Agent({
			streamFn: streamSimple,
			convertToLlm,
			initialState: { model: h.getModel(), messages: [fauxAssistantMessage("previous")] },
		});
		agent[mode](message);
		const occurrences = agent.getQueuedMessageOccurrences();
		const session = new AgentSession({
			agent,
			sessionManager: h.sessionManager,
			settingsManager: h.settingsManager,
			modelRuntime: h.modelRuntime,
			resourceLoader: h.resourceLoader,
			cwd: h.tempDir,
		});
		extraSessions.push(session);
		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
		});
		await expect(agent.continue({ fromQueuedMessages: true })).rejects.toMatchObject({
			name: "UnsupportedUnsentInputError",
			role,
			mode,
		});
		expect(events).toEqual([]);
		expect(agent.getQueuedMessageOccurrences()).toEqual(occurrences);
		expect(agent.signal).toBeUndefined();
	});

	// smarty-dev#13156 / pi#262: custom is non-user input that the reader can replay, exactly once.
	it.each(["steer", "followUp"] as const)("P1-B raw custom %s survives quit and two resumes", async (mode) => {
		const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		const message: AgentMessage = {
			role: "custom",
			customType: "pi-fabric-agent-message",
			content: [{ type: "text", text: "keep custom carrier" }],
			display: true,
			details: { original: "carrier metadata" },
			timestamp: 1,
		};
		h.session.agent[mode](message);
		const release = h.session.prepareOperatorExit();
		release();
		h.session.dispose();
		const file = h.sessionManager.getSessionFile()!;
		const saved = SessionManager.open(file);
		const outboxes = saved
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
		expect(outboxes).toHaveLength(1);
		expect(outboxes[0]).toMatchObject({ data: { message, mode } });
		const restore = (manager: SessionManager) =>
			new AgentSession({
				agent: new Agent({
					streamFn: streamSimple,
					convertToLlm,
					initialState: { model: h.getModel(), tools: [] },
				}),
				sessionManager: manager,
				settingsManager: h.settingsManager,
				modelRuntime: h.modelRuntime,
				resourceLoader: h.resourceLoader,
				cwd: h.tempDir,
			});
		const resumed = restore(saved);
		extraSessions.push(resumed);
		h.setResponses([fauxAssistantMessage("custom replayed")]);
		await resumed.resumeUnsentInputs();
		const deliveries = saved.getEntries().filter((entry) => entry.unsentInputId === outboxes[0].id);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toMatchObject({
			type: "custom_message",
			customType: message.customType,
			content: message.content,
			display: true,
			details: message.details,
		});
		expect(h.faux.state.callCount).toBe(1);
		resumed.dispose();
		const reopened = SessionManager.open(file);
		const second = restore(reopened);
		extraSessions.push(second);
		const before = reopened.getEntryCount();
		await second.resumeUnsentInputs();
		expect(second.agent.getQueuedMessages()).toEqual([]);
		expect(reopened.getEntryCount()).toBe(before);
		expect(h.faux.state.callCount).toBe(1);
	});

	// smarty-dev#13156 / pi#262: native consumption is not durable delivery when message_start throws.
	it.each([
		["steer", "user", false],
		["followUp", "user", false],
		["steer", "custom", false],
		["followUp", "custom", false],
		["steer", "user", true],
		["followUp", "user", true],
		["steer", "custom", true],
		["followUp", "custom", true],
	] as const)("P1 raw %s %s replays once (enqueue throws: %s)", async (mode, kind, enqueueThrows) => {
		const h = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(h);
		const image = { type: "image" as const, mimeType: "image/png", data: "raw-original-image-bytes" };
		const content = [{ type: "text" as const, text: "raw retained input" }, image];
		const message =
			kind === "user"
				? { role: "user" as const, content, timestamp: 1 }
				: {
						role: "custom" as const,
						customType: "raw-aside",
						content,
						display: true,
						details: { original: true },
						timestamp: 1,
					};
		const revisionBeforeEnqueue = h.session.queuedInputRevision;
		if (enqueueThrows) {
			const detach = h.session.agent.observeLifecycle((event) => {
				if (event.type === "queue_update") throw new Error("P1 enqueue observer failed");
			});
			expect(() => h.session.agent[mode](message)).toThrow("P1 enqueue observer failed");
			detach();
		} else h.session.agent[mode](message);
		expect(h.session.agent.getQueuedMessages(mode)).toEqual([message]);
		expect(h.session.queuedInputRevision).toBeGreaterThan(revisionBeforeEnqueue);
		const revisionBeforeDelivery = h.session.queuedInputRevision;
		const observedAfter = Date.now();
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type === "message_start" && event.message === message) throw new Error("P1 publication failed");
		});
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await h.session.prompt("active");
		unsubscribe();
		expect(h.session.getLastAssistantText()).toBeUndefined();
		expect(h.session.state.errorMessage).toBe("P1 publication failed");
		expect(h.session.queuedInputRevision).toBeGreaterThan(revisionBeforeDelivery);
		expect(h.eventsOfType("message_start").some((event) => event.message === message)).toBe(true);
		expect(h.eventsOfType("message_end").some((event) => event.message === message)).toBe(false);
		expect(h.session.agent.getQueuedMessages()).toEqual([]);
		// pi#160 persists detached copies; compare durable payloads, not live message references.
		expect(
			h.sessionManager
				.getEntries()
				.some((entry) => entry.type === "message" && isDeepStrictEqual(entry.message, message)),
		).toBe(false);
		if (message.role === "custom")
			expect(h.sessionManager.getEntries()).not.toContainEqual(
				expect.objectContaining({
					type: "custom_message",
					customType: message.customType,
					content: message.content,
					display: message.display,
					details: message.details,
				}),
			);
		const services: AgentSessionServices = {
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.modelRuntime,
			settingsManager: h.settingsManager,
			resourceLoader: h.resourceLoader,
			diagnostics: [],
		};
		const runtime = new AgentSessionRuntime(h.session, services, async () => {
			throw new Error("replacement must not run");
		});
		await runtime.dispose({ operatorExit: true });
		expect(h.session.isDisposed).toBe(true);
		const file = h.sessionManager.getSessionFile()!;
		const saved = SessionManager.open(file);
		const outboxes = saved
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
		expect(outboxes).toHaveLength(1);
		const outbox = outboxes[0];
		if (outbox.type !== "custom") throw new Error("missing outbox");
		const input = outbox.data as UnsentInput;
		expect(input.message).toEqual(message);
		expect(input.mode).toBe(mode);
		expect(input.origin).toEqual({ sessionId: saved.getSessionId(), host: hostname(), uid: userInfo().uid });
		expect(input.provenance).toMatchObject({ channel: "terminal", v: 1 });
		expect(Date.parse(input.provenance!.receivedAt)).toBeGreaterThanOrEqual(observedAfter);
		expect(input.metadata).toBeUndefined();
		expect(input.metadataSource).toBeUndefined();
		const resumed = new AgentSession({
			agent: new Agent({ streamFn: streamSimple, convertToLlm, initialState: { model: h.getModel(), tools: [] } }),
			sessionManager: saved,
			settingsManager: h.settingsManager,
			modelRuntime: h.modelRuntime,
			resourceLoader: h.resourceLoader,
			cwd: h.tempDir,
		});
		extraSessions.push(resumed);
		await resumed.bindExtensions({});
		h.setResponses([fauxAssistantMessage("replayed")]);
		await resumed.resumeUnsentInputs();
		const deliveries = saved.getEntries().filter((entry) => entry.unsentInputId === outbox.id);
		expect(deliveries).toHaveLength(1);
		if (deliveries[0].type !== "message" && deliveries[0].type !== "custom_message")
			throw new Error("missing durable delivery");
		expect(deliveries[0].provenance).toEqual(input.provenance);
		if (kind === "user") expect(deliveries[0]).toMatchObject({ type: "message", message: { content } });
		else expect(deliveries[0]).toMatchObject({ type: "custom_message", content, details: { original: true } });
		resumed.dispose();
		const secondManager = SessionManager.open(file);
		const second = new AgentSession({
			agent: new Agent({ streamFn: streamSimple, convertToLlm, initialState: { model: h.getModel(), tools: [] } }),
			sessionManager: secondManager,
			settingsManager: h.settingsManager,
			modelRuntime: h.modelRuntime,
			resourceLoader: h.resourceLoader,
			cwd: h.tempDir,
		});
		extraSessions.push(second);
		const before = secondManager.getEntryCount();
		await second.resumeUnsentInputs();
		expect(second.agent.getQueuedMessages()).toEqual([]);
		expect(secondManager.getEntryCount()).toBe(before);
	});

	// smarty-dev#13156 / pi#262: an earlier native listener can throw before AgentSession observes delivery.
	it.each(["steer", "followUp"] as const)("P1 raw %s survives an earlier native listener", async (mode) => {
		const h = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(h);
		h.session.dispose();
		const message = { role: "user" as const, content: "earlier native listener input", timestamp: 1 };
		const agent = new Agent({
			streamFn: streamSimple,
			convertToLlm,
			initialState: { model: h.getModel(), tools: [] },
		});
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "message_start" && event.message === message) throw new Error("P1 earlier native listener");
		});
		const session = new AgentSession({
			agent,
			sessionManager: h.sessionManager,
			settingsManager: h.settingsManager,
			modelRuntime: h.modelRuntime,
			resourceLoader: h.resourceLoader,
			cwd: h.tempDir,
		});
		extraSessions.push(session);
		agent[mode](message);
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await session.prompt("active");
		unsubscribe();
		expect(agent.state.errorMessage).toBe("P1 earlier native listener");
		expect(agent.getQueuedMessages()).toEqual([]);
		const runtime = new AgentSessionRuntime(
			session,
			{
				cwd: h.tempDir,
				agentDir: h.tempDir,
				modelRuntime: h.modelRuntime,
				settingsManager: h.settingsManager,
				resourceLoader: h.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("replacement must not run");
			},
		);
		await runtime.dispose({ operatorExit: true });
		const file = h.sessionManager.getSessionFile()!;
		const saved = SessionManager.open(file);
		const outboxes = saved
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
		expect(outboxes).toHaveLength(1);
		if (outboxes[0].type !== "custom") throw new Error("missing outbox");
		expect(outboxes[0].data).toMatchObject({ message, mode });
		// No harness observation reached this input, so enqueue must not fabricate a receipt.
		expect((outboxes[0].data as UnsentInput).provenance).toBeUndefined();
		const restore = (manager: SessionManager) =>
			new AgentSession({
				agent: new Agent({
					streamFn: streamSimple,
					convertToLlm,
					initialState: { model: h.getModel(), tools: [] },
				}),
				sessionManager: manager,
				settingsManager: h.settingsManager,
				modelRuntime: h.modelRuntime,
				resourceLoader: h.resourceLoader,
				cwd: h.tempDir,
			});
		const resumed = restore(saved);
		extraSessions.push(resumed);
		await resumed.bindExtensions({});
		h.setResponses([fauxAssistantMessage("replayed")]);
		await resumed.resumeUnsentInputs();
		expect(saved.getEntries().filter((entry) => entry.unsentInputId === outboxes[0].id)).toHaveLength(1);
		resumed.dispose();
		const secondManager = SessionManager.open(file);
		const second = restore(secondManager);
		extraSessions.push(second);
		const before = secondManager.getEntryCount();
		await second.resumeUnsentInputs();
		expect(second.agent.getQueuedMessages()).toEqual([]);
		expect(secondManager.getEntryCount()).toBe(before);
	});

	// Refs Smarty-Pants-Inc/smarty-dev#13156: one raw object can represent two enqueue occurrences.
	it.each(["steer", "followUp"] as const)("P1 repeated raw %s survives first publication failure", async (mode) => {
		const h = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(h);
		const message = { role: "user" as const, content: "same raw object twice", timestamp: 1 };
		h.session.agent[mode](message);
		h.session.agent[mode](message);
		const occurrences = h.session.agent.getQueuedMessageOccurrences();
		expect(occurrences).toHaveLength(2);
		expect(occurrences[0].id).not.toBe(occurrences[1].id);
		expect(occurrences.map((entry) => entry.message)).toEqual([message, message]);
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type === "message_start" && event.message === message) throw new Error("first occurrence failed");
		});
		h.setResponses([fauxAssistantMessage("initial")]);
		// Use the native run: session.prompt would automatically continue the remaining queue after failure.
		await h.session.agent.prompt("active");
		unsubscribe();
		expect(h.session.agent.state.errorMessage).toBe("first occurrence failed");
		expect(h.session.agent.getQueuedMessages(mode)).toEqual([message]);
		const release = h.session.prepareOperatorExit();
		release();
		h.session.dispose();
		const file = h.sessionManager.getSessionFile()!;
		const saved = SessionManager.open(file);
		const outboxes = saved
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
		expect(outboxes).toHaveLength(2);
		for (const entry of outboxes) {
			if (entry.type !== "custom") throw new Error("missing outbox");
			expect(entry.data).toMatchObject({ message, mode });
		}
		// Only the first occurrence reached a harness listener. Attribution must not leak to the second.
		expect(outboxes[0].type === "custom" ? (outboxes[0].data as UnsentInput).provenance : undefined).toBeDefined();
		expect(outboxes[1].type === "custom" ? (outboxes[1].data as UnsentInput).provenance : undefined).toBeUndefined();
		const restore = (manager: SessionManager) =>
			new AgentSession({
				agent: new Agent({
					streamFn: streamSimple,
					convertToLlm,
					initialState: { model: h.getModel(), tools: [] },
				}),
				sessionManager: manager,
				settingsManager: h.settingsManager,
				modelRuntime: h.modelRuntime,
				resourceLoader: h.resourceLoader,
				cwd: h.tempDir,
			});
		const resumed = restore(saved);
		extraSessions.push(resumed);
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await resumed.resumeUnsentInputs();
		for (const entry of outboxes)
			expect(saved.getEntries().filter((delivery) => delivery.unsentInputId === entry.id)).toHaveLength(1);
		expect(
			saved
				.getEntries()
				.filter((entry) => entry.type === "message" && getMessageText(entry.message) === message.content),
		).toHaveLength(2);
		resumed.dispose();
		const reopened = SessionManager.open(file);
		const second = restore(reopened);
		extraSessions.push(second);
		const before = reopened.getEntryCount();
		await second.resumeUnsentInputs();
		expect(second.agent.getQueuedMessages()).toEqual([]);
		expect(reopened.getEntryCount()).toBe(before);
	});

	// smarty-dev#13156 / pi#262: saved input is consumed even if request preparation never dispatches it.
	it.each(["steer", "followUp"] as const)("P1 raw %s committed input is not retained again", async (mode) => {
		const h = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(h);
		const message = { role: "user" as const, content: "committed raw input", timestamp: 1 };
		h.session.agent[mode](message);
		h.session.agent.prepareRequest = async () => {
			throw new Error("P1 dispatch prevented");
		};
		await h.session.prompt("active");
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && isDeepStrictEqual(entry.message, message)),
		).toHaveLength(1);
		const revisionBeforeExit = h.session.queuedInputRevision;
		const release = h.session.prepareOperatorExit();
		release();
		expect(h.session.queuedInputRevision).toBeGreaterThan(revisionBeforeExit);
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
		).toEqual([]);
	});

	// smarty-dev#13156 / pi#262: normal native sends commit once and release pending retention.
	it.each(["steer", "followUp"] as const)("P1 raw %s normal send is committed once", async (mode) => {
		const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		const message = { role: "user" as const, content: "normal raw input", timestamp: 1 };
		h.session.agent[mode](message);
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await h.session.prompt("active");
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && isDeepStrictEqual(entry.message, message)),
		).toHaveLength(1);
		expect(h.session.agent.getQueuedMessages()).toEqual([]);
		const release = h.session.prepareOperatorExit();
		release();
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
		).toEqual([]);
	});

	// Refs Smarty-Pants-Inc/smarty-dev#13156: a persisted receipt belongs only to its enqueue occurrence.
	it.each(["steer", "followUp"] as const)(
		"P1 raw %s remains recoverable after an earlier same-object send",
		async (mode) => {
			const h = await createHarness({
				persistSession: true,
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
			});
			harnesses.push(h);
			const message = { role: "user" as const, content: "reuse after commit", timestamp: 1 };
			h.session.agent[mode](message);
			h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			await h.session.agent.prompt("active");
			expect(
				h.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "message" && isDeepStrictEqual(entry.message, message)),
			).toHaveLength(1);
			h.session.agent[mode](message);
			const unsubscribe = h.session.subscribe((event) => {
				if (event.type === "message_start" && event.message === message) throw new Error("later occurrence failed");
			});
			h.setResponses([fauxAssistantMessage("three")]);
			await h.session.agent.prompt("next");
			unsubscribe();
			const release = h.session.prepareOperatorExit();
			release();
			const outboxes = h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
			expect(outboxes).toHaveLength(1);
			expect(outboxes[0]).toMatchObject({ data: { message, mode } });
		},
	);

	// Refs Smarty-Pants-Inc/smarty-dev#13156: raw reuse never transfers a live direct receipt.
	it.each([
		["steer", "inflight"],
		["followUp", "inflight"],
		["steer", "deferred"],
		["followUp", "deferred"],
	] as const)("P1 raw %s after %s direct publication retains independent occurrences", async (mode, timing) => {
		const h = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(h);
		let original: (typeof h.session.messages)[number] | undefined;
		let starts = 0;
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type !== "message_start" || event.message.role !== "user" || getMessageText(event.message) !== "A")
				return;
			original = event.message;
			starts++;
			if (timing === "inflight" && starts === 1) h.session.agent[mode](event.message);
			else throw new Error("direct reuse publication failed");
		});
		h.setResponses([fauxAssistantMessage("direct reply")]);
		await h.session.prompt("A");
		unsubscribe();
		expect(h.session.state.errorMessage).toBe("direct reuse publication failed");
		if (!original) throw new Error("missing direct input");
		if (timing === "deferred") h.session.agent[mode](original);
		const direct = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && isDeepStrictEqual(entry.message, original));
		expect(direct).toHaveLength(timing === "inflight" ? 1 : 0);
		const release = h.session.prepareOperatorExit();
		release();
		h.session.dispose();
		const saved = SessionManager.open(h.sessionManager.getSessionFile()!);
		const outboxes = saved
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
		expect(outboxes).toHaveLength(timing === "inflight" ? 1 : 2);
		const inputs = outboxes.map((entry) => {
			if (entry.type !== "custom") throw new Error("missing outbox");
			return entry.data as UnsentInput;
		});
		for (const input of inputs) {
			expect(input.message).toEqual(original);
			expect(input.metadata).toBeUndefined();
			expect(input.metadataSource).toBeUndefined();
		}
		expect(inputs[0].provenance).toMatchObject({ channel: "terminal", v: 1 });
		if (timing === "inflight") {
			if (direct[0].type !== "message") throw new Error("missing direct delivery");
			expect(inputs[0].provenance).not.toEqual(direct[0].provenance);
		} else expect(inputs[1].provenance).toBeUndefined();
		const resumed = new AgentSession({
			agent: new Agent({ streamFn: streamSimple, convertToLlm, initialState: { model: h.getModel(), tools: [] } }),
			sessionManager: saved,
			settingsManager: h.settingsManager,
			modelRuntime: h.modelRuntime,
			resourceLoader: h.resourceLoader,
			cwd: h.tempDir,
		});
		extraSessions.push(resumed);
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await resumed.resumeUnsentInputs();
		for (const outbox of outboxes)
			expect(saved.getEntries().filter((entry) => entry.unsentInputId === outbox.id)).toHaveLength(1);
		expect(
			saved.getEntries().filter((entry) => entry.type === "message" && getMessageText(entry.message) === "A"),
		).toHaveLength(2);
		const before = saved.getEntryCount();
		await resumed.resumeUnsentInputs();
		expect(saved.getEntryCount()).toBe(before);
	});

	// Refs Smarty-Pants-Inc/smarty-dev#13156: prepared queue transfer is one occurrence, not two.
	it.each(["steer", "followUp"] as const)("P1 session-owned %s transfer saves one snapshot", async (mode) => {
		const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		await h.session[mode]("owned transfer");
		expect(h.session.agent.getQueuedMessageOccurrences()).toHaveLength(1);
		const release = h.session.prepareOperatorExit();
		release();
		const outboxes = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
		expect(outboxes).toHaveLength(1);
		expect(outboxes[0]).toMatchObject({ data: { provenance: { channel: "terminal", v: 1 } } });
	});

	// Refs Smarty-Pants-Inc/smarty-dev#13156: committed objects get a fresh raw enqueue order.
	it.each(["steer", "followUp"] as const)("P1 requeued committed %s preserves outbox order", async (mode) => {
		const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("committed")]);
		await h.session.prompt("A");
		const original = h.session.messages.find((message) => message.role === "user");
		if (!original) throw new Error("missing committed user message");
		h.session.agent[mode]({ role: "user", content: "B", timestamp: 1 });
		h.session.agent[mode](original);
		const release = h.session.prepareOperatorExit();
		release();
		h.session.dispose();
		const saved = SessionManager.open(h.sessionManager.getSessionFile()!);
		const outboxes = saved
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
		expect(
			outboxes.map((entry) => (entry.type === "custom" ? getMessageText((entry.data as UnsentInput).message) : "")),
		).toEqual(["B", "A"]);
		const resumed = new AgentSession({
			agent: new Agent({ streamFn: streamSimple, convertToLlm, initialState: { model: h.getModel(), tools: [] } }),
			sessionManager: saved,
			settingsManager: h.settingsManager,
			modelRuntime: h.modelRuntime,
			resourceLoader: h.resourceLoader,
			cwd: h.tempDir,
		});
		extraSessions.push(resumed);
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await resumed.resumeUnsentInputs();
		const delivered = saved.getEntries().filter((entry) => entry.unsentInputId);
		expect(delivered.map((entry) => entry.unsentInputId)).toEqual(outboxes.map((entry) => entry.id));
		expect(delivered.map((entry) => (entry.type === "message" ? getMessageText(entry.message) : ""))).toEqual([
			"B",
			"A",
		]);
		const before = saved.getEntryCount();
		await resumed.resumeUnsentInputs();
		expect(saved.getEntryCount()).toBe(before);
	});

	// smarty-dev#13156 / pi#262: intentionally removed native input must not become recoverable work.
	it.each(["steer", "followUp"] as const)("P1 raw %s explicitly cleared input is discarded", async (mode) => {
		const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		const message = { role: "user" as const, content: "discard raw input", timestamp: 1 };
		for (const clear of [
			() => h.session.agent.removeQueuedMessages((queued) => queued === message),
			() => (mode === "steer" ? h.session.agent.clearSteeringQueue() : h.session.agent.clearFollowUpQueue()),
			() => h.session.clearQueue(),
			() => h.session.agent.clearAllQueues(),
		]) {
			h.session.agent[mode](message);
			const revision = h.session.queuedInputRevision;
			const detach = h.session.agent.observeLifecycle((event) => {
				if (event.type === "queue_update" && h.session.agent.getQueuedMessages(mode).length === 0)
					throw new Error("P1 clear observer failed");
			});
			expect(clear).toThrow("P1 clear observer failed");
			detach();
			expect(h.session.queuedInputRevision).toBeGreaterThan(revision);
		}
		const release = h.session.prepareOperatorExit();
		release();
		expect(h.session.agent.getQueuedMessages()).toEqual([]);
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
		const outboxes = saved
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
		expect(outboxes).toHaveLength(4);
		for (const entry of outboxes) {
			if (entry.type !== "custom") throw new Error("missing outbox");
			expect((entry.data as UnsentInput).origin).toEqual({
				sessionId: saved.getSessionId(),
				host: hostname(),
				uid: userInfo().uid,
			});
		}
		expect(readFileSync(file, "utf8")).toContain(
			JSON.stringify({
				sessionId: saved.getSessionId(),
				host: hostname(),
				uid: userInfo().uid,
			}),
		);
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
		expect(resumed.takeUnsentInputDrafts()).toEqual([]);
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
