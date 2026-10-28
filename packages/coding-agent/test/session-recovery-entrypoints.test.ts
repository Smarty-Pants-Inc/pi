import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices } from "../src/core/agent-session-services.ts";
import type { ExtensionContext, InlineExtension } from "../src/core/extensions/types.ts";
import * as outputGuard from "../src/core/output-guard.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	type AcceptedRecoveryInput,
	type InputOutcomeRequest,
	PI_PROCESS_INCARNATION_ID,
	type RecoveryOccurrence,
	type SessionRecoveryBinding,
	type SessionRecoveryContext,
} from "../src/core/session-recovery-control.ts";
import { UserMessageIngress } from "../src/core/user-message-ingress.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import * as jsonl from "../src/modes/rpc/jsonl.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const sessions: AgentSession[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (sessions.length) sessions.pop()?.dispose();
	while (harnesses.length) await harnesses.pop()?.cleanup();
});

function inputFor(sessionId: string): AcceptedRecoveryInput {
	const text = "native controlled input";
	return {
		sessionId,
		originalInputId: "original",
		admissionId: "admission",
		deliveryId: "fabric-delivery",
		kind: "initial",
		text,
		payloadSha256: createHash("sha256").update(text).digest("hex"),
		deadlineMs: Date.now() + 60_000,
		consumption: { kind: "round" },
	};
}
async function setup(
	overrides: Partial<SessionRecoveryBinding> = {},
	extension?: InlineExtension,
	construction: "sdk" | "services" | "ordinary-services" = "sdk",
	tools?: string[],
) {
	let context: SessionRecoveryContext | undefined;
	const requests: InputOutcomeRequest[] = [];
	const binding: SessionRecoveryBinding = {
		deliver: async (value) => {
			context = value;
		},
		beforeProvider: async () => ({ permitted: true }),
		projectContext: async (messages) => messages,
		commitNativeEntries: async () => {},
		recordInputOutcome: async (request) => {
			requests.push(request);
			return { durable: true, status: "recorded", revision: requests.length };
		},
		getCancelTargets: () => [],
		validateTerminal: async () => ({ complete: true }),
		...overrides,
	};
	const h = await createHarness({
		persistSession: true,
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.registerSessionRecovery(binding);
			},
			...(extension ? [extension] : []),
		],
	});
	harnesses.push(h);
	const options = {
		model: h.getModel(),
		sessionManager: h.sessionManager,
		noTools: "all" as const,
		tools,
		...(construction === "ordinary-services" ? {} : { recovery: { required: true } }),
	};
	const { session } =
		construction === "sdk"
			? await createAgentSession({
					...options,
					cwd: h.tempDir,
					agentDir: h.tempDir,
					modelRuntime: h.modelRuntime,
					settingsManager: h.settingsManager,
					resourceLoader: h.resourceLoader,
				})
			: await createAgentSessionFromServices({
					...options,
					services: {
						cwd: h.tempDir,
						agentDir: h.tempDir,
						modelRuntime: h.modelRuntime,
						settingsManager: h.settingsManager,
						resourceLoader: h.resourceLoader,
						diagnostics: [],
					},
				});
	sessions.push(session);
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});
	return {
		h,
		session,
		binding,
		requests,
		events,
		input: inputFor(session.sessionId),
		context: () => {
			if (!context) throw new Error("context not captured");
			return context;
		},
	};
}

