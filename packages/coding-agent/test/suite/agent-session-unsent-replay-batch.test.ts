import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

	async function createReplayRuntime(
		options: { contextWindow?: number; compaction?: boolean; extensions?: Array<(pi: ExtensionAPI) => void> } = {},
	) {
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
						...(options.extensions ?? []),
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
		cleanups.push(async () => {
			const file = runtime.session.sessionFile;
			await runtime.dispose({ operatorExit: true });
			// Optional local evidence capture before harness teardown removes fixtures.
			const evidence = process.env.PI337_F3_TRACE_DIR;
			if (evidence && file) {
				mkdirSync(evidence, { recursive: true });
				writeFileSync(join(evidence, `${runtime.session.sessionId}.jsonl`), readFileSync(file));
			}
		});
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

	// PR #337 F3: exercise the public NativeExtensionRunner boundary contract.
	// This portable fixture is not pi-better-compaction; the private integration
	// probe separately runs the pinned extension's real callbacks.
	it.each([
		{ recovery: "block rejection", shape: "16 plus suffix" },
		{ recovery: "affinity", shape: "16 plus suffix" },
		{ recovery: "block rejection", shape: "300 KiB singleton plus suffix" },
		{ recovery: "affinity", shape: "300 KiB singleton plus suffix" },
	])(
		"PR337 F3: $recovery retries the failed head before $shape and drains after recovery",
		async ({ recovery, shape }) => {
			const error =
				recovery === "block rejection"
					? "400 invalid signature in compaction block"
					: "409 compaction_affinity_missing";
			const trace: unknown[] = [];
			let checkpoint: string | undefined;
			let failedEntry: string | undefined;
			let resendRequested = false;
			let resends = 0;
			const { runtime, harness } = await createReplayRuntime({
				extensions: [
					(pi) => {
						pi.on("session_start", (_event, ctx) => {
							checkpoint = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.id;
						});
						pi.on("turn_end", (event, ctx) => {
							if (!checkpoint || event.message.role !== "assistant" || event.message.errorMessage !== error)
								return;
							failedEntry = event.messageEntryId;
							resendRequested = true;
							trace.push({ boundary: "turn_end", failedEntry, queued: ctx.getInputState().queued });
							return {
								entries: [
									{ type: "custom", customType: "test.replay-checkpoint-retired", data: { checkpoint } },
									{ type: "context_edit", targetId: failedEntry, replacement: null },
								],
							};
						});
						pi.on("agent_before_settle", (event, ctx) => {
							if (!resendRequested) return;
							resendRequested = false;
							resends++;
							trace.push({
								boundary: "agent_before_settle",
								outcome: event.outcome,
								queued: ctx.getInputState().queued,
								canContinue: event.context.canContinue,
							});
							return { continue: true };
						});
					},
				],
			});
			const singleton = shape.startsWith("300");
			const payload = singleton ? `fitting recovered head: ${"x".repeat(300 * 1024)}` : "recovered head";
			const saved = writeSavedInputs(
				harness.tempDir,
				[payload, ...Array.from({ length: 24 }, (_, index) => `follower ${index}`)],
				harness.getModel(),
				"followUp",
			);
			const manager = SessionManager.open(saved.file);
			const kept = manager.getBranch().findLast((entry) => entry.type === "message");
			if (!kept) throw new Error("Missing synthetic checkpoint boundary");
			const checkpointId = manager.appendCompaction("Readable synthetic checkpoint summary", kept.id, 100);
			saved.prefix = readFileSync(saved.file);
			await runtime.switchSession(saved.file);
			await runtime.session.bindExtensions({});
			expect(checkpoint).toBe(checkpointId); // First-reload bootstrap saw the persisted checkpoint.
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			expect(runtime.session.recoveredInputCount).toBe(25);
			expect(estimateTokens(saved.inputs[0].message)).toBeLessThan(1_000_000);
			if (singleton) expect(Buffer.byteLength(JSON.stringify(saved.inputs[0]), "utf8")).toBeGreaterThan(MAX_BYTES);
			runtime.session.setFollowUpMode("one-at-a-time");
			const observed = observeAdmissions(runtime.session, saved);
			const provider = answeringSavedInputs(saved);
			const requestHeads: Array<string | undefined> = [];
			harness.setResponses(
				Array.from(
					{ length: 28 },
					(): FauxResponseFactory => (context, options, state, model) => {
						// A compaction summary is serialized as a user message and can share a
						// timestamp with saved input. Observe exact occurrences, not that summary.
						provider.answer(
							{
								...context,
								messages: context.messages.filter(
									(message) =>
										message.role !== "user" ||
										saved.inputs.some(
											(input) =>
												input.message.timestamp === message.timestamp &&
												input.message.content === message.content,
										),
								),
							},
							options,
							state,
							model,
						);
						const users = context.messages.filter((message) => message.role === "user");
						requestHeads.push(saved.idByTimestamp.get(users.at(-1)?.timestamp ?? -1));
						trace.push({
							request: requestHeads.length,
							fresh: provider.requests.at(-1),
							head: requestHeads.at(-1),
						});
						if (requestHeads.length === 1) {
							expect(runtime.session.agent.getQueuedMessages()).toHaveLength(singleton ? 0 : 15);
							expect(runtime.session.recoveredInputCount).toBe(singleton ? 24 : 9);
							return fauxAssistantMessage("", { stopReason: "error", errorMessage: error });
						}
						// A resend must answer the same failed input without consuming a follower.
						if (requestHeads.length === 2) {
							expect(users.at(-1)?.content).toBe(payload);
							expect(
								context.messages.some(
									(message) => message.role === "assistant" && message.errorMessage === error,
								),
							).toBe(false);
						}
						return fauxAssistantMessage("recovered input answered");
					},
				),
			);
			const settled: string[] = [];
			runtime.session.subscribe((event) => {
				if (event.type === "agent_settled") settled.push(event.outcome);
			});
			await runtime.session.resumeUnsentInputs(); // Exactly one host resume, no manual continuation.
			await expect
				.poll(() => runtime.session.isIdle && !runtime.session.isSettling, { timeout: POLL_TIMEOUT })
				.toBe(true);
			observed.unsubscribe();
			console.info(
				"PR337_F3_BOUNDARY",
				JSON.stringify({
					recovery,
					shape,
					trace,
					resends,
					settled,
					calls: harness.faux.state.callCount,
					live: runtime.session.agent.getQueuedMessages().length,
					durable: runtime.session.recoveredInputCount,
					admissions: observed.admissions.map((batch) => batch.ids),
				}),
			);
			expect.soft(resends).toBe(1);
			expect.soft(requestHeads.slice(0, 2)).toEqual([saved.ids[0], saved.ids[0]]);
			expect.soft(provider.requests[1]).toEqual([]);
			expect.soft(harness.faux.state.callCount).toBe(26);
			expect.soft(provider.delivered).toEqual(saved.ids);
			expect.soft(runtime.session.pendingMessageCount).toBe(0);
			expect.soft(runtime.session.recoveredInputCount).toBe(0);
			expect.soft(runtime.session.agent.getQueuedMessages()).toEqual([]);
			expect.soft(settled.every((outcome) => outcome === "completed")).toBe(true);
			expect.soft(observed.admissions.flatMap((batch) => batch.ids)).toEqual(saved.ids);
			for (const batch of observed.admissions) {
				expect(batch.queuedIds).toEqual(batch.ids);
				expect(batch.ids.length).toBeLessThanOrEqual(MAX_COUNT);
				if (batch.ids.length > 1) expect(batch.bytes).toBeLessThanOrEqual(MAX_BYTES);
			}
			const entries = runtime.session.sessionManager.getEntries();
			expect(
				entries.filter((entry) => entry.type === "custom" && entry.customType === "test.replay-checkpoint-retired"),
			).toHaveLength(1);
			expect(entries.filter((entry) => entry.type === "context_edit")).toMatchObject([
				{ targetId: failedEntry, replacement: null },
			]);
			expect(entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expectPreservedJournal(runtime.session, saved, provider.delivered);
		},
	);

	// PR #337 F3 counterexamples: recovery is bounded, not permission to drain
	// unrelated accepted work after an extension declines or its resend fails.
	it.each([
		{ decision: "declines", singleton: false },
		{ decision: "declines", singleton: true },
		{ decision: "resend fails", singleton: false },
		{ decision: "resend fails", singleton: true },
	])(
		"PR337 F3: extension $decision preserves all 24 followers (singleton: $singleton)",
		async ({ decision, singleton }) => {
			let pending = false;
			let failedEntry: string | undefined;
			let resends = 0;
			const { runtime, harness } = await createReplayRuntime({
				extensions: [
					(pi) => {
						pi.on("turn_end", (event) => {
							if (
								decision === "declines" ||
								failedEntry ||
								event.message.role !== "assistant" ||
								event.message.stopReason !== "error"
							)
								return;
							failedEntry = event.messageEntryId;
							pending = true;
							return { entries: [{ type: "context_edit", targetId: failedEntry, replacement: null }] };
						});
						pi.on("agent_before_settle", () => {
							if (!pending) return;
							pending = false;
							resends++;
							return { continue: true };
						});
					},
				],
			});
			const saved = writeSavedInputs(
				harness.tempDir,
				[
					singleton ? "x".repeat(300 * 1024) : "small recovered head",
					...Array.from({ length: 24 }, (_, index) => `remain pending ${index}`),
				],
				harness.getModel(),
				"followUp",
			);
			await runtime.switchSession(saved.file);
			await runtime.session.bindExtensions({});
			runtime.session.setFollowUpMode("one-at-a-time");
			const provider = answeringSavedInputs(saved);
			harness.setResponses(
				Array.from(
					{ length: 28 },
					(): FauxResponseFactory => (context, options, state, model) => {
						provider.answer(context, options, state, model);
						return fauxAssistantMessage("", {
							stopReason: "error",
							errorMessage: "invalid request: permanent failure",
						});
					},
				),
			);
			const settled: string[] = [];
			runtime.session.subscribe((event) => {
				if (event.type === "agent_settled") settled.push(event.outcome);
			});
			await runtime.session.resumeUnsentInputs();
			await expect
				.poll(() => runtime.session.isIdle && !runtime.session.isSettling, { timeout: POLL_TIMEOUT })
				.toBe(true);
			console.info(
				"PR337_F3_BOUNDED_FAILURE",
				JSON.stringify({
					decision,
					singleton,
					resends,
					settled,
					requests: provider.requests,
					live: runtime.session.agent.getQueuedMessages().length,
					durable: runtime.session.recoveredInputCount,
				}),
			);
			expect.soft(resends).toBe(decision === "declines" ? 0 : 1);
			expect.soft(harness.faux.state.callCount).toBe(decision === "declines" ? 1 : 2);
			expect(provider.delivered).toEqual([saved.ids[0]]);
			expect(runtime.session.pendingMessageCount).toBe(24);
			expect(runtime.session.agent.getQueuedMessages()).toHaveLength(singleton ? 0 : 15);
			expect(runtime.session.recoveredInputCount).toBe(singleton ? 24 : 9);
			expect(settled.at(-1)).toBe("error");
			expectPreservedJournal(runtime.session, saved, [saved.ids[0]]);
			runtime.session.prepareOperatorExit()();
			await runtime.newSession();
			await runtime.session.bindExtensions({});
			await runtime.switchSession(saved.file);
			await runtime.session.bindExtensions({});
			expect(runtime.session.pendingMessageCount).toBe(24);
			expect(runtime.session.recoveredInputCount).toBe(24);
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			expectPreservedJournal(runtime.session, saved, [saved.ids[0]]);
		},
	);

	// smarty-dev#19998, frozen review Finding 3: a successful unrelated live turn
	// must not erase the permanent failure of a recovered singleton batch.
	it("P1 finding 3: permanent singleton replay failure keeps fresh live execution but stops the 24 durable followers through reopen", async () => {
		const { runtime, harness, getContext } = await createReplayRuntime();
		const payload = `accepted singleton: ${"x".repeat(300 * 1024)}`;
		const duplicate = "same text, separate pending occurrence";
		const saved = writeSavedInputs(
			harness.tempDir,
			[
				payload,
				...Array.from({ length: 24 }, (_, index) => (index % 8 === 0 ? duplicate : `saved follower ${index}`)),
			],
			harness.getModel(),
			"followUp",
		);
		expect(Buffer.byteLength(JSON.stringify(saved.inputs[0]), "utf8")).toBeGreaterThan(MAX_BYTES);
		expect(estimateTokens(saved.inputs[0].message)).toBeLessThan(1_000_000);
		await runtime.switchSession(saved.file);
		await runtime.session.bindExtensions({});
		runtime.session.setFollowUpMode("all");
		const observed = observeAdmissions(runtime.session, saved);
		const provider = answeringSavedInputs(saved);
		const sequence: string[] = [];
		const turns: string[] = [];
		let freshDelivered = false;
		let releaseHead = () => {};
		const headReleased = new Promise<void>((resolve) => {
			releaseHead = resolve;
		});
		let headEntered = () => {};
		const headStarted = new Promise<void>((resolve) => {
			headEntered = resolve;
		});
		runtime.session.subscribe((event) => {
			if (event.type === "agent_settled") turns.push(event.outcome);
		});
		harness.setResponses([
			async (context, options, state, model) => {
				provider.answer(context, options, state, model);
				sequence.push("recovered head: permanent non-overflow error");
				headEntered();
				await headReleased;
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "invalid request: permanent failure",
				});
			},
			...Array.from(
				{ length: 26 },
				(): FauxResponseFactory => (context, options, state, model) => {
					// Live timestamps can coincide with a saved timestamp. Keep this
					// recovered-only observer separate from the ordinary live occurrence.
					provider.answer(
						{
							...context,
							messages: context.messages.filter((message) => getMessageText(message) !== "fresh live input"),
						},
						options,
						state,
						model,
					);
					const fresh =
						!freshDelivered &&
						context.messages.some(
							(message) => message.role === "user" && getMessageText(message) === "fresh live input",
						);
					if (fresh) freshDelivered = true;
					sequence.push(
						fresh
							? "ordinary fresh live input: completed"
							: `recovered followers: ${provider.requests.at(-1)?.length}`,
					);
					return fauxAssistantMessage(fresh ? "fresh ordinary answered" : "saved follower answered");
				},
			),
		]);

		const replay = runtime.session.resumeUnsentInputs(); // Exactly one explicit resume.
		try {
			await headStarted;
			expect(runtime.session.model?.contextWindow).toBe(1_000_000);
			expect(runtime.session.isStreaming).toBe(true);
			expect(provider.requests).toEqual([[saved.ids[0]]]);
			expect(observed.admissions.map((batch) => batch.ids)).toEqual([[saved.ids[0]]]);
			expect(runtime.session.recoveredInputCount).toBe(24);
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			await runtime.session.followUp("fresh live input");
			expect(runtime.session.agent.getQueuedMessages().map(getMessageText)).toEqual(["fresh live input"]);
			expect(getContext().getInputState()).toMatchObject({ queued: 1, drained: false });
		} finally {
			releaseHead();
			await replay;
		}
		await expect
			.poll(() => runtime.session.isIdle && !runtime.session.isSettling, { timeout: POLL_TIMEOUT })
			.toBe(true);
		observed.unsubscribe();
		console.info(
			"P1_FINDING_3",
			JSON.stringify({
				sequence,
				deliveredRecovered: provider.delivered.length,
				remaining: runtime.session.pendingMessageCount,
				settled: turns,
			}),
		);

		// Soft checks retain the complete operator-exit/reopen custody observations
		// even on the immutable RED baseline, without weakening the failure oracle.
		expect.soft(freshDelivered).toBe(true);
		expect
			.soft(sequence)
			.toEqual(["recovered head: permanent non-overflow error", "ordinary fresh live input: completed"]);
		expect.soft(provider.delivered).toEqual([saved.ids[0]]);
		expect.soft(observed.admissions.map((batch) => batch.ids)).toEqual([[saved.ids[0]]]);
		expect.soft(harness.faux.state.callCount).toBe(2);
		expect.soft(runtime.session.recoveredInputCount).toBe(24);
		expect.soft(runtime.session.pendingMessageCount).toBe(24);
		expect.soft(runtime.session.agent.getQueuedMessages()).toEqual([]);
		expect.soft(getContext().hasPendingMessages()).toBe(false);
		expect.soft(getContext().getInputState()).toMatchObject({ inputAdmissionCount: 0, queued: 0, drained: true });
		expect(
			runtime.session.messages.filter(
				(message) => message.role === "user" && getMessageText(message) === "fresh live input",
			),
		).toHaveLength(1);
		expect(
			runtime.session.messages.filter(
				(message) => message.role === "assistant" && getMessageText(message) === "fresh ordinary answered",
			),
		).toHaveLength(1);
		expect(runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toEqual([]);
		expect(runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expectPreservedJournal(runtime.session, saved, provider.delivered);
		runtime.session.prepareOperatorExit()();
		expectPreservedJournal(runtime.session, saved, provider.delivered);
		await runtime.newSession();
		await runtime.session.bindExtensions({});
		await runtime.switchSession(saved.file);
		await runtime.session.bindExtensions({});
		expect.soft(runtime.session.recoveredInputCount).toBe(24);
		expect.soft(runtime.session.pendingMessageCount).toBe(24);
		expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
		expect(getContext().hasPendingMessages()).toBe(false);
		expect(getContext().getInputState()).toMatchObject({ inputAdmissionCount: 0, queued: 0, drained: true });
		expectPreservedJournal(runtime.session, saved, provider.delivered);
		expect.soft(harness.faux.state.callCount).toBe(2);
	});

	// smarty-dev#19998: the replay stop must not change ordinary live-only input.
	it("P1 finding 3: ordinary live-only permanent error still executes its accepted fresh follow-up", async () => {
		const { runtime, harness, getContext } = await createReplayRuntime();
		let releaseHead = () => {};
		const headReleased = new Promise<void>((resolve) => {
			releaseHead = resolve;
		});
		let headEntered = () => {};
		const headStarted = new Promise<void>((resolve) => {
			headEntered = resolve;
		});
		const sequence: string[] = [];
		harness.setResponses([
			async () => {
				sequence.push("ordinary head: permanent non-overflow error");
				headEntered();
				await headReleased;
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "invalid request: permanent failure",
				});
			},
			(context) => {
				expect(context.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
					"ordinary live head",
					"fresh live input",
				]);
				sequence.push("ordinary fresh live input: completed");
				return fauxAssistantMessage("fresh ordinary answered");
			},
		]);
		const prompt = runtime.session.prompt("ordinary live head");
		try {
			await headStarted;
			await runtime.session.followUp("fresh live input");
			expect(runtime.session.agent.getQueuedMessages().map(getMessageText)).toEqual(["fresh live input"]);
		} finally {
			releaseHead();
			await prompt;
		}
		await expect
			.poll(() => runtime.session.isIdle && !runtime.session.isSettling, { timeout: POLL_TIMEOUT })
			.toBe(true);
		expect(sequence).toEqual(["ordinary head: permanent non-overflow error", "ordinary fresh live input: completed"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(runtime.session.getLastAssistantText()).toBe("fresh ordinary answered");
		expect(
			runtime.session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error"),
		).toHaveLength(1);
		expect(runtime.session.recoveredInputCount).toBe(0);
		expect(runtime.session.pendingMessageCount).toBe(0);
		expect(getContext().getInputState()).toMatchObject({ inputAdmissionCount: 0, queued: 0, drained: true });
		expect(runtime.session.sessionManager.getEntries().filter((entry) => entry.unsentInputId)).toEqual([]);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
		).toEqual([]);
	});

	// smarty-dev#19998: a transient context overflow that is actually repaired is
	// not a terminal replay failure, even with unrelated live work interleaved.
	it("P1 finding 3: successful bounded overflow repair plus fresh live success still drains the 24 durable followers", async () => {
		const { runtime, harness } = await createReplayRuntime({ compaction: true });
		const payload = `accepted singleton: ${"x".repeat(300 * 1024)}`;
		const saved = writeSavedInputs(
			harness.tempDir,
			[
				payload,
				...Array.from({ length: 24 }, (_, index) =>
					index % 8 === 0 ? "same text, separate pending occurrence" : `saved follower ${index}`,
				),
			],
			harness.getModel(),
			"followUp",
		);
		await runtime.switchSession(saved.file);
		await runtime.session.bindExtensions({});
		runtime.session.setFollowUpMode("all");
		const observed = observeAdmissions(runtime.session, saved);
		const provider = answeringSavedInputs(saved);
		const overflow = fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
		overflow.recovery = { recovery: "context_length_exceeded", retryable: false };
		let releaseHead = () => {};
		const headReleased = new Promise<void>((resolve) => {
			releaseHead = resolve;
		});
		let headEntered = () => {};
		const headStarted = new Promise<void>((resolve) => {
			headEntered = resolve;
		});
		const requests: Array<{ unchangedPayload: boolean; freshLive: boolean }> = [];
		let overflowCount = 0;
		let freshSuccess = false;
		let rawPrefix = Buffer.alloc(0);
		harness.setResponses(
			Array.from(
				{ length: 28 },
				(): FauxResponseFactory => async (context, options, state, model) => {
					// Observe recovered identities without treating a coincident live
					// timestamp as the saved occurrence with that timestamp.
					provider.answer(
						{
							...context,
							messages: context.messages.filter((message) => getMessageText(message) !== "fresh live input"),
						},
						options,
						state,
						model,
					);
					const unchangedPayload = JSON.stringify(context.messages).includes(payload);
					const freshLive = context.messages.some(
						(message) => message.role === "user" && getMessageText(message) === "fresh live input",
					);
					requests.push({ unchangedPayload, freshLive });
					if (requests.length === 1) {
						rawPrefix = readFileSync(saved.file);
						headEntered();
						await headReleased;
					}
					// Reject unchanged giant content even inside a summary request.
					if (unchangedPayload) {
						overflowCount++;
						return overflow;
					}
					if (freshLive) freshSuccess = true;
					return fauxAssistantMessage(
						freshLive ? "fresh ordinary answered after repair" : "saved follower answered",
					);
				},
			),
		);
		const replay = runtime.session.resumeUnsentInputs(); // No second resume or manual repair.
		try {
			await headStarted;
			expect(runtime.session.model?.contextWindow).toBe(1_000_000);
			expect(estimateTokens(saved.inputs[0].message)).toBeLessThan(1_000_000);
			expect(provider.requests).toEqual([[saved.ids[0]]]);
			expect(observed.admissions.map((batch) => batch.ids)).toEqual([[saved.ids[0]]]);
			expect(runtime.session.recoveredInputCount).toBe(24);
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			await runtime.session.followUp("fresh live input");
			expect(runtime.session.agent.getQueuedMessages().map(getMessageText)).toEqual(["fresh live input"]);
		} finally {
			releaseHead();
			await replay;
		}
		await expect.poll(() => runtime.session.pendingMessageCount, { timeout: POLL_TIMEOUT }).toBe(0);
		await expect
			.poll(() => runtime.session.isIdle && !runtime.session.isSettling, { timeout: POLL_TIMEOUT })
			.toBe(true);
		observed.unsubscribe();
		expect(requests[0]).toEqual({ unchangedPayload: true, freshLive: false });
		expect(requests.slice(1).every((request) => !request.unchangedPayload)).toBe(true);
		expect(overflowCount).toBe(1);
		expect(freshSuccess).toBe(true);
		expect(provider.delivered).toEqual(saved.ids);
		expectBoundedAdmissions(observed, saved);
		expect(runtime.session.recoveredInputCount).toBe(0);
		expect(
			runtime.session.messages.filter(
				(message) => message.role === "user" && getMessageText(message) === "fresh live input",
			),
		).toHaveLength(1);
		const raw = runtime.session.sessionManager.getEntries().find((entry) => entry.unsentInputId === saved.ids[0]);
		if (!raw || raw.type !== "message") throw new Error("Missing consumed recovered singleton");
		expect(getMessageText(raw.message)).toBe(payload);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "context_edit" && entry.targetId === raw.id),
		).toHaveLength(1);
		expect(runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(readFileSync(saved.file).subarray(0, rawPrefix.length).equals(rawPrefix)).toBe(true);
		expectPreservedJournal(runtime.session, saved, saved.ids);
		runtime.session.prepareOperatorExit()();
		const calls = harness.faux.state.callCount;
		await runtime.newSession();
		await runtime.session.bindExtensions({});
		await runtime.switchSession(saved.file);
		await runtime.session.bindExtensions({});
		expect(runtime.session.recoveredInputCount).toBe(0);
		expect(runtime.session.pendingMessageCount).toBe(0);
		expect(harness.faux.state.callCount).toBe(calls);
		expectPreservedJournal(runtime.session, saved, saved.ids);
	});

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
