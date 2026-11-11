import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { estimateTokens } from "../../src/core/compaction/compaction.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { UNSENT_INPUT_TYPE, type UnsentInput } from "../../src/core/unsent-input.ts";
import { createHarness, getMessageText } from "./harness.ts";

// smarty-dev#19998, lead requirement 2026-11-11 02:32Z: these are contract bounds,
// deliberately not imported from the implementation under test.
const MAX_COUNT = 16;
const MAX_BYTES = 256 * 1024;
const POLL_TIMEOUT = 3000;

function writeSavedInputs(
	tempDir: string,
	contents: UserMessage["content"][],
	model: { provider: string; id: string },
	mode: "steer" | "followUp",
	previousToolResult?: string,
) {
	const manager = SessionManager.create(tempDir, join(tempDir, "recovered"));
	manager.appendModelChange(model.provider, model.id);
	manager.appendMessage({ role: "user", content: "previous request", timestamp: Date.now() - 10_000 });
	if (previousToolResult) {
		const call = fauxToolCall("read", {});
		manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		manager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: "read",
			content: [{ type: "text", text: previousToolResult }],
			isError: false,
			timestamp: Date.now(),
		});
	}
	manager.appendMessage(fauxAssistantMessage("previous answer"));
	const origin = { sessionId: manager.getSessionId(), host: hostname(), uid: userInfo().uid };
	const timestamp = Date.now();
	const inputs: UnsentInput[] = contents.map((content, index) => ({
		origin,
		mode,
		message: { role: "user", content, timestamp: timestamp + index },
	}));
	const ids = inputs.map((input) => manager.appendCustomEntry(UNSENT_INPUT_TYPE, input));
	const file = manager.getSessionFile()!;
	const idByTimestamp = new Map(inputs.map((input, index) => [input.message.timestamp, ids[index]]));
	return { file, ids, inputs, idByTimestamp, prefix: readFileSync(file) };
}

type SavedInputs = ReturnType<typeof writeSavedInputs>;

/** Observe public queue publication, never replace admission, queueing, or resume. */
function observeAdmissions(session: AgentSession, saved: SavedInputs) {
	let admitted = 0;
	const admissions: Array<{ ids: string[]; queuedIds: Array<string | undefined>; bytes: number }> = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "queue_update") return;
		const next = saved.ids.length - session.recoveredInputCount;
		if (next <= admitted) return;
		admissions.push({
			ids: saved.ids.slice(admitted, next),
			queuedIds: session.agent.getQueuedMessages().map((message) => saved.idByTimestamp.get(message.timestamp)),
			bytes: saved.inputs
				.slice(admitted, next)
				.reduce((bytes, input) => bytes + Buffer.byteLength(JSON.stringify(input), "utf8"), 0),
		});
		admitted = next;
	});
	return { admissions, unsubscribe };
}

function expectBoundedAdmissions(observed: ReturnType<typeof observeAdmissions>, saved: SavedInputs) {
	expect(observed.admissions.flatMap((batch) => batch.ids)).toEqual(saved.ids);
	for (const batch of observed.admissions) {
		expect(batch.queuedIds).toEqual(batch.ids);
		expect(batch.ids.length).toBeLessThanOrEqual(MAX_COUNT);
		if (batch.ids.length > 1) expect(batch.bytes).toBeLessThanOrEqual(MAX_BYTES);
	}
}

/** Provider-visible occurrences, not text dedupe or merely a resume-call count. */
function answeringSavedInputs(saved: SavedInputs) {
	const delivered: string[] = [];
	const requests: string[][] = [];
	const seen = new Set<string>();
	const answer: FauxResponseFactory = (context) => {
		const fresh: string[] = [];
		for (const message of context.messages) {
			if (message.role !== "user") continue;
			const id = saved.idByTimestamp.get(message.timestamp);
			if (!id || seen.has(id)) continue;
			seen.add(id);
			fresh.push(id);
			delivered.push(id);
		}
		requests.push(fresh);
		return fauxAssistantMessage("saved input answered");
	};
	return { answer, delivered, requests };
}

