import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join, parse } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { UNSENT_INPUT_TYPE } from "../../src/core/unsent-input.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.ts";
import { createHarness, getMessageText } from "./harness.ts";

// Deliberate contract assertions, also runnable against the pre-fix source for red evidence.
const UNSENT_INPUT_REPLAY_MAX_COUNT = 16;
const UNSENT_INPUT_REPLAY_MAX_BYTES = 256 * 1024;

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: { cwd?: string; bootstrapModel?: boolean; bootstrapThinkingLevel?: boolean; configuredAuth?: boolean },
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		if (options?.configuredAuth !== false) {
			await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		}

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: options?.configuredAuth === false ? undefined : "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
					thinkingLevel: runtimeOptions.thinkingLevel,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir };
	}

	function writeRecoveredSession(
		tempDir: string,
		count: number,
		text: string,
		model: { provider: string; id: string },
		mode: "steer" | "followUp" = "steer",
	) {
		const manager = SessionManager.create(tempDir, join(tempDir, "recovered"));
		manager.appendModelChange(model.provider, model.id);
		manager.appendMessage({ role: "user", content: "previous request", timestamp: Date.now() - 10_000 });
		manager.appendMessage(fauxAssistantMessage("previous answer"));
		const file = manager.getSessionFile()!;
		const origin = { sessionId: manager.getSessionId(), host: hostname(), uid: userInfo().uid };
		let parentId = manager.getLeafId();
		const ids: string[] = [];
		const lines = Array.from({ length: count }, (_, index) => {
			const id = `saved-input-${index}`;
			ids.push(id);
			const entry = {
				type: "custom",
				id,
				parentId,
				timestamp: new Date().toISOString(),
				customType: UNSENT_INPUT_TYPE,
				data: {
					mode,
					message: { role: "user", content: text, timestamp: Date.now() + index },
					origin,
				},
			};
			parentId = id;
			return JSON.stringify(entry);
		});
		writeFileSync(file, `${readFileSync(file, "utf8")}${lines.join("\n")}\n`);
		return { file, ids, prefix: readFileSync(file) };
	}

	// smarty-dev#19998: a real destination journal must cross the runtime's receiving fence
	// before any saved input is materialized. Identical accepted texts have distinct outbox IDs.
	it("resumes 38,500 saved inputs with an empty bootstrap queue and successive bounded replay batches", async () => {
		let context!: ExtensionContext;
		let batches = 0;
		const settledBatches: Array<{ recovered: number; pending: number; notice: string[]; hasPending: boolean }> = [];
		const { runtime, faux, tempDir } = await createRuntimeForTest((pi) => {
			pi.on("session_start", (_event, ctx) => {
				context = ctx;
			});
			// Exercise the next automatic batch, then cancel through the real native boundary.
			// Never run all 2,407 batches in this stress fixture or consume ahead after abort.
			pi.on("agent_before_settle", (_event, ctx) => {
				if (++batches === 2) ctx.abort();
			});
			pi.on("agent_settled", (_event, ctx) => {
				settledBatches.push({
					recovered: runtime.session.recoveredInputCount,
					pending: runtime.session.pendingMessageCount,
					notice: [...runtime.session.getFollowUpMessages()],
					hasPending: ctx.hasPendingMessages(),
				});
			});
		});
		const text = "same text, distinct accepted occurrences";
		const saved = writeRecoveredSession(tempDir, 38_500, text, faux.getModel());
		faux.setResponses(Array.from({ length: 40 }, () => fauxAssistantMessage("replayed")));

		await expect(runtime.switchSession(saved.file)).resolves.toEqual({ cancelled: false });
		expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
		expect(runtime.session.getSteeringMessages()).toEqual([]);
		expect(runtime.session.recoveredInputCount).toBe(38_500);
		expect(runtime.session.pendingMessageCount).toBe(38_500);
		expect(runtime.session.getFollowUpMessages()).toEqual(["38,500 recovered inputs remain saved in this session"]);
		expect(faux.state.callCount).toBe(0);
		await runtime.session.bindExtensions({});
		expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
		expect(context.sessionManager.getSessionId()).toBe(runtime.session.sessionId);
		expect(context.getInputState()).toEqual({
			inputsFenced: false,
			inputAdmissionCount: 0,
			queued: 0,
			drained: true,
		});
		// smarty-dev#19998: Fabric's idle wake must not mistake saved outboxes for live work.
		expect(context.hasPendingMessages()).toBe(false);
		expect(context.isIdle() && !context.isSettling() && !context.isPromptPending()).toBe(true);
		const release = await runtime.session.fenceInputs();
		try {
			await expect(runtime.session.resumeUnsentInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_FENCED" });
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
		} finally {
			release();
		}
		runtime.session.setSteeringMode("all");
		let peakCount = 0;
		let peakBytes = 0;
		const unsubscribe = runtime.session.subscribe((event) => {
			if (event.type !== "queue_update") return;
			const queued = runtime.session.agent.getQueuedMessages();
			peakCount = Math.max(peakCount, queued.length);
			peakBytes = Math.max(
				peakBytes,
				queued.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)), 0),
			);
		});
		await runtime.session.resumeUnsentInputs();
		unsubscribe();

		expect(peakCount).toBe(UNSENT_INPUT_REPLAY_MAX_COUNT);
		expect(peakBytes).toBeLessThanOrEqual(UNSENT_INPUT_REPLAY_MAX_BYTES);
		expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
		expect(settledBatches).toHaveLength(2);
		expect(settledBatches[0]).toEqual({
			recovered: 38_484,
			pending: 38_484,
			notice: ["38,484 recovered inputs remain saved in this session"],
			hasPending: false,
		});
		expect(settledBatches[1]).toEqual({
			recovered: 38_468,
			pending: 38_468,
			notice: ["38,468 recovered inputs remain saved in this session"],
			hasPending: false,
		});
		expect(runtime.session.recoveredInputCount).toBe(38_500 - 2 * UNSENT_INPUT_REPLAY_MAX_COUNT);
		expect(runtime.session.pendingMessageCount).toBe(38_500 - 2 * UNSENT_INPUT_REPLAY_MAX_COUNT);
		expect(runtime.session.getFollowUpMessages()).toEqual(["38,468 recovered inputs remain saved in this session"]);
		expect(context.getInputState()).toEqual({
			inputsFenced: false,
			inputAdmissionCount: 0,
			queued: 0,
			drained: true,
		});
		expect(context.hasPendingMessages()).toBe(false);
		expect(context.isIdle() && !context.isSettling() && !context.isPromptPending()).toBe(true);

		await runtime.session.followUp("live input alongside saved recovery");
		expect(runtime.session.pendingMessageCount).toBe(38_469);
		expect(context.getInputState()).toMatchObject({ inputAdmissionCount: 0, queued: 1, drained: false });
		expect(context.hasPendingMessages()).toBe(true);
		await expect(context.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
		expect(runtime.session.clearQueue()).toEqual({
			steering: [],
			followUp: ["live input alongside saved recovery"],
		});
		expect(runtime.session.pendingMessageCount).toBe(38_468);
		expect(context.hasPendingMessages()).toBe(false);

		let delivered = runtime.session.sessionManager.getEntries().filter((entry) => entry.unsentInputId);
		expect(delivered.map((entry) => entry.unsentInputId)).toEqual(
			saved.ids.slice(0, 2 * UNSENT_INPUT_REPLAY_MAX_COUNT),
		);
		expect(
			delivered.filter(
				(entry) => entry.type === "message" && entry.message.role === "user" && entry.message.content === text,
			),
		).toHaveLength(2 * UNSENT_INPUT_REPLAY_MAX_COUNT);
		expect(readFileSync(saved.file).subarray(0, saved.prefix.length).equals(saved.prefix)).toBe(true);
		runtime.session.prepareOperatorExit()();
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
		).toHaveLength(38_500);

		// Reopening skips linked occurrences, not matching text. Admit two more automatic
		// batches, then cancel again: all other IDs must remain durable and unconsumed.
		batches = 0;
		settledBatches.length = 0;
		await runtime.newSession();
		await runtime.session.bindExtensions({});
		await runtime.switchSession(saved.file);
		await runtime.session.bindExtensions({});
		expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
		expect(runtime.session.recoveredInputCount).toBe(38_500 - 2 * UNSENT_INPUT_REPLAY_MAX_COUNT);
		runtime.session.setSteeringMode("all");
		await runtime.session.resumeUnsentInputs();
		expect(settledBatches).toHaveLength(2);
		delivered = runtime.session.sessionManager.getEntries().filter((entry) => entry.unsentInputId);
		expect(delivered.map((entry) => entry.unsentInputId)).toEqual(
			saved.ids.slice(0, 4 * UNSENT_INPUT_REPLAY_MAX_COUNT),
		);
		expect(new Set(delivered.map((entry) => entry.unsentInputId)).size).toBe(4 * UNSENT_INPUT_REPLAY_MAX_COUNT);
		expect(runtime.session.recoveredInputCount).toBe(38_500 - 4 * UNSENT_INPUT_REPLAY_MAX_COUNT);
		expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
		runtime.session.prepareOperatorExit()();
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
		).toHaveLength(38_500);
		expect(readFileSync(saved.file).subarray(0, saved.prefix.length).equals(saved.prefix)).toBe(true);
	}, 30_000);

	// smarty-dev#19998: excluding durable recovery must not hide actual live input or relax its fence.
	it.each(["steer", "followUp"] as const)(
		"reports live %s admission and its queue as pending through the public extension context",
		async (mode) => {
			let context!: ExtensionContext;
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (_event, ctx) => {
							context = ctx;
						});
						pi.on("input", async () => {
							await held;
							return { action: "continue" };
						});
					},
				],
			});
			cleanups.push(harness.cleanup);
			await harness.session.bindExtensions({});
			expect(context.hasPendingMessages()).toBe(false);

			const input = harness.session[mode]("live input");
			try {
				expect(context.getInputState()).toEqual({
					inputsFenced: false,
					inputAdmissionCount: 1,
					queued: 0,
					drained: false,
				});
				expect(context.hasPendingMessages()).toBe(true);
				await expect(context.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
			} finally {
				release();
				await input;
			}

			expect(context.getInputState()).toEqual({
				inputsFenced: false,
				inputAdmissionCount: 0,
				queued: 1,
				drained: false,
			});
			expect(context.hasPendingMessages()).toBe(true);
			await expect(context.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
			harness.session.clearQueue();
			expect(context.hasPendingMessages()).toBe(false);
		},
	);

	// smarty-dev#19998: the byte bound is independent of the occurrence-count bound.
	it("automatically drains byte-bounded batches and never re-saves linked replay input", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {});
		const saved = writeRecoveredSession(tempDir, 3, "🙂".repeat(35_000), faux.getModel());
		await runtime.switchSession(saved.file);
		await runtime.session.bindExtensions({});
		let peakBytes = 0;
		runtime.session.subscribe((event) => {
			if (event.type === "queue_update")
				peakBytes = Math.max(
					peakBytes,
					runtime.session.agent
						.getQueuedMessages()
						.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)), 0),
				);
		});

		await runtime.session.resumeUnsentInputs();

		expect(peakBytes).toBeGreaterThan(130_000);
		expect(peakBytes).toBeLessThanOrEqual(UNSENT_INPUT_REPLAY_MAX_BYTES);
		expect(runtime.session.recoveredInputCount).toBe(0);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.unsentInputId)
				.map((entry) => entry.unsentInputId),
		).toEqual(saved.ids);
		runtime.session.prepareOperatorExit()();
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
		).toHaveLength(3);
		expect(readFileSync(saved.file).subarray(0, saved.prefix.length).equals(saved.prefix)).toBe(true);
	});

	// smarty-dev#19998: interrupted materialized input already has durable outbox custody.
	it("does not duplicate outboxes when an interrupted replay batch is saved and reopened", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {});
		const saved = writeRecoveredSession(tempDir, 25, "same accepted text", faux.getModel(), "followUp");
		await runtime.switchSession(saved.file);
		await runtime.session.bindExtensions({});
		let aborted: Promise<void> | undefined;
		faux.setResponses([
			() => {
				aborted = runtime.session.abort();
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);

		await runtime.session.resumeUnsentInputs();
		await aborted;

		expect(faux.state.callCount).toBe(1);
		expect(runtime.session.agent.getQueuedMessages()).toHaveLength(UNSENT_INPUT_REPLAY_MAX_COUNT - 1);
		expect(runtime.session.recoveredInputCount).toBe(25 - UNSENT_INPUT_REPLAY_MAX_COUNT);
		runtime.session.prepareOperatorExit()();
		expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
		).toHaveLength(25);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.unsentInputId)
				.map((entry) => entry.unsentInputId),
		).toEqual([saved.ids[0]]);

		await runtime.newSession();
		await runtime.session.bindExtensions({});
		await runtime.switchSession(saved.file);
		await runtime.session.bindExtensions({});
		expect(runtime.session.recoveredInputCount).toBe(24);
		expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
		faux.setResponses(Array.from({ length: 24 }, () => fauxAssistantMessage("accepted input answered")));
		await runtime.session.resumeUnsentInputs();
		const delivered = runtime.session.sessionManager.getEntries().filter((entry) => entry.unsentInputId);
		expect(delivered.map((entry) => entry.unsentInputId)).toEqual(saved.ids);
		expect(new Set(delivered.map((entry) => entry.unsentInputId)).size).toBe(25);
		expect(runtime.session.recoveredInputCount).toBe(0);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
		).toHaveLength(25);
	});

	// smarty-dev#19998: an item above the ordinary byte bound must be delivered alone, not starved.
	it("delivers a single over-budget saved input as its own batch without changing raw history", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {});
		// This fixture isolates the replay byte bound, not post-answer threshold summarization.
		runtime.session.setAutoCompactionEnabled(false);
		const saved = writeRecoveredSession(tempDir, 1, "x".repeat(UNSENT_INPUT_REPLAY_MAX_BYTES + 1), faux.getModel());
		await runtime.switchSession(saved.file);
		await runtime.session.bindExtensions({});

		await expect(runtime.session.resumeUnsentInputs()).resolves.toBeUndefined();

		expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
		expect(runtime.session.recoveredInputCount).toBe(0);
		expect(runtime.session.pendingMessageCount).toBe(0);
		expect(runtime.session.getFollowUpMessages()).toEqual([]);
		expect(faux.state.callCount).toBe(1);
		expect(
			runtime.session.sessionManager
				.getEntries()
				.filter((entry) => entry.unsentInputId)
				.map((entry) => entry.unsentInputId),
		).toEqual(saved.ids);
		expect(readFileSync(saved.file).subarray(0, saved.prefix.length).equals(saved.prefix)).toBe(true);
	});

	// smarty-dev#19998: session_start work may already own the native run when the host resumes input.
	it.each(["completed", "error", "aborted"] as const)(
		"defers replay behind a busy startup wake (%s)",
		async (outcome) => {
			const { runtime, faux, tempDir } = await createRuntimeForTest(() => {});
			const saved = writeRecoveredSession(tempDir, 2, "accepted before operator exit", faux.getModel());
			await runtime.switchSession(saved.file);
			await runtime.session.bindExtensions({});
			let started = () => {};
			const startedPromise = new Promise<void>((resolve) => {
				started = resolve;
			});
			let release = () => {};
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			faux.setResponses([
				async () => {
					started();
					await released;
					return outcome === "completed"
						? fauxAssistantMessage("startup wake answered")
						: fauxAssistantMessage("", {
								stopReason: outcome,
								errorMessage: outcome === "error" ? "permanent provider failure" : undefined,
							});
				},
				fauxAssistantMessage("resumed accepted input"),
				fauxAssistantMessage("resumed accepted input"),
			]);
			const wake = runtime.session.prompt("startup wake");
			await startedPromise;
			try {
				await expect(runtime.session.resumeUnsentInputs()).resolves.toBeUndefined();
				expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
				expect(runtime.session.recoveredInputCount).toBe(2);
				expect(faux.state.callCount).toBe(1);
			} finally {
				release();
				await wake;
			}
			const delivered = runtime.session.sessionManager.getEntries().filter((entry) => entry.unsentInputId);
			expect(delivered).toHaveLength(outcome === "completed" ? 2 : 0);
			expect(runtime.session.recoveredInputCount).toBe(outcome === "completed" ? 0 : 2);
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			expect(runtime.session.isIdle).toBe(true);
		},
	);

	// smarty-dev#19998, frozen review Finding 1: resume must own the real input-admission
	// interval before provider entry, including a successful handler that consumes startup input.
	it.each(["completed", "handled", "failed", "aborted"] as const)(
		"automatically resumes saved inputs after startup input preflight (%s)",
		async (outcome) => {
			let context!: ExtensionContext;
			let entered = () => {};
			const enteredPromise = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let drained = () => {};
			const drainedPromise = new Promise<void>((resolve) => {
				drained = resolve;
			});
			const startupText = "ordinary startup prompt held before provider entry";
			const { runtime, faux, tempDir } = await createRuntimeForTest(
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						context = ctx;
					});
					pi.on("input", async (event) => {
						if (event.text !== startupText) return { action: "continue" };
						entered();
						await held;
						return { action: outcome === "handled" ? "handled" : "continue" };
					});
					pi.on("agent_settled", () => {
						if (runtime.session.recoveredInputCount === 0) drained();
					});
				},
				{ configuredAuth: outcome !== "failed" },
			);
			const savedText = "equal text, distinct startup recovery occurrences";
			const saved = writeRecoveredSession(tempDir, 35, savedText, faux.getModel(), "followUp");
			await runtime.switchSession(saved.file);
			await runtime.session.bindExtensions({});
			runtime.session.setAutoCompactionEnabled(false);
			runtime.session.setFollowUpMode("all");
			faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("native startup/replay answer")));
			const snapshots: Array<{ count: number; bytes: number }> = [];
			const unsubscribe = runtime.session.subscribe((event) => {
				if (event.type !== "queue_update") return;
				const queued = [...runtime.session.agent.getQueuedMessages()];
				snapshots.push({
					count: queued.length,
					bytes: queued.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)), 0),
				});
			});
			cleanups.push(unsubscribe);
			const within = async (promise: Promise<unknown>, label: string) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						promise,
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(() => reject(new Error(label)), 2_000);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}
			};
			const wake = runtime.session.prompt(startupText);
			// Attach rejection handling before cancellation/auth rejection can occur.
			const wakeResult = wake.then(
				() => undefined,
				(error: unknown) => error,
			);
			try {
				await within(enteredPromise, "startup did not enter the native input handler");
				expect(context.getInputState()).toEqual({
					inputsFenced: false,
					inputAdmissionCount: 1,
					queued: 0,
					drained: false,
				});
				expect(runtime.session.isIdle).toBe(false);
				expect(runtime.session.isPromptPending).toBe(true);
				expect(runtime.session.isStreaming).toBe(false);
				expect(runtime.session.isSettling).toBe(false);
				expect(faux.state.callCount).toBe(0);
				// Exactly one host resume, while real SDK admission is held; no provider-start wait.
				await expect(runtime.session.resumeUnsentInputs()).resolves.toBeUndefined();
				expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
				expect(runtime.session.recoveredInputCount).toBe(35);
				expect(faux.state.callCount).toBe(0);
				if (outcome === "aborted") await runtime.session.abort();
			} finally {
				release();
			}
			const result = await wakeResult;
			const succeeds = outcome === "completed" || outcome === "handled";
			if (succeeds) expect(result).toBeUndefined();
			else if (outcome === "aborted") expect(result).toMatchObject({ code: "INPUT_ADMISSION_ABORTED" });
			else expect(result).toMatchObject({ message: expect.stringContaining("No API key found") });
			let drainError: unknown;
			if (succeeds) {
				try {
					await within(drainedPromise, "saved replay stranded after successful startup preflight");
				} catch (error) {
					drainError = error;
				}
			}
			await within(runtime.session.waitForIdle(), "native startup/replay did not become idle");
			const entries = runtime.session.sessionManager.getEntries();
			const delivered = entries.filter((entry) => entry.unsentInputId);
			const expectedIds = succeeds ? saved.ids : [];
			expect(readFileSync(saved.file).subarray(0, saved.prefix.length).equals(saved.prefix)).toBe(true);
			expect(
				entries
					.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE)
					.map((entry) => entry.id),
			).toEqual(saved.ids);
			expect(new Set(saved.ids).size).toBe(35);
			expect(
				snapshots.every(
					({ count, bytes }) => count <= UNSENT_INPUT_REPLAY_MAX_COUNT && bytes <= UNSENT_INPUT_REPLAY_MAX_BYTES,
				),
			).toBe(true);
			expect(
				entries.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						getMessageText(entry.message) === startupText,
				),
			).toHaveLength(outcome === "completed" ? 1 : 0);
			if (drainError) {
				console.error("startup-preflight-causal-state", {
					outcome,
					inputState: context.getInputState(),
					isIdle: runtime.session.isIdle,
					isStreaming: runtime.session.isStreaming,
					providerCalls: faux.state.callCount,
					recovered: runtime.session.recoveredInputCount,
					outboxIds: saved.ids,
					deliveredLinks: delivered.map((entry) => entry.unsentInputId),
					rawPrefixUnchanged: true,
				});
			}
			expect(delivered.map((entry) => entry.unsentInputId)).toEqual(expectedIds);
			expect(new Set(delivered.map((entry) => entry.unsentInputId)).size).toBe(expectedIds.length);
			expect(
				delivered.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						getMessageText(entry.message) === savedText,
				),
			).toHaveLength(expectedIds.length);
			expect(runtime.session.recoveredInputCount).toBe(succeeds ? 0 : 35);
			expect(runtime.session.agent.getQueuedMessages()).toEqual([]);
			expect(context.getInputState()).toEqual({
				inputsFenced: false,
				inputAdmissionCount: 0,
				queued: 0,
				drained: true,
			});
			expect(faux.state.callCount).toBe(succeeds ? (outcome === "handled" ? 6 : 7) : 0);
			if (succeeds) expect(Math.max(...snapshots.map(({ count }) => count))).toBe(UNSENT_INPUT_REPLAY_MAX_COUNT);
		},
		10_000,
	);

	it("persists message_end assistant replacements to the session manager", async () => {
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;

				return {
					message: {
						...event.message,
						usage: {
							...event.message.usage,
							cost: {
								...event.message.usage.cost,
								total: 0.123,
							},
						},
					},
				};
			});
		});

		await runtime.session.prompt("hello");

		const sessionAssistant = runtime.session.messages.find((message) => message.role === "assistant");
		expect(sessionAssistant?.role).toBe("assistant");
		if (sessionAssistant?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(sessionAssistant.usage.cost.total).toBe(0.123);

		const persistedAssistant = runtime.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.find((message) => message.role === "assistant");
		expect(persistedAssistant?.role).toBe("assistant");
		if (persistedAssistant?.role !== "assistant") {
			throw new Error("missing persisted assistant message");
		}
		expect(persistedAssistant.usage.cost.total).toBe(0.123);
	});

	it("settles the active response before session replacement", async () => {
		let toolStarted!: () => void;
		const toolStartedPromise = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.registerTool({
				name: "block",
				label: "Block",
				description: "Blocks until aborted",
				parameters: Type.Object({}),
				execute: (_toolCallId, _params, signal) =>
					new Promise<AgentToolResult<unknown>>((resolve) => {
						toolStarted();
						signal?.addEventListener("abort", () =>
							resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
						);
					}),
			});
		});

		await runtime.session.prompt("hello");
		const firstSessionFile = runtime.session.sessionFile!;
		await runtime.newSession();
		await runtime.session.bindExtensions({});

		faux.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
		const outgoingSession = runtime.session;
		const promptPromise = outgoingSession.prompt("start blocking tool");
		await toolStartedPromise;

		const switchResult = await runtime.switchSession(firstSessionFile);
		await promptPromise;

		expect(switchResult.cancelled).toBe(false);
		expect(runtime.session.sessionFile).toBe(firstSessionFile);
		// The outgoing session settled before replacement: the interrupted tool
		// call has a persisted tool result instead of dangling forever.
		const outgoingEntries = SessionManager.open(outgoingSession.sessionFile!)
			.getEntries()
			.filter((entry) => entry.type === "message");
		expect(outgoingEntries.map((entry) => entry.message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("preserves an existing session when importing a file with the same name", async () => {
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		const sessionDir = runtime.session.sessionManager.getSessionDir();
		const importDir = join(tempDir, "import");
		const filename = "collision.jsonl";
		const storedPath = join(sessionDir, filename);
		const importPath = join(importDir, filename);
		const storedSession = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "stored",
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		})}\n`;
		const importedSession = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "imported",
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		})}\n`;
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(importDir, { recursive: true });
		writeFileSync(storedPath, storedSession);
		writeFileSync(importPath, importedSession);

		await runtime.importFromJsonl(importPath);

		expect(readFileSync(storedPath, "utf8")).toBe(storedSession);
		expect(runtime.session.sessionFile).not.toBe(storedPath);
		expect(readFileSync(runtime.session.sessionFile!, "utf8")).toContain('"id":"imported"');
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		const secondSessionFile = runtime.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation for new and resume", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tmpdir(), `pi-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		const otherSession = SessionManager.create(otherDir);
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionFile = otherSession.getSessionFile();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.prompt("hello");
		const userMessage = runtime.session.getUserMessagesForForking()[0]!;
		const previousSessionFile = runtime.session.sessionFile;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtime.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);
		const sessionFileName = parse(runtime.session.sessionFile!).name;
		expect(sessionFileName.endsWith(`_${runtime.session.sessionId}`)).toBe(true);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtime.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("reports why an unflushed session cannot be forked", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const sessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(false);
		expect(leafId).toBeTruthy();

		await expect(runtime.fork(leafId!, { position: "at" })).rejects.toThrow(
			"This session has not been saved yet. Send a message before cloning or forking it.",
		);
	});

	it("duplicates the current active branch when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const previousSessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).not.toBe(previousSessionFile);
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("duplicates the current active branch in-memory when forking at the current position", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-suite-in-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();
		expect(runtime.session.sessionFile).toBeUndefined();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).toBeUndefined();
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("updates the runtime session cwd on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `pi-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `pi-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		await otherAuthStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: secondDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(secondDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.prompt("other");
		const otherSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(otherSessionFile);

		expect(realpathSync(runtime.session.sessionManager.getCwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
			bootstrapThinkingLevel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		await otherAuthStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: otherDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(otherDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		const targetSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});
});