// Smarty-Pants-Inc/smarty-dev#16188: exercise actual SDK, native append, hooks, loop and faux-provider paths.
describe("REQUIRED native SDK entrypoints", () => {
	it.each(["sdk", "services"] as const)(
		"%s closes admission before extension startup and awaits strict startup/ready handlers",
		async (construction) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const readyEntered = Promise.withResolvers<void>();
			const readyRelease = Promise.withResolvers<void>();
			let startupContext: ExtensionContext | undefined;
			const t = await setup(
				{},
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						startupContext = ctx;
						entered.resolve();
						await release.promise;
					});
					pi.on("session_ready", async () => {
						readyEntered.resolve();
						await readyRelease.promise;
					});
				},
				construction,
			);
			const binding = t.session.bindExtensions({});
			await entered.promise;
			expect(t.session.recovery.phase).toBe("HELD");
			expect(startupContext?.sessionRecovery?.processIncarnationId).toBe(PI_PROCESS_INCARNATION_ID);
			await expect(t.session.prompt("uncontrolled")).rejects.toThrow("REQUIRED input");
			await expect(t.session.agent.prompt("raw bypass")).rejects.toThrow("RECOVERY_CONTROLLED_OCCURRENCE_REQUIRED");
			expect(t.h.faux.state.callCount).toBe(0);
			release.resolve();
			await readyEntered.promise;
			expect(t.session.recovery.phase).toBe("HELD");
			await expect(t.session.prompt("during ready")).rejects.toThrow("REQUIRED input");
			expect(t.h.faux.state.callCount).toBe(0);
			readyRelease.resolve();
			await binding;
			expect(t.session.recovery.phase).toBe("READY");
		},
	);
	it.each(["session_start", "session_ready"] as const)(
		"a failed %s never opens REQUIRED while ordinary observers stay best effort",
		async (event) => {
			const t = await setup({}, (pi) => {
				if (event === "session_start")
					pi.on("session_start", async () => {
						throw new Error("startup failed");
					});
				else
					pi.on("session_ready", async () => {
						throw new Error("startup failed");
					});
			});
			await expect(t.session.bindExtensions({})).rejects.toThrow("RECOVERY_STARTUP_HANDLER_FAILED");
			expect(t.session.recovery.phase).toBe("BLOCKED");
			await expect(t.session.prompt("unsafe")).rejects.toThrow();
			await t.h.session.bindExtensions({});
			t.h.setResponses([fauxAssistantMessage("ordinary")]);
			await t.h.session.prompt("ordinary still works");
			expect(t.h.faux.state.callCount).toBe(1);
		},
	);
	it.each(["sdk", "services"] as const)(
		"%s B5 can hold commit after native persistence returned, with zero provider dispatch",
		async (construction) => {
			const captured = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let occurrence: RecoveryOccurrence | undefined;
			let carrierId = "";
			const t = await setup({}, undefined, construction);
			t.binding.deliver = async (ctx) => {
				occurrence = await ctx.deliverAccepted(t.input);
				const carrier = await occurrence.carrier;
				await carrier.persistenceReleased;
				carrierId = carrier.entry.entryId;
				expect(carrier.entry.flushReceipt.kind).toBe("file-fsync");
				// This is outside the enclosing native writer; no owner-terminal append is pending.
				t.session.sessionManager.appendCustomEntry("test-after-release", { carrierId });
				captured.resolve();
				await release.promise;
				await occurrence.permit();
			};
			t.h.setResponses([fauxAssistantMessage("settled")]);
			const startup = t.session.bindExtensions({});
			await captured.promise;
			expect(t.session.recovery.phase).toBe("DELIVERING");
			expect(t.h.faux.state.callCount).toBe(0);
			expect(readFileSync(t.session.sessionFile!, "utf8")).toContain(carrierId);
			await expect(t.session.steer("new round")).rejects.toThrow();
			release.resolve();
			await startup;
			await occurrence!.completion;
			expect(t.h.faux.state.callCount).toBe(1);
			const witness = t.session.sessionManager
				.getEntries()
				.find((entry) => entry.type === "custom" && entry.customType === "pi-recovery-terminal:v1");
			expect(witness).toBeDefined();
			expect(t.requests.at(-1)).toMatchObject({
				kind: "settled",
				terminalEvidence: { inputEntryId: carrierId, decision: "settled" },
			});
			expect(t.session.recovery.phase).toBe("READY");
		},
	);
	it("the real services wrapper without recovery keeps ordinary startup best effort and permits ordinary input", async () => {
		const startup = vi.fn(async () => {
			throw new Error("ordinary observer failed");
		});
		const t = await setup(
			{},
			(pi) => {
				pi.on("session_start", startup);
			},
			"ordinary-services",
		);
		expect(t.session.recovery.required).toBe(false);
		expect(t.session.recovery.phase).toBe("READY");
		await t.session.bindExtensions({});
		expect(startup).toHaveBeenCalledOnce();
		t.h.setResponses([fauxAssistantMessage("ordinary services response")]);
		await t.session.prompt("ordinary services input");
		expect(t.h.faux.state.callCount).toBe(1);
		expect(
			t.session.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
				),
		).toEqual([[{ type: "text", text: "ordinary services input" }]]);
	});
	it.each(["handled", "transform"] as const)(
		"blocks an input hook that claims %s instead of silently changing the occurrence",
		async (action) => {
			const t = await setup({}, (pi) => {
				pi.on("input", async () => (action === "handled" ? { action } : { action, text: "changed" }));
			});
			await t.session.bindExtensions({});
			const occurrence = await t.context().deliverAccepted(t.input);
			await expect(occurrence.carrier).rejects.toThrow("REQUIRED_INPUT_HOOK_PROTOCOL_ERROR");
			await expect(occurrence.completion).rejects.toThrow("REQUIRED_INPUT_HOOK_PROTOCOL_ERROR");
			expect(t.h.faux.state.callCount).toBe(0);
			expect(
				t.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "message" && entry.message.role === "user"),
			).toHaveLength(0);
		},
	);
	it("refuses a retained ordinary open even after late enable and preserves torn bytes on recovery open", async () => {
		const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		h.sessionManager.appendMessage(fauxAssistantMessage("retained"));
		const file = h.sessionManager.getSessionFile()!;
		const valid = readFileSync(file, "utf8");
		writeFileSync(file, `${valid}{"type":"message"`);
		const prepared = SessionManager.openForRecovery(file);
		expect(prepared.getRecoveryPersistenceState()).toMatchObject({
			enabled: true,
			preparedOpen: true,
			needsRecovery: true,
		});
		expect(readFileSync(file, "utf8")).toBe(`${valid}{"type":"message"`);
		const ordinary = SessionManager.open(file);
		ordinary.enableRecoveryPersistence();
		expect(ordinary.getRecoveryPersistenceState().preparedOpen).toBe(false);
		await expect(
			createAgentSession({
				cwd: h.tempDir,
				sessionManager: ordinary,
				model: h.getModel(),
				modelRuntime: h.modelRuntime,
				settingsManager: h.settingsManager,
				resourceLoader: h.resourceLoader,
				recovery: { required: true },
			}),
		).rejects.toThrow("RECOVERY_PREPARED_OPEN_REQUIRED");
	});
	it("does not retrospectively certify a new manager flushed before recovery was enabled", async () => {
		const h = await createHarness({ persistSession: true });
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		h.sessionManager.appendMessage(fauxAssistantMessage("old"));
		h.sessionManager.enableRecoveryPersistence();
		expect(h.sessionManager.getRecoveryPersistenceState().preparedOpen).toBe(false);
	});
	it("rejects a second round and effect-read metadata before allocating a native input", async () => {
		const t = await setup();
		await t.session.bindExtensions({});
		const occurrence = await t.context().deliverAccepted(t.input);
		await occurrence.carrier;
		await expect(t.context().deliverAccepted({ ...t.input, originalInputId: "second" })).rejects.toThrow(
			"RECOVERY_OCCURRENCE_NOT_HELD",
		);
		await t.session.interruptForLifecycle("test-interrupt");
		await occurrence.completion;
		expect(t.requests.some((request) => request.kind === "user-cancel")).toBe(false);
	});
	it("a failed terminal inventory cannot become agent_settled success", async () => {
		const validateTerminal = vi.fn(async () => ({ complete: false }));
		const t = await setup({ validateTerminal });
		await t.session.bindExtensions({});
		t.h.setResponses([fauxAssistantMessage("looks final")]);
		const occurrence = await t.context().deliverAccepted(t.input);
		await occurrence.carrier;
		await occurrence.permit();
		const completionError: unknown = await occurrence.completion.catch((error: unknown) => error);
		const diagnostic = JSON.stringify({
			completionError:
				completionError instanceof Error
					? { stack: completionError.stack, cause: completionError.cause }
					: completionError,
			providerCalls: t.h.faux.state.callCount,
			pendingResponses: t.h.getPendingResponseCount(),
			phase: t.session.recovery.phase,
			messages: t.session.messages,
			events: t.events,
			requests: t.requests,
		});
		expect(() => {
			throw completionError;
		}, diagnostic).toThrow("RECOVERY_TERMINAL_INVENTORY_INCOMPLETE");
		expect(validateTerminal, diagnostic).toHaveBeenCalledOnce();
		expect(t.h.faux.state.callCount, diagnostic).toBe(1);
		expect(t.session.messages.at(-1), diagnostic).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(t.requests.filter((request) => request.kind === "settled")).toHaveLength(0);
		expect(t.events.filter((event) => event.type === "agent_settled")).toHaveLength(0);
		expect(t.session.recovery.phase).toBe("BLOCKED");
	});
	// Smarty-Pants-Inc/smarty-dev#16188: an earlier failure is not an inventory failure or success.
	it.each(["provider", "post-run"] as const)(
		"preserves the first %s failure and does not invoke terminal inventory",
		async (stage) => {
			const validateTerminal = vi.fn(async () => ({ complete: true }));
			const t = await setup({ validateTerminal });
			await t.session.bindExtensions({});
			const cause = new Error("original computation failure");
			t.h.setResponses([
				stage === "provider"
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: cause.message })
					: fauxAssistantMessage("final before post-run failure"),
			]);
			if (stage === "post-run")
				vi.spyOn(
					t.session as unknown as { _handlePostAgentRun(): Promise<boolean> },
					"_handlePostAgentRun",
				).mockRejectedValue(cause);
			const occurrence = await t.context().deliverAccepted(t.input);
			await occurrence.carrier;
			await occurrence.permit();
			const error: unknown = await occurrence.completion.catch((failure: unknown) => failure);
			expect(error).toMatchObject({ message: "RECOVERY_COMPUTATION_NOT_SETTLED" });
			if (stage === "post-run") expect(error).toHaveProperty("cause", cause);
			else
				expect(error).toMatchObject({
					cause: { role: "assistant", stopReason: "error", errorMessage: cause.message },
				});
			expect(t.h.faux.state.callCount).toBe(1);
			expect(validateTerminal).not.toHaveBeenCalled();
			expect(t.requests.filter((request) => request.kind === "settled")).toHaveLength(0);
			expect(t.events.filter((event) => event.type === "agent_settled")).toHaveLength(0);
			expect(
				t.session.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === "pi-recovery-terminal:v1"),
			).toBe(false);
			expect(t.session.recovery.phase).toBe("BLOCKED");
		},
	);
	// Smarty-Pants-Inc/smarty-dev#16188: REQUIRED raw abort cannot recurse into user cancellation.
	it.each(["abort", "lifecycle"] as const)("%s stops the real Agent only after its durable outcome", async (mode) => {
		const entered = Promise.withResolvers<void>();
		const releaseProvider = Promise.withResolvers<void>();
		const outcomeEntered = Promise.withResolvers<void>();
		const outcomeRelease = Promise.withResolvers<void>();
		const outcomes: InputOutcomeRequest[] = [];
		const t = await setup({
			recordInputOutcome: async (request) => {
				outcomes.push(request);
				outcomeEntered.resolve();
				await outcomeRelease.promise;
				return { durable: true, status: "recorded", revision: outcomes.length };
			},
		});
		await t.session.bindExtensions({});
		t.h.setResponses([
			async (_context, options) => {
				entered.resolve();
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					void releaseProvider.promise.then(resolve);
				});
				return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
			},
		]);
		const occurrence = await t.context().deliverAccepted(t.input);
		await occurrence.permit();
		try {
			await entered.promise;
			const signal = t.session.agent.signal;
			const stopping = mode === "abort" ? t.session.agent.abort() : t.session.interruptForLifecycle("fixture-stop");
			await outcomeEntered.promise;
			expect(signal?.aborted).toBe(false);
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0].kind).toBe(mode === "abort" ? "user-cancel" : "lifecycle-interrupt");
			outcomeRelease.resolve();
			await stopping;
			await occurrence.completion;
			expect(signal?.aborted).toBe(true);
			expect(t.session.agent.signal).toBeUndefined();
			expect(outcomes).toHaveLength(1);
			expect(t.events.some((event) => event.type === "agent_settled" && event.outcome === "completed")).toBe(false);
		} finally {
			outcomeRelease.resolve();
			releaseProvider.resolve();
			await occurrence.completion;
		}
	});
	it("awaits the durable user-cancel port before destructive clear", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const t = await setup({
			recordInputOutcome: async () => {
				entered.resolve();
				await release.promise;
				return { durable: true, status: "recorded", revision: 1 };
			},
		});
		await t.session.bindExtensions({});
		const occurrence = await t.context().deliverAccepted(t.input);
		await occurrence.carrier;
		const clear = vi.spyOn(t.session, "clearQueue");
		const cancel = t.session.cancelAndClearQueue();
		await entered.promise;
		expect(clear).not.toHaveBeenCalled();
		expect(t.session.recovery.phase).toBe("CANCELLING");
		release.resolve();
		await cancel;
		await occurrence.completion;
		expect(clear).toHaveBeenCalledOnce();
		expect(t.h.faux.state.callCount).toBe(0);
	});
	it("never clears the queue or returns a success result when cancellation is unknown", async () => {
		const t = await setup({ recordInputOutcome: async () => ({ durable: false, reason: "store-unavailable" }) });
		await t.session.bindExtensions({});
		const occurrence = await t.context().deliverAccepted(t.input);
		await occurrence.carrier;
		const clear = vi.spyOn(t.session, "clearQueue");
		await expect(t.session.cancelAndClearQueue()).rejects.toThrow("RECOVERY_CANCEL_NOT_DURABLE");
		await occurrence.completion;
		expect(clear).not.toHaveBeenCalled();
		expect(t.h.faux.state.callCount).toBe(0);
	});
	it("a lost settlement ACK is recovered only from the exact durable native witness", async () => {
		let failSettlement = true;
		const t = await setup({
			recordInputOutcome: async (request) =>
				request.kind === "settled" && failSettlement
					? { durable: false, reason: "store-unavailable" }
					: { durable: true, status: "recorded", revision: 1 },
		});
		await t.session.bindExtensions({});
		t.h.setResponses([fauxAssistantMessage("final")]);
		const occurrence = await t.context().deliverAccepted(t.input);
		const carrier = await occurrence.carrier;
		await occurrence.permit();
		await expect(occurrence.completion).rejects.toThrow("RECOVERY_SETTLEMENT_NOT_DURABLE");
		const witness = t.session.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "pi-recovery-terminal:v1");
		expect(witness).toBeDefined();
		await t.session.interruptForLifecycle("fixture-restart");
		t.session.dispose();
		failSettlement = false;
		const manager = await SessionManager.openForRecoveryAfterExclusion(t.session.sessionFile!, {
			excludeWriter: async () => ({ assertCurrent() {} }),
		});
		const { session } = await createAgentSession({
			cwd: t.h.tempDir,
			agentDir: t.h.tempDir,
			sessionManager: manager,
			model: t.h.getModel(),
			modelRuntime: t.h.modelRuntime,
			settingsManager: t.h.settingsManager,
			resourceLoader: t.h.resourceLoader,
			noTools: "all",
			recovery: { required: true },
		});
		sessions.push(session);
		await session.bindExtensions({});
		await t.context().settleFromWitness(t.input, witness!.id);
		expect(session.recovery.phase).toBe("READY");
		expect(t.h.faux.state.callCount).toBe(1);
		expect(manager.getEntries().filter((entry) => entry.id === carrier.entry.entryId)).toHaveLength(1);
	});
	it("a stopped durable final boundary uses finalizeAccepted without another provider call", async () => {
		let complete = false;
		const t = await setup({ validateTerminal: async () => ({ complete }) });
		await t.session.bindExtensions({});
		t.h.setResponses([fauxAssistantMessage("native final before crash")]);
		const occurrence = await t.context().deliverAccepted(t.input);
		const carrier = await occurrence.carrier;
		await occurrence.permit();
		await expect(occurrence.completion).rejects.toThrow("RECOVERY_TERMINAL_INVENTORY_INCOMPLETE");
		expect(
			t.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "pi-recovery-terminal:v1"),
		).toBe(false);
		await t.session.interruptForLifecycle("fixture-finalizer-restart");
		t.session.dispose();
		complete = true;
		const manager = await SessionManager.openForRecoveryAfterExclusion(t.session.sessionFile!, {
			excludeWriter: async () => ({ assertCurrent() {} }),
		});
		const { session } = await createAgentSession({
			cwd: t.h.tempDir,
			agentDir: t.h.tempDir,
			sessionManager: manager,
			model: t.h.getModel(),
			modelRuntime: t.h.modelRuntime,
			settingsManager: t.h.settingsManager,
			resourceLoader: t.h.resourceLoader,
			noTools: "all",
			recovery: { required: true },
		});
		sessions.push(session);
		await session.bindExtensions({});
		await t.context().finalizeAccepted(t.input, carrier.entry.entryId);
		expect(session.recovery.phase).toBe("READY");
		expect(t.h.faux.state.callCount).toBe(1);
		expect(
			manager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "pi-recovery-terminal:v1"),
		).toHaveLength(1);
	});
	it("a joined REQUIRED fork uses the existing branch writer without reopening or changing its source", async () => {
		const t = await setup();
		await t.session.bindExtensions({});
		t.h.setResponses([fauxAssistantMessage("before fork")]);
		const occurrence = await t.context().deliverAccepted(t.input);
		await occurrence.permit();
		await occurrence.completion;
		await t.session.interruptForLifecycle("fixture-fork");
		const source = t.session.sessionManager;
		const before = readFileSync(source.getSessionFile()!);
		const child = source.forkForRecovery(source.getLeafId()!);
		expect(child.getHeader()?.parentSession).toBe(source.getSessionFile());
		expect(child.getRecoveryPersistenceState().preparedOpen).toBe(true);
		expect(() => child.assertRecoveryExclusion()).not.toThrow();
		expect(readFileSync(source.getSessionFile()!)).toEqual(before);
		expect(
			child
				.getBranch()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.id),
		).toEqual(
			source
				.getBranch()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.id),
		);
	});
	it("public REQUIRED rejection does not reserve or poison its keyed ingress", async () => {
		const t = await setup();
		const request = {
			registrationEpoch: "extension",
			requestId: "key",
			sessionGeneration: t.session.userMessageSessionGeneration,
			text: "first",
			deliverAs: "followUp" as const,
			expandPromptTemplates: false as const,
		};
		expect(await t.session.submitUserMessage(request)).toMatchObject({
			status: "rejected",
			reason: "admission_refused",
		});
		const second = await t.session.submitUserMessage({ ...request, text: "corrected" });
		expect(second).toMatchObject({ status: "rejected", reason: "admission_refused" });
		expect(second.duplicate).toBeUndefined();
		let held = true;
		const ingress = new UserMessageIngress(new AbortController().signal, undefined, () =>
			held ? "admission_refused" : undefined,
		);
		const keyed = { ...request, sessionGeneration: ingress.generation };
		const run = vi.fn(async (_request, admission) => {
			admission.accept("accepted");
		});
		await ingress.submit(keyed, run);
		held = false;
		expect(await ingress.submit({ ...keyed, text: "corrected" }, run)).toMatchObject({ status: "accepted" });
		expect(run).toHaveBeenCalledOnce();
	});
	it("reads the current retained history only after the pre-open exclusion port returns", async () => {
		const h = await createHarness({ persistSession: true });
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		h.sessionManager.appendMessage(fauxAssistantMessage("old"));
		const file = h.sessionManager.getSessionFile()!;
		const cachedBeforeExclusion = SessionManager.openForRecovery(file);
		expect(() => cachedBeforeExclusion.assertRecoveryExclusion()).toThrow("RECOVERY_PREOPEN_EXCLUSION_REQUIRED");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let excluded = false;
		const opening = SessionManager.openForRecoveryAfterExclusion(file, {
			excludeWriter: async () => {
				entered.resolve();
				await release.promise;
				excluded = true;
				return {
					assertCurrent() {
						if (!excluded) throw new Error("exclusion revoked");
					},
				};
			},
		});
		await entered.promise;
		const lateId = h.sessionManager.appendCustomEntry("last-old-writer-entry", { value: 1 });
		release.resolve();
		const current = await opening;
		expect(current.getEntry(lateId)?.type).toBe("custom");
		expect(current.getRecoveryPersistenceState().exclusionValidated).toBe(true);
		excluded = false;
		expect(() => current.assertRecoveryExclusion()).toThrow("exclusion revoked");
	});
	it("reload is strict, memoized per epoch, and old startup contexts cannot wake a new epoch", async () => {
		let starts = 0;
		let ready = 0;
		let failReload = false;
		const t = await setup({}, (pi) => {
			pi.on("session_start", async (event) => {
				starts++;
				if (event.reason === "reload" && failReload) throw new Error("reload refused");
			});
			pi.on("session_ready", async () => {
				ready++;
			});
		});
		await t.session.bindExtensions({});
		const old = t.context();
		await Promise.all([t.session.completeRecoveryStartup(), t.session.completeRecoveryStartup()]);
		expect(ready).toBe(1);
		await t.session.reload();
		expect(starts).toBe(2);
		expect(ready).toBe(2);
		expect(t.context().epoch).toBe(old.epoch + 1);
		await expect(old.deliverAccepted(t.input)).rejects.toThrow("RECOVERY_EPOCH_REVOKED");
		expect(t.session.recovery.phase).toBe("READY");
		failReload = true;
		await expect(t.session.reload()).rejects.toThrow("RECOVERY_STARTUP_HANDLER_FAILED");
		expect(t.session.recovery.phase).toBe("BLOCKED");
		await expect(t.session.prompt("after failed reload")).rejects.toThrow();
	});
	it.each([false, true])("replacement keeps the recovery hold through strict rebind; failure=%s", async (fail) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const t = await setup({}, (pi) => {
			pi.on("session_ready", async (event) => {
				if (event.reason === "new") {
					entered.resolve();
					await release.promise;
					if (fail) throw new Error("replacement refused");
				}
			});
		});
		await t.session.bindExtensions({});
		const services = {
			cwd: t.h.tempDir,
			agentDir: t.h.tempDir,
			modelRuntime: t.h.modelRuntime,
			settingsManager: t.h.settingsManager,
			resourceLoader: t.h.resourceLoader,
			diagnostics: [],
		};
		const factory: CreateAgentSessionRuntimeFactory = async (options) => {
			const created = await createAgentSession({
				...options,
				model: t.h.getModel(),
				modelRuntime: t.h.modelRuntime,
				settingsManager: t.h.settingsManager,
				resourceLoader: t.h.resourceLoader,
				noTools: "all",
			});
			sessions.push(created.session);
			return { ...created, services, diagnostics: [] };
		};
		const runtime = new AgentSessionRuntime(t.session, services, factory);
		runtime.setRebindSession(async (session) => {
			await session.bindExtensions({});
		});
		const replacing = runtime.newSession();
		const observed = replacing.then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		);
		await entered.promise;
		expect(runtime.session.recovery.phase).toBe("HELD");
		expect(runtime.inputsFenced).toBe(true);
		expect(t.h.faux.state.callCount).toBe(0);
		release.resolve();
		const outcome = await observed;
		if (fail) {
			expect("error" in outcome).toBe(true);
			expect(runtime.session.recovery.phase).toBe("BLOCKED");
		} else {
			expect("result" in outcome).toBe(true);
			expect(runtime.session.recovery.phase).toBe("READY");
		}
		expect(t.requests.some((request) => request.kind === "user-cancel")).toBe(false);
	});
	it.each(["abort", "clear_queue"] as const)(
		"the real RPC %s receiver awaits durable cancel and reports unknown instead of success",
		async (command) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const t = await setup({
				recordInputOutcome: async (request) => {
					if (request.kind === "user-cancel") {
						entered.resolve();
						await release.promise;
						return { durable: false, reason: "store-unavailable" };
					}
					return { durable: true, status: "recorded", revision: 1 };
				},
			});
			t.binding.getCancelTargets = () => [t.input];
			const lines: string[] = [];
			let receive: ((line: string) => void) | undefined;
			const spies = [
				vi.spyOn(outputGuard, "takeOverStdout").mockImplementation(() => {}),
				vi.spyOn(outputGuard, "flushRawStdout").mockResolvedValue(),
				vi.spyOn(outputGuard, "waitForRawStdoutBackpressure").mockResolvedValue(),
				vi.spyOn(outputGuard, "writeRawStdout").mockImplementation((line) => {
					lines.push(line);
				}),
				vi.spyOn(jsonl, "attachJsonlLineReader").mockImplementation((_stream, handler) => {
					receive = (line) => handler(line, Buffer.byteLength(line) + 1);
					return () => {
						receive = undefined;
					};
				}),
			];
			const signals = ["SIGTERM", "SIGHUP"] as const;
			const originalSignals = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
			const originalEnd = process.stdin.listeners("end");
			let startupFailure: unknown;
			try {
				const runtime = {
					session: t.session,
					setRebindSession: vi.fn(),
					setLifecycleCompleteHandler: vi.fn(),
					dispose: vi.fn(async () => {}),
				} as unknown as AgentSessionRuntime;
				void runRpcMode(runtime).catch((error: unknown) => {
					startupFailure = error;
				});
				await vi.waitFor(() => {
					expect(receive).toBeDefined();
					expect(t.session.recovery.phase).toBe("READY");
				});
				receive!(JSON.stringify({ type: command, id: "cancel" }));
				await entered.promise;
				expect(lines.some((line) => line.includes('"id":"cancel"'))).toBe(false);
				release.resolve();
				await vi.waitFor(() => expect(lines.some((line) => line.includes('"id":"cancel"'))).toBe(true));
				const response = lines
					.map((line) => JSON.parse(line) as RpcResponse)
					.find((value) => value.id === "cancel");
				expect(response).toMatchObject({ success: false });
				expect(JSON.stringify(response)).toContain("cancellation NOT confirmed durable");
				expect(startupFailure).toBeUndefined();
			} finally {
				release.resolve();
				for (const listener of process.stdin.listeners("end") as Parameters<typeof process.on>[1][])
					if (!originalEnd.includes(listener)) process.stdin.off("end", listener);
				for (const signal of signals)
					for (const listener of process.listeners(signal))
						if (!originalSignals.get(signal)!.includes(listener)) process.off(signal, listener);
				for (const spy of spies) spy.mockRestore();
			}
		},
	);
	it("the real TUI restore receiver keeps local queues and newly typed draft until cancel succeeds", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let fail = true;
		const t = await setup({
			recordInputOutcome: async (request) => {
				if (request.kind === "user-cancel" && fail) {
					entered.resolve();
					await release.promise;
					return { durable: false, reason: "store-unavailable" };
				}
				return { durable: true, status: "recorded", revision: 1 };
			},
		});
		t.binding.getCancelTargets = () => [t.input];
		await t.session.bindExtensions({});
		let draft = "original draft";
		const editor = {
			getText: () => draft,
			setText: vi.fn((text: string) => {
				draft = text;
			}),
		};
		const receiver = Object.create(InteractiveMode.prototype) as {
			runtimeHost: { session: AgentSession };
			compactionQueuedMessages: { input: { text: string }; mode: string }[];
			editor: typeof editor;
			recoveryText: () => string;
			updatePendingMessagesDisplay: () => void;
			ui: { requestRender: () => void };
			showError: ReturnType<typeof vi.fn>;
			restoreQueuedMessagesToEditor: (options: { abort: boolean }) => number;
			requiredQueueRestore?: Promise<void>;
		};
		receiver.runtimeHost = { session: t.session };
		receiver.compactionQueuedMessages = [{ input: { text: "queued before cancel" }, mode: "followUp" }];
		receiver.editor = editor;
		receiver.recoveryText = () => "";
		receiver.updatePendingMessagesDisplay = vi.fn();
		receiver.ui = { requestRender: vi.fn() };
		receiver.showError = vi.fn();
		receiver.restoreQueuedMessagesToEditor({ abort: true });
		await entered.promise;
		draft = "typed during durability wait";
		expect(editor.setText).not.toHaveBeenCalled();
		expect(receiver.compactionQueuedMessages).toHaveLength(1);
		release.resolve();
		await receiver.requiredQueueRestore;
		expect(receiver.showError).toHaveBeenCalledWith(expect.stringContaining("cancellation NOT confirmed durable"));
		expect(receiver.compactionQueuedMessages).toHaveLength(1);
		expect(draft).toBe("typed during durability wait");
		fail = false;
		receiver.restoreQueuedMessagesToEditor({ abort: true });
		await receiver.requiredQueueRestore;
		expect(receiver.compactionQueuedMessages).toHaveLength(0);
		expect(draft).toBe("queued before cancel\n\ntyped during durability wait");
	});
	it.each([false, true])(
		"real Tool.execute awaits assistant native persistence release AND B6 permission; cancel=%s",
		async (cancel) => {
			const nativeEntered = Promise.withResolvers<void>();
			const nativeRelease = Promise.withResolvers<void>();
			const b6Entered = Promise.withResolvers<void>();
			const b6Release = Promise.withResolvers<void>();
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "effect" }], details: {} }));
			const t = await setup(
				{},
				(pi) => {
					pi.registerTool({
						name: "count",
						label: "Count",
						description: "fixture effect",
						parameters: Type.Object({}),
						execute,
					});
					pi.on("message_end", async (event) => {
						if (event.message.role === "assistant" && event.message.stopReason === "toolUse") {
							nativeEntered.resolve();
							await nativeRelease.promise;
						}
					});
				},
				"sdk",
				["count"],
			);
			t.binding.commitNativeEntries = async (entries) => {
				if (
					entries.some((descriptor) => {
						const entry = t.session.sessionManager.getEntry(descriptor.entryId);
						return (
							entry?.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.content.some((part) => part.type === "toolCall")
						);
					})
				) {
					b6Entered.resolve();
					await b6Release.promise;
				}
			};
			await t.session.bindExtensions({});
			expect(t.session.agent.state.tools.map((tool) => tool.name)).toContain("count");
			t.h.setResponses([
				fauxAssistantMessage([{ type: "toolCall", id: "effect-call", name: "count", arguments: {} }], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const occurrence = await t.context().deliverAccepted(t.input);
			await occurrence.permit();
			const completion = occurrence.completion.then(
				() => undefined,
				(error: unknown) => error,
			);
			await nativeEntered.promise;
			expect(execute).not.toHaveBeenCalled();
			expect(
				t.session.sessionManager
					.getEntries()
					.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.stopReason === "toolUse",
					),
			).toBe(false);
			nativeRelease.resolve();
			await b6Entered.promise;
			expect(execute).not.toHaveBeenCalled();
			expect(
				t.session.sessionManager
					.getEntries()
					.some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
			).toBe(false);
			const cancellation = cancel ? t.session.abort() : Promise.resolve();
			b6Release.resolve();
			await cancellation;
			const completionError = await completion;
			const toolResults = t.events.filter(
				(event) => event.type === "message_end" && event.message.role === "toolResult",
			);
			expect(
				execute,
				JSON.stringify({
					completionError: completionError instanceof Error ? completionError.message : completionError,
					toolResults,
				}),
			).toHaveBeenCalledTimes(cancel ? 0 : 1);
			if (cancel) expect(t.requests.some((request) => request.kind === "user-cancel")).toBe(true);
			else expect(completionError).toBeUndefined();
		},
	);
	it("the adapter-original fallback uses strict live tool_result hooks and refuses an absent seam", async () => {
		const t = await setup({}, (pi) => {
			pi.on("tool_result", async () => {
				throw new Error("hook unavailable");
			});
		});
		await t.session.bindExtensions({});
		t.session.agent.state.messages = [
			...t.session.agent.state.messages,
			fauxAssistantMessage([{ type: "toolCall", id: "call", name: "read", arguments: {} }], {
				stopReason: "toolUse",
			}),
		];
		await expect(
			t.session.transformRecoveryToolResult(
				{
					role: "toolResult",
					toolCallId: "call",
					toolName: "read",
					content: [{ type: "text", text: "original" }],
					isError: false,
					timestamp: 1,
				},
				{},
			),
		).rejects.toThrow("RECOVERY_TOOL_RESULT_HANDLER_FAILED");
		const missing = await setup();
		await missing.session.bindExtensions({});
		await expect(
			missing.session.transformRecoveryToolResult(
				{ role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 1 },
				{},
			),
		).rejects.toThrow("RECOVERY_STRICT_TOOL_RESULT_UNAVAILABLE");
	});
});