function expectPreservedJournal(session: AgentSession, saved: SavedInputs, deliveredIds: string[]) {
	const bytes = readFileSync(saved.file);
	expect(bytes.subarray(0, saved.prefix.length).equals(saved.prefix)).toBe(true);
	const reopened = SessionManager.open(saved.file);
	const entries = reopened.getEntries();
	const outboxes = entries.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
	expect(outboxes.map((entry) => entry.id)).toEqual(saved.ids);
	expect(outboxes.map((entry) => (entry.type === "custom" ? entry.data : undefined))).toEqual(saved.inputs);
	const delivered = entries.filter((entry) => entry.unsentInputId);
	expect(delivered.map((entry) => entry.unsentInputId)).toEqual(deliveredIds);
	expect(new Set(delivered.map((entry) => entry.unsentInputId)).size).toBe(deliveredIds.length);
	for (const entry of delivered) {
		const index = saved.ids.indexOf(entry.unsentInputId!);
		expect(entry.type).toBe("message");
		if (entry.type === "message") expect(entry.message).toEqual(saved.inputs[index].message);
	}
	expect(session.sessionManager.getEntries().filter((entry) => entry.unsentInputId)).toEqual(delivered);
}

// Keep reason: accepted-input data safety across the real SDK/runtime receiving
// fence and native provider loop. No provider API, queue, receipt, or resume mocks.
describe("AgentSession automatic bounded unsent replay", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});

	async function createReplayRuntime(options: { contextWindow?: number; compaction?: boolean } = {}) {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: options.contextWindow ?? 1_000_000, maxTokens: 100 }],
			settings: {
				retry: { enabled: false },
				compaction: { enabled: options.compaction ?? false, reserveTokens: 0, keepRecentTokens: 20_000 },
				images: { autoResize: false },
			},
		});
		cleanups.push(harness.cleanup);
		let context: ExtensionContext | undefined;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime: harness.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.on("session_start", (_event, ctx) => {
								context = ctx;
							});
						},
					],
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: harness.getModel(),
					noTools: "all",
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			sessionManager: SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions")),
		});
		// Failure teardown also retains undelivered native input before cancelling.
		cleanups.push(() => runtime.dispose({ operatorExit: true }));
		await runtime.session.bindExtensions({});
		return {
			runtime,
			harness,
			getContext: () => {
				if (!context) throw new Error("Missing bound session_start context");
				return context;
			},
		};
	}

	it.each(["steer", "followUp"] as const)(
		"automatically consumes 35 local %s occurrences across count-bounded batches after one resume",
		async (mode) => {
			const { runtime, harness, getContext } = await createReplayRuntime();
			const duplicate = "same text, separate accepted occurrence";
			const contents = Array.from({ length: 35 }, (_, index) =>
				index % 17 === 0 ? duplicate : `accepted occurrence ${index}`,
			);
			const saved = writeSavedInputs(harness.tempDir, contents, harness.getModel(), mode);

			await expect(runtime.switchSession(saved.file)).resolves.toEqual({ cancelled: false });
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			expect(runtime.session.recoveredInputCount).toBe(35);
			expect(runtime.session.pendingMessageCount).toBe(35);
			await runtime.session.bindExtensions({});
			const context = getContext();
			expect(context.hasPendingMessages()).toBe(false);
			expect(context.getInputState()).toEqual({
				inputsFenced: false,
				inputAdmissionCount: 0,
				queued: 0,
				drained: true,
			});
			expect(harness.faux.state.callCount).toBe(0);
			runtime.session.setSteeringMode("all");
			runtime.session.setFollowUpMode("all");
			const observed = observeAdmissions(runtime.session, saved);
			const provider = answeringSavedInputs(saved);
			harness.setResponses(Array.from({ length: 35 }, () => provider.answer));

			await runtime.session.resumeUnsentInputs(); // The only explicit resume in this flow.
			// Native settlement/turn events drive replay. Poll only as a bounded safety
			// net for automatic continuations; never nudge, continue, or resume again.
			await expect.poll(() => runtime.session.pendingMessageCount, { timeout: POLL_TIMEOUT }).toBe(0);
			await expect
				.poll(() => runtime.session.isIdle && !runtime.session.isSettling, { timeout: POLL_TIMEOUT })
				.toBe(true);
			observed.unsubscribe();

			expect(observed.admissions.length).toBeGreaterThanOrEqual(3);
			expect(observed.admissions[0].ids).toHaveLength(MAX_COUNT);
			expectBoundedAdmissions(observed, saved);
			expect(provider.delivered).toEqual(saved.ids);
			expect(provider.requests.flat()).toEqual(saved.ids);
			expect(runtime.session.recoveredInputCount).toBe(0);
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			expect(context.hasPendingMessages()).toBe(false);
			expect(context.getInputState()).toMatchObject({ inputAdmissionCount: 0, queued: 0, drained: true });
			expect(
				runtime.session.messages.filter(
					(message) => message.role === "user" && getMessageText(message) === duplicate,
				),
			).toHaveLength(3);
			expectPreservedJournal(runtime.session, saved, saved.ids);

			const calls = harness.faux.state.callCount;
			await runtime.newSession();
			await runtime.session.bindExtensions({});
			await runtime.switchSession(saved.file);
			await runtime.session.bindExtensions({});
			expect(runtime.session.recoveredInputCount).toBe(0);
			expect(runtime.session.pendingMessageCount).toBe(0);
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			expect(harness.faux.state.callCount).toBe(calls);
			expectPreservedJournal(runtime.session, saved, saved.ids);
		},
	);

	it("automatically drains 25 Unicode inputs with the UTF-8 byte bound tighter than the count bound", async () => {
		const { runtime, harness } = await createReplayRuntime();
		const saved = writeSavedInputs(
			harness.tempDir,
			Array.from({ length: 25 }, (_, index) => `${index}: ${"🙂".repeat(18_000)}`),
			harness.getModel(),
			"steer",
		);
		await runtime.switchSession(saved.file);
		await runtime.session.bindExtensions({});
		runtime.session.setSteeringMode("all");
		const observed = observeAdmissions(runtime.session, saved);
		const provider = answeringSavedInputs(saved);
		harness.setResponses(Array.from({ length: 25 }, () => provider.answer));

		await runtime.session.resumeUnsentInputs();
		await expect.poll(() => runtime.session.pendingMessageCount, { timeout: POLL_TIMEOUT }).toBe(0);
		await expect
			.poll(() => runtime.session.isIdle && !runtime.session.isSettling, { timeout: POLL_TIMEOUT })
			.toBe(true);
		observed.unsubscribe();

		expect(observed.admissions.length).toBeGreaterThan(2);
		expect(observed.admissions[0].bytes).toBeGreaterThan(MAX_BYTES / 2);
		expect(observed.admissions[0].ids.length).toBeLessThan(MAX_COUNT);
		expectBoundedAdmissions(observed, saved);
		expect(provider.delivered).toEqual(saved.ids);
		expectPreservedJournal(runtime.session, saved, saved.ids);
	});

	it("delivers an oversized first image alone, then automatically answers the 20 smaller saved inputs", async () => {
		const { runtime, harness } = await createReplayRuntime({ compaction: true });
		// A real, uncompressed 512x256 24-bit BMP; no codec dependency or image mock.
		const pixels = 512 * 256 * 3;
		const image = Buffer.alloc(54 + pixels, 0x7f);
		image.fill(0, 0, 54);
		image.write("BM", 0, "ascii");
		image.writeUInt32LE(image.length, 2);
		image.writeUInt32LE(54, 10);
		image.writeUInt32LE(40, 14);
		image.writeInt32LE(512, 18);
		image.writeInt32LE(256, 22);
		image.writeUInt16LE(1, 26);
		image.writeUInt16LE(24, 28);
		image.writeUInt32LE(pixels, 34);
		const content: UserMessage["content"] = [
			{ type: "text", text: "Describe this accepted image." },
			{ type: "image", mimeType: "image/bmp", data: image.toString("base64") },
		];
		const saved = writeSavedInputs(
			harness.tempDir,
			[content, ...Array.from({ length: 20 }, (_, index) => `small input after image ${index}`)],
			harness.getModel(),
			"followUp",
		);
		expect(Buffer.byteLength(JSON.stringify(saved.inputs[0]), "utf8")).toBeGreaterThan(MAX_BYTES);
		await runtime.switchSession(saved.file);
		await runtime.session.bindExtensions({});
		runtime.session.setFollowUpMode("all");
		const observed = observeAdmissions(runtime.session, saved);
		const provider = answeringSavedInputs(saved);
		let firstProviderContent: UserMessage["content"] | undefined;
		harness.setResponses([
			(context, options, state, model) => {
				const user = context.messages.find(
					(message) => message.role === "user" && message.timestamp === saved.inputs[0].message.timestamp,
				);
				if (user?.role === "user") firstProviderContent = user.content;
				return provider.answer(context, options, state, model);
			},
			...Array.from({ length: 20 }, () => provider.answer),
		]);

		await runtime.session.resumeUnsentInputs();
		await expect.poll(() => runtime.session.pendingMessageCount, { timeout: POLL_TIMEOUT }).toBe(0);
		await expect
			.poll(() => runtime.session.isIdle && !runtime.session.isSettling, { timeout: POLL_TIMEOUT })
			.toBe(true);
		observed.unsubscribe();

		expect(firstProviderContent).toEqual(content);
		expect(observed.admissions[0].ids).toEqual([saved.ids[0]]);
		expect(observed.admissions[0].bytes).toBeGreaterThan(MAX_BYTES);
		expectBoundedAdmissions(observed, saved);
		expect(provider.requests[0]).toEqual([saved.ids[0]]);
		expect(provider.delivered).toEqual(saved.ids);
		expect(runtime.session.getLastAssistantText()).toBe("saved input answered");
		expectPreservedJournal(runtime.session, saved, saved.ids);
	});

	it.each(["cancel", "provider error"] as const)(
		"does not auto-drain past %s and preserves all 24 pending occurrences across operator exit/reopen",
		async (outcome) => {
			const { runtime, harness, getContext } = await createReplayRuntime();
			const saved = writeSavedInputs(
				harness.tempDir,
				Array.from({ length: 25 }, (_, index) => `accepted input ${index}`),
				harness.getModel(),
				"followUp",
			);
			await runtime.switchSession(saved.file);
			await runtime.session.bindExtensions({});
			runtime.session.setFollowUpMode("one-at-a-time");
			let aborted: Promise<void> | undefined;
			const outcomes: string[] = [];
			runtime.session.subscribe((event) => {
				if (event.type === "agent_settled") outcomes.push(event.outcome);
			});
			harness.setResponses([
				() => {
					if (outcome === "cancel") aborted = runtime.session.abort();
					return fauxAssistantMessage("", {
						stopReason: outcome === "cancel" ? "aborted" : "error",
						errorMessage: outcome === "provider error" ? "invalid request: permanent failure" : undefined,
					});
				},
				...Array.from({ length: 24 }, () => fauxAssistantMessage("must remain pending")),
			]);

			await runtime.session.resumeUnsentInputs();
			await aborted;
			await expect
				.poll(() => runtime.session.isIdle && !runtime.session.isSettling, { timeout: POLL_TIMEOUT })
				.toBe(true);

			expect(outcomes.at(-1)).toBe(outcome === "cancel" ? "aborted" : "error");
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.getPendingResponseCount()).toBe(24);
			expect(runtime.session.agent.getQueuedMessages()).toHaveLength(MAX_COUNT - 1);
			expect(runtime.session.recoveredInputCount).toBe(25 - MAX_COUNT);
			expect(runtime.session.pendingMessageCount).toBe(24);
			expect(getContext().hasPendingMessages()).toBe(true);
			expect(getContext().getInputState()).toMatchObject({ inputAdmissionCount: 0, queued: 15, drained: false });
			expectPreservedJournal(runtime.session, saved, [saved.ids[0]]);

			runtime.session.prepareOperatorExit()();
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			expectPreservedJournal(runtime.session, saved, [saved.ids[0]]);
			await runtime.newSession();
			await runtime.session.bindExtensions({});
			await runtime.switchSession(saved.file);
			await runtime.session.bindExtensions({});
			expect(runtime.session.recoveredInputCount).toBe(24);
			expect(runtime.session.pendingMessageCount).toBe(24);
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			expect(getContext().hasPendingMessages()).toBe(false);
			expect(getContext().getInputState()).toMatchObject({ inputAdmissionCount: 0, queued: 0, drained: true });
			expect(harness.faux.state.callCount).toBe(1);
			expectPreservedJournal(runtime.session, saved, [saved.ids[0]]);
		},
	);

	it("keeps a fitting 300 KiB recovered user unchanged when the provider accepts it", async () => {
		const { runtime, harness } = await createReplayRuntime({ compaction: true });
		const payload = `accepted oversized input: ${"x".repeat(300 * 1024)}`;
		const saved = writeSavedInputs(harness.tempDir, [payload], harness.getModel(), "steer");
		await runtime.switchSession(saved.file);
		await runtime.session.bindExtensions({});
		let sent: UserMessage["content"] | undefined;
		harness.setResponses([
			(context) => {
				const user = context.messages.find(
					(message) => message.role === "user" && message.timestamp === saved.inputs[0].message.timestamp,
				);
				if (user?.role === "user") sent = user.content;
				return fauxAssistantMessage("accepted input answered intact");
			},
		]);

		await runtime.session.resumeUnsentInputs();

		expect(sent).toBe(payload);
		expect(harness.faux.state.callCount).toBe(1);
		expect(runtime.session.getLastAssistantText()).toBe("accepted input answered intact");
		expect(runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toEqual([]);
		expectPreservedJournal(runtime.session, saved, saved.ids);
	});

	it.each(["cancel during repair", "repeated overflow"] as const)(
		"keeps the existing recovery bound and remaining accepted custody after %s",
		async (outcome) => {
			const { runtime, harness } = await createReplayRuntime({ compaction: true });
			const payload = `accepted oversized input: ${"x".repeat(300 * 1024)}`;
			const saved = writeSavedInputs(
				harness.tempDir,
				[payload, ...Array.from({ length: 24 }, (_, index) => `must remain saved ${index}`)],
				harness.getModel(),
				"steer",
			);
			await runtime.switchSession(saved.file);
			await runtime.session.bindExtensions({});
			const overflow = fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
			overflow.recovery = { recovery: "context_length_exceeded", retryable: false };
			const settled: string[] = [];
			runtime.session.subscribe((event) => {
				if (event.type === "agent_settled") settled.push(event.outcome);
				if (
					outcome === "cancel during repair" &&
					event.type === "entry_appended" &&
					event.entry.type === "context_edit" &&
					JSON.stringify(event.entry).includes("Saved user input omitted")
				)
					runtime.session.abortCompaction();
			});
			harness.setResponses([
				overflow,
				overflow,
				fauxAssistantMessage("must not retry again or consume the next batch"),
			]);

			await runtime.session.resumeUnsentInputs();

			expect(harness.faux.state.callCount).toBe(outcome === "cancel during repair" ? 1 : 2);
			expect(settled.at(-1)).toBe(outcome === "cancel during repair" ? "aborted" : "error");
			expect(runtime.session.recoveredInputCount).toBe(24);
			expect(runtime.session.pendingMessageCount).toBe(24);
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			expectPreservedJournal(runtime.session, saved, [saved.ids[0]]);
			runtime.session.prepareOperatorExit()();
			await runtime.newSession();
			await runtime.session.bindExtensions({});
			await runtime.switchSession(saved.file);
			await runtime.session.bindExtensions({});
			expect(runtime.session.recoveredInputCount).toBe(24);
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			expectPreservedJournal(runtime.session, saved, [saved.ids[0]]);
		},
	);

	it.each([
		{ contextWindow: 60_000, smallTool: false },
		{ contextWindow: 1_000_000, smallTool: false },
		{ contextWindow: 1_000_000, smallTool: true },
	])(
		"answers an oversized accepted text after real overflow recovery with an append-only raw-preserving stub ($contextWindow-token window; small tool: $smallTool)",
		async ({ contextWindow, smallTool }) => {
			const { runtime, harness } = await createReplayRuntime({ contextWindow, compaction: true });
			// smarty-dev#19998: the same accepted input exceeds the replay byte cap in
			// both cases. At 1M advertised tokens it fits the estimate but ALONE exceeds
			// the provider's actual window; only that real error may trigger fallback.
			const payload = `accepted oversized input: ${"x".repeat(300 * 1024)}`;
			const tinyResult = `small retained result: ${"t".repeat(2 * 1024)}`;
			const saved = writeSavedInputs(
				harness.tempDir,
				[payload],
				harness.getModel(),
				"steer",
				smallTool ? tinyResult : undefined,
			);
			expect(Buffer.byteLength(JSON.stringify(saved.inputs[0]), "utf8")).toBeGreaterThan(MAX_BYTES);
			await runtime.switchSession(saved.file);
			await runtime.session.bindExtensions({});
			const overflow = fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
			overflow.recovery = { recovery: "context_length_exceeded", retryable: false };
			let rawPrefix = Buffer.alloc(0);
			const requests: string[] = [];
			harness.setResponses(
				Array.from(
					{ length: 5 },
					(): FauxResponseFactory => (context) => {
						const request = JSON.stringify(context.messages);
						requests.push(request);
						if (requests.length === 1) {
							if (contextWindow === 1_000_000) {
								// Match the existing below-cap tool fixture's classified error:
								// it contains no smaller numeric maximum to lower the effective window.
								expect(runtime.session.model?.contextWindow).toBe(1_000_000);
								expect(estimateTokens(saved.inputs[0].message)).toBeLessThan(1_000_000);
								expect(context.messages.filter((message) => message.role === "user").at(-1)?.content).toBe(
									payload,
								);
								expect(
									runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "context_edit"),
								).toEqual([]);
							}
							rawPrefix = readFileSync(saved.file);
						}
						// The actual provider refuses this input ALONE, including if it is
						// merely repackaged into a summary prompt. Never let a faux summary
						// answer hide an unchanged oversized accepted input.
						return request.includes(payload)
							? overflow
							: fauxAssistantMessage("answered after accepted-input repair");
					},
				),
			);

			await runtime.session.resumeUnsentInputs();
			await expect.poll(() => runtime.session.pendingMessageCount, { timeout: POLL_TIMEOUT }).toBe(0);
			await expect
				.poll(() => runtime.session.isIdle && !runtime.session.isSettling, { timeout: POLL_TIMEOUT })
				.toBe(true);

			// At 60k the native request guard spends the one recovery before the
			// provider can be called. At 1M only the provider discovers the overflow.
			expect(harness.faux.state.callCount).toBe(contextWindow === 60_000 ? 1 : 2);
			expect(runtime.session.getLastAssistantText()).toBe("answered after accepted-input repair");
			const raw = runtime.session.sessionManager.getEntries().find((entry) => entry.unsentInputId === saved.ids[0]);
			if (!raw || raw.type !== "message") throw new Error("Missing consumed raw accepted input");
			expect(getMessageText(raw.message)).toBe(payload);
			const edits = runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "context_edit" && entry.targetId === raw.id);
			expect(edits).toHaveLength(1);
			const toolIds = runtime.session.sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.id] : []));
			expect(
				runtime.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "context_edit" && toolIds.includes(entry.targetId)),
			).toEqual([]);
			if (smallTool) expect(requests.at(-1)).toContain(tinyResult);
			expect(runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
			const projected = SessionManager.open(saved.file).buildSessionProjection().messages;
			const projectedText = projected.map(getMessageText).join("\n");
			expect(projectedText).not.toContain(payload);
			expect(projectedText).toContain(raw.id);
			expect(projectedText).toMatch(/omitted|spill|stored|saved|stub/i);
			expect(requests.at(-1)).not.toContain(payload);
			expect(requests.at(-1)).toContain(raw.id);
			expect(rawPrefix.length).toBeGreaterThan(saved.prefix.length);
			expect(readFileSync(saved.file).subarray(0, rawPrefix.length).equals(rawPrefix)).toBe(true);
			expectPreservedJournal(runtime.session, saved, saved.ids);
		},
	);
});
