import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ExtensionInputFence,
	ExtensionInputState,
	SessionReadyEvent,
	SubmitUserMessageOptions,
} from "../../src/core/extensions/index.ts";
import { HOST_CAPABILITIES } from "../../src/core/host-capabilities.ts";
import { InputAdmissionError } from "../../src/core/input-admission.ts";
import { HOST_CAPABILITIES as PUBLIC_HOST_CAPABILITIES } from "../../src/index.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { createHarness, getMessageText, getUserTexts, type Harness, type HarnessOptions } from "./harness.ts";

type ProbeAction = (ctx: ExtensionCommandContext, pi: ExtensionAPI) => Promise<void>;
type ExtensionName = "a" | "b";
type LifecycleFenceSnapshot = {
	fence: object | undefined;
	generation: string;
	queuedBytes: string;
	state: ExtensionInputState;
};

// smarty-dev#15310: data-safety and extension-identity regressions use real loader-bound callbacks,
// native AgentSession admission, and faux model turns. Calling commands directly avoids creating
// a prompt admission owned by the command that would itself make a drained fence impossible.
describe("extension input fence (#15310)", () => {
	const harnesses: Harness[] = [];
	const releases: Array<() => void> = [];
	const actions = new Map<ExtensionName, ProbeAction>();

	function gate() {
		let release!: () => void;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		releases.push(release);
		return { promise, release };
	}

	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		actions.clear();
		for (const harness of harnesses.splice(0).reverse()) await harness.cleanup();
		vi.restoreAllMocks();
	});

	async function setup(
		extensionFactories: ExtensionFactory[] = [],
		options: Pick<HarnessOptions, "cwd" | "sessionManager" | "sessionStartEvent"> = {},
	) {
		const probes: ExtensionFactory[] = (["a", "b"] as const).map((name) => (pi) => {
			pi.registerCommand(`fence-probe-${name}`, {
				handler: async (_args, ctx) => {
					const action = actions.get(name);
					if (!action) throw new Error(`No action for extension ${name}`);
					await action(ctx, pi);
				},
			});
		});
		const factories = [...probes, ...extensionFactories];
		const h = await createHarness({
			...options,
			extensionFactories: factories,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(h);
		// Reload must discover a fresh runtime/API, rather than reuse invalidated loader objects.
		let extensions = h.resourceLoader.getExtensions();
		h.resourceLoader.getExtensions = () => extensions;
		h.resourceLoader.reload = async () => {
			extensions = await createTestExtensionsResult(factories, h.tempDir);
		};
		return h;
	}

	async function inExtension<T>(
		h: Harness,
		name: ExtensionName,
		action: (ctx: ExtensionCommandContext, pi: ExtensionAPI) => T | Promise<T>,
	): Promise<T> {
		let value!: T;
		actions.set(name, async (ctx, pi) => {
			value = await action(ctx, pi);
		});
		try {
			const command = h.session.extensionRunner.getCommand(`fence-probe-${name}`);
			if (!command) throw new Error(`Missing extension command ${name}`);
			await command.handler("", h.session.extensionRunner.createCommandContext());
			return value;
		} finally {
			actions.delete(name);
		}
	}

	function runtimeFor(h: Harness) {
		return new AgentSessionRuntime(
			h.session,
			{
				cwd: h.tempDir,
				agentDir: h.tempDir,
				modelRuntime: h.modelRuntime,
				settingsManager: h.settingsManager,
				resourceLoader: h.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("Shutdown must not allocate a replacement session");
			},
		);
	}

	it("exports capability version 1 through the package and the loader-created extension API (spec 1)", async () => {
		const h = await setup();
		expect(PUBLIC_HOST_CAPABILITIES).toBe(HOST_CAPABILITIES);
		expect(HOST_CAPABILITIES.extensionInputFence).toBe(1);
		expect(h.session.capabilities.extensionInputFence).toBe(1);
		await inExtension(h, "a", (_ctx, pi) => {
			expect(pi.hostCapabilities.extensionInputFence).toBe(1);
		});
	});

	it("fences idle input, reports live snapshots, and reopens native admission on release (spec 2)", async () => {
		const h = await setup();
		const errors: Array<{ event: string; error: string }> = [];
		h.session.extensionRunner.onError((error) => errors.push(error));
		let ctx!: ExtensionContext;
		const handle = await inExtension(h, "a", async (context, pi) => {
			ctx = context;
			const fence = await context.fenceInputs();
			expect(context.getInputState()).toEqual({
				inputsFenced: true,
				inputAdmissionCount: 0,
				queued: 0,
				drained: true,
			});
			// Fire-and-forget APIs return void; native rejection is published through runner errors.
			expect(pi.sendUserMessage("refused extension user")).toBeUndefined();
			expect(
				pi.sendMessage(
					{ customType: "fence-test", content: "refused extension custom", display: false },
					{ triggerTurn: true },
				),
			).toBeUndefined();
			await expect(pi.sendUserMessage("refused metadata user", { metadata: {} })).rejects.toMatchObject({
				code: "INPUT_ADMISSION_FENCED",
			});
			return fence;
		});
		for (const entry of ["prompt", "steer", "followUp", "sendUserMessage"] as const) {
			await expect(h.session[entry]("refused native input")).rejects.toMatchObject({
				code: "INPUT_ADMISSION_FENCED",
			});
		}
		expect(errors).toEqual([
			expect.objectContaining({
				event: "send_user_message",
				error: expect.stringContaining("INPUT_ADMISSION_FENCED"),
			}),
			expect.objectContaining({ event: "send_message", error: expect.stringContaining("INPUT_ADMISSION_FENCED") }),
			expect.objectContaining({
				event: "send_user_message",
				error: expect.stringContaining("INPUT_ADMISSION_FENCED"),
			}),
		]);
		expect(h.session.agent.getQueuedMessages()).toEqual([]);
		expect(getUserTexts(h)).toEqual([]);
		const heldSnapshot = ctx.getInputState();
		handle.release();
		expect(heldSnapshot.inputsFenced).toBe(true);
		expect(ctx.getInputState()).toEqual({
			inputsFenced: false,
			inputAdmissionCount: 0,
			queued: 0,
			drained: true,
		});
		h.setResponses([fauxAssistantMessage("admitted after release")]);
		await h.session.prompt("after release");
		expect(getUserTexts(h)).toEqual(["after release"]);
	});

	it.each(["steer", "followUp"] as const)(
		"refuses queued %s without changing any bytes, then delivers every occurrence (spec 3/4/9)",
		async (entry) => {
			const h = await setup();
			const released = await inExtension(h, "a", (ctx) => ctx.fenceInputs());
			released.release();
			const texts = ["first\n\u0000☃", "second exact message", "second exact message"];
			for (const text of texts) await h.session[entry](text);
			const before = JSON.stringify(h.session.agent.getQueuedMessages());
			const rejectQueuedInput = vi.fn();
			await inExtension(h, "a", async (ctx) => {
				expect(ctx.getInputState()).toEqual({
					inputsFenced: false,
					inputAdmissionCount: 0,
					queued: texts.length,
					drained: false,
				});
				await expect(ctx.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
				const withExtraArgument = ctx.fenceInputs as (extra: unknown) => Promise<ExtensionInputFence>;
				await expect(withExtraArgument({ rejectQueuedInput })).rejects.toMatchObject({
					code: "INPUT_ADMISSION_BUSY",
				});
				expect(ctx.getInputState().inputsFenced).toBe(false);
			});
			expect(rejectQueuedInput).not.toHaveBeenCalled();
			expect(JSON.stringify(h.session.agent.getQueuedMessages())).toBe(before);
			released.release();
			expect(JSON.stringify(h.session.agent.getQueuedMessages())).toBe(before);
			h.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("delivered")));
			await h.session.prompt("drain now");
			expect(getUserTexts(h)).toEqual(["drain now", ...texts]);
			expect(h.session.agent.getQueuedMessages()).toEqual([]);
			const next = await inExtension(h, "a", (ctx) => ctx.fenceInputs());
			next.release();
		},
	);

	it("counts a real pending input handler and leaves its admission intact on BUSY (spec 3)", async () => {
		const entered = gate();
		const held = gate();
		const h = await setup([
			(pi) => {
				pi.on("input", async () => {
					entered.release();
					await held.promise;
				});
			},
		]);
		const input = h.session.followUp("held ordinary input");
		await entered.promise;
		await inExtension(h, "a", async (ctx) => {
			expect(ctx.getInputState()).toEqual({
				inputsFenced: false,
				inputAdmissionCount: 1,
				queued: 0,
				drained: false,
			});
			expect(ctx.isPromptPending()).toBe(true);
			await expect(ctx.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
			expect(ctx.getInputState().inputAdmissionCount).toBe(1);
			expect(ctx.getInputState().inputsFenced).toBe(false);
		});
		held.release();
		await input;
		expect(h.session.getFollowUpMessages()).toEqual(["held ordinary input"]);
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("follow-up delivered")]);
		await h.session.prompt("drain held admission");
		expect(getUserTexts(h)).toEqual(["drain held admission", "held ordinary input"]);
	});

	// #309 keep reason: data safety. Successful native acquisition must still rotate ingress;
	// BUSY preservation below must not disable invalidation for a genuinely acquired fence.
	// https://github.com/Smarty-Pants-Inc/pi/pull/309#issuecomment-6401455682
	it("deduplicates acquisition, rotates generation only for a fresh fence, and never reuses a released handle (spec 5)", async () => {
		const h = await setup();
		const nativeAcquire = vi.spyOn(h.session, "fenceInputs");
		const initialGeneration = h.session.userMessageSessionGeneration;
		const first = await inExtension(h, "a", async (ctx) => {
			const [one, two] = await Promise.all([ctx.fenceInputs(), ctx.fenceInputs()]);
			expect(two).toBe(one);
			return one;
		});
		let second: ExtensionInputFence | undefined;
		try {
			const firstGeneration = h.session.userMessageSessionGeneration;
			expect(firstGeneration).not.toBe(initialGeneration);
			expect(await inExtension(h, "a", (ctx) => ctx.fenceInputs())).toBe(first);
			expect(h.session.userMessageSessionGeneration).toBe(firstGeneration);
			expect(nativeAcquire).toHaveBeenCalledTimes(1);
			expect(nativeAcquire).toHaveBeenLastCalledWith();
			first.release();
			first.release();
			expect(h.session.inputsFenced).toBe(false);
			expect(h.session.userMessageSessionGeneration).toBe(firstGeneration);
			second = await inExtension(h, "a", (ctx) => ctx.fenceInputs());
			expect(second).not.toBe(first);
			expect(h.session.userMessageSessionGeneration).not.toBe(firstGeneration);
			first.release();
			expect(h.session.inputsFenced).toBe(true);
			second.release();
			expect(h.session.inputsFenced).toBe(false);
		} finally {
			first.release();
			second?.release();
		}
	});

	it("does not hand another extension the owner handle or let its old release clear a new owner (spec 5/6)", async () => {
		const h = await setup();
		const oldB = await inExtension(h, "b", (ctx) => ctx.fenceInputs());
		oldB.release();
		let aCtx!: ExtensionContext;
		const a = await inExtension(h, "a", (ctx) => {
			aCtx = ctx;
			return ctx.fenceInputs();
		});
		await inExtension(h, "b", async (ctx) => {
			await expect(ctx.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_FENCED" });
			// Borrowing A's context must not select A's cached handle for B's execution.
			await expect(aCtx.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_FENCED" });
			oldB.release();
			expect(ctx.getInputState().inputsFenced).toBe(true);
		});
		expect(await inExtension(h, "a", (ctx) => ctx.fenceInputs())).toBe(a);
		a.release();
		const b = await inExtension(h, "b", (ctx) => ctx.fenceInputs());
		expect(b).not.toBe(a);
		a.release();
		expect(h.session.inputsFenced).toBe(true);
		await inExtension(h, "a", async (ctx) => {
			await expect(ctx.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_FENCED" });
		});
		b.release();
	});

	it("refuses an internal native holder without releasing it and allows a later retry (spec 6)", async () => {
		const h = await setup();
		const release = await h.session.fenceInputs();
		await inExtension(h, "a", async (ctx) => {
			await expect(ctx.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_FENCED" });
		});
		expect(h.session.inputsFenced).toBe(true);
		release();
		const handle = await inExtension(h, "a", (ctx) => ctx.fenceInputs());
		handle.release();
	});

	it("never reads hostile extra options or forwards any arguments to native acquisition (spec 9)", async () => {
		const h = await setup();
		const nativeAcquire = vi.spyOn(h.session, "fenceInputs");
		const readOptions = vi.fn(() => {
			throw new Error("Extension options must never be inspected");
		});
		const hostile = Object.defineProperty({}, "rejectQueuedInput", { get: readOptions });
		const handle = await inExtension(h, "a", (ctx) => {
			const withExtraArgument = ctx.fenceInputs as (extra: unknown) => Promise<ExtensionInputFence>;
			return withExtraArgument(hostile);
		});
		expect(readOptions).not.toHaveBeenCalled();
		expect(nativeAcquire).toHaveBeenCalledExactlyOnceWith();
		handle.release();
	});

	it("keeps fence ownership per session, with a fresh session initially open (spec restart)", async () => {
		const first = await setup();
		const second = await setup();
		const held = await inExtension(first, "a", (ctx) => ctx.fenceInputs());
		expect(await inExtension(second, "a", (ctx) => ctx.getInputState())).toEqual({
			inputsFenced: false,
			inputAdmissionCount: 0,
			queued: 0,
			drained: true,
		});
		const other = await inExtension(second, "a", (ctx) => ctx.fenceInputs());
		held.release();
		expect(second.session.inputsFenced).toBe(true);
		other.release();
	});

	it.each(["newSession", "dispose"] as const)(
		"runtime %s refuses while fenced without changing the session (spec 8)",
		async (operation) => {
			const h = await setup();
			const factory = vi.fn(async () => {
				throw new Error("A fenced session must not allocate a replacement");
			});
			const runtime = new AgentSessionRuntime(
				h.session,
				{
					cwd: h.tempDir,
					agentDir: h.tempDir,
					modelRuntime: h.modelRuntime,
					settingsManager: h.settingsManager,
					resourceLoader: h.resourceLoader,
					diagnostics: [],
				},
				factory,
			);
			const handle = await inExtension(h, "a", (ctx) => ctx.fenceInputs());
			const generation = h.session.userMessageSessionGeneration;
			await expect(runtime[operation]()).rejects.toMatchObject({ code: "INPUT_ADMISSION_FENCED" });
			expect(runtime.session).toBe(h.session);
			expect(h.session.isDisposed).toBe(false);
			expect(h.session.inputsFenced).toBe(true);
			expect(h.session.userMessageSessionGeneration).toBe(generation);
			expect(factory).not.toHaveBeenCalled();
			handle.release();
		},
	);

	// #309 keep reason: data safety and recorded real catch. Refused operator quit poisoned the
	// live runtime; terminal shutdown instead failed before hooks and disposal could run.
	// https://github.com/Smarty-Pants-Inc/pi/pull/309#issuecomment-6401455682
	it("refuses operatorExit under an extension fence without side effects, then permits input and a later quit (#309 P1a)", async () => {
		const shutdowns: string[] = [];
		const h = await setup([
			(pi) => {
				pi.on("session_shutdown", (event) => {
					shutdowns.push(event.reason);
				});
			},
		]);
		const runtime = runtimeFor(h);
		const api = await inExtension(h, "b", (_ctx, pi) => pi);
		const handle = await inExtension(h, "a", (ctx) => ctx.fenceInputs());
		// A native queue owner can enqueue after acquisition. Explicit discard consent ensures
		// the refusal is the extension fence, not the in-memory session's unsaved-input warning.
		const queuedText = "native queued occurrence\n\u0000☃";
		h.session.agent.followUp({ role: "user", content: [{ type: "text", text: queuedText }], timestamp: 1 });
		const native = h.session as unknown as { _inputFence: object | undefined };
		const fence = native._inputFence;
		const generation = h.session.userMessageSessionGeneration;
		const queuedBytes = JSON.stringify(h.session.agent.getQueuedMessageOccurrences());
		const revision = h.session.queuedInputRevision;
		const signal = h.session.shutdownSignal;
		const sideEffects = [
			vi.spyOn(h.session, "prepareOperatorExit"),
			vi.spyOn(h.session, "cancelForShutdown"),
			vi.spyOn(h.session, "abort"),
			vi.spyOn(h.session, "abortBash"),
			vi.spyOn(h.session, "clearQueue"),
		];
		const beforeShutdown = vi.fn(async () => {});
		const bufferUnsentInput = vi.fn();
		const rejectQueuedInput = vi.fn();
		try {
			expect(fence).toBeDefined();
			await expect(
				runtime.dispose({
					operatorExit: true,
					discardUnsentInput: true,
					beforeShutdown,
					bufferUnsentInput,
					rejectQueuedInput,
				}),
			).rejects.toMatchObject({ code: "INPUT_ADMISSION_FENCED" });
			expect(runtime.session).toBe(h.session);
			expect(h.session.isDisposed).toBe(false);
			expect(h.session.shutdownSignal).toBe(signal);
			expect(signal.aborted).toBe(false);
			expect(native._inputFence).toBe(fence);
			expect(h.session.userMessageSessionGeneration).toBe(generation);
			expect(JSON.stringify(h.session.agent.getQueuedMessageOccurrences())).toBe(queuedBytes);
			expect(h.session.queuedInputRevision).toBe(revision);
			expect(getUserTexts(h)).toEqual([]);
			expect(shutdowns).toEqual([]);
			for (const effect of [...sideEffects, beforeShutdown, bufferUnsentInput, rejectQueuedInput]) {
				expect(effect).not.toHaveBeenCalled();
			}
			expect(await inExtension(h, "a", (ctx) => ctx.fenceInputs())).toBe(handle);
			handle.release();
			expect(runtime.inputsFenced).toBe(false);
			expect(h.session.userMessageSessionGeneration).toBe(generation);
			h.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("still usable after refused quit")));
			await h.session.prompt("prompt after refused quit");
			expect(
				await api.submitUserMessage({
					registrationEpoch: "fence-quit-test",
					requestId: "after-refused-quit",
					sessionGeneration: generation,
					text: "submit after refused quit",
					deliverAs: "followUp",
					expandPromptTemplates: false,
				}),
			).toEqual({ status: "accepted", sessionGeneration: generation });
			await h.session.waitForIdle();
			expect(getUserTexts(h)).toEqual(["prompt after refused quit", queuedText, "submit after refused quit"]);
			expect(h.session.agent.getQueuedMessageOccurrences()).toEqual([]);
			await runtime.dispose({ operatorExit: true });
			expect(shutdowns).toEqual(["quit"]);
			expect(signal.aborted).toBe(true);
			expect(h.session.isDisposed).toBe(true);
		} finally {
			handle.release();
		}
	});

	// #309 RFL-F1 keep reason: data safety and the frozen-candidate same-turn reproduction.
	// A lifecycle awaiting a failed native acquisition does not own the extension's fence. The rejecting
	// variant pins RFL-F3's early ownership: a foreign token never counts as the lifecycle's own.
	// https://github.com/Smarty-Pants-Inc/pi/pull/309#issuecomment-6401455682
	it.each(["ordinary", "rejecting ordinary"] as const)(
		"refuses both same-turn %s disposal and operatorExit under an extension fence (#309 RFL-F1)",
		async (variant) => {
			const shutdowns: string[] = [];
			const h = await setup([
				(pi) => {
					pi.on("session_shutdown", (event) => {
						shutdowns.push(event.reason);
					});
				},
			]);
			const runtime = runtimeFor(h);
			const handle = await inExtension(h, "a", (ctx) => ctx.fenceInputs());
			const disposals: Promise<void>[] = [];
			try {
				const queuedText = "same-turn queued occurrence\n\u0000☃";
				h.session.agent.followUp({ role: "user", content: [{ type: "text", text: queuedText }], timestamp: 1 });
				const native = h.session as unknown as { _inputFence: object | undefined };
				const fence = native._inputFence;
				const generation = h.session.userMessageSessionGeneration;
				const queuedBytes = JSON.stringify(h.session.agent.getQueuedMessageOccurrences());
				const transcriptBytes = JSON.stringify(h.session.messages);
				const revision = h.session.queuedInputRevision;
				const signal = h.session.shutdownSignal;
				const state = await inExtension(h, "a", (ctx) => ctx.getInputState());
				const eventCount = h.events.length;
				const sideEffects = [
					vi.spyOn(h.session, "prepareOperatorExit"),
					vi.spyOn(h.session, "cancelForShutdown"),
					vi.spyOn(h.session, "abort"),
					vi.spyOn(h.session, "abortBash"),
					vi.spyOn(h.session, "clearQueue"),
				];
				const beforeShutdown = vi.fn(async () => {});
				const beforeInvalidate = vi.fn();
				const bufferUnsentInput = vi.fn();
				const rejectQueuedInput = vi.fn();
				const ordinaryRejectQueuedInput = vi.fn();
				runtime.setBeforeSessionInvalidate(beforeInvalidate);
				// No await between calls: observe both promises in this turn, before either unwinds.
				// Discard consent prevents the queue from masking the foreign-fence takeover bug.
				const ordinary = runtime.dispose(
					variant === "rejecting ordinary" ? { rejectQueuedInput: ordinaryRejectQueuedInput } : undefined,
				);
				disposals.push(ordinary);
				const operator = runtime.dispose({
					operatorExit: true,
					discardUnsentInput: true,
					beforeShutdown,
					bufferUnsentInput,
					rejectQueuedInput,
				});
				disposals.push(operator);
				const outcomes = await Promise.allSettled(disposals);
				expect(outcomes).toEqual([
					{ status: "rejected", reason: expect.objectContaining({ code: "INPUT_ADMISSION_FENCED" }) },
					{ status: "rejected", reason: expect.objectContaining({ code: "INPUT_ADMISSION_FENCED" }) },
				]);
				expect(fence).toBeDefined();
				expect(runtime.session).toBe(h.session);
				expect(runtime.inputsFenced).toBe(true);
				expect(h.session.isDisposed).toBe(false);
				expect(h.session.shutdownSignal).toBe(signal);
				expect(signal.aborted).toBe(false);
				expect(native._inputFence).toBe(fence);
				expect(h.session.userMessageSessionGeneration).toBe(generation);
				expect(JSON.stringify(h.session.agent.getQueuedMessageOccurrences())).toBe(queuedBytes);
				expect(JSON.stringify(h.session.messages)).toBe(transcriptBytes);
				expect(h.session.queuedInputRevision).toBe(revision);
				expect(await inExtension(h, "a", (ctx) => ctx.getInputState())).toEqual(state);
				expect(h.events).toHaveLength(eventCount);
				expect(h.faux.state.callCount).toBe(0);
				expect(shutdowns).toEqual([]);
				for (const effect of [
					...sideEffects,
					beforeShutdown,
					beforeInvalidate,
					bufferUnsentInput,
					rejectQueuedInput,
					ordinaryRejectQueuedInput,
				]) {
					expect(effect).not.toHaveBeenCalled();
				}
				expect(await inExtension(h, "a", (ctx) => ctx.fenceInputs())).toBe(handle);
				handle.release();
				expect(native._inputFence).toBeUndefined();
				expect(runtime.inputsFenced).toBe(false);
				expect(h.session.userMessageSessionGeneration).toBe(generation);
				h.setResponses(Array.from({ length: 2 }, () => fauxAssistantMessage("usable after same-turn refusal")));
				await h.session.prompt("prompt after same-turn refused quit");
				expect(getUserTexts(h)).toEqual(["prompt after same-turn refused quit", queuedText]);
				expect(h.session.agent.getQueuedMessageOccurrences()).toEqual([]);
				expect(h.faux.state.callCount).toBeGreaterThan(0);
				expect(signal.aborted).toBe(false);
				await runtime.dispose({ operatorExit: true });
				expect(shutdowns).toEqual(["quit"]);
				expect(beforeInvalidate).toHaveBeenCalledTimes(1);
				expect(signal.aborted).toBe(true);
				expect(h.session.isDisposed).toBe(true);
			} finally {
				handle.release();
				await Promise.allSettled(disposals);
			}
		},
	);

	// #309 RFL-F1 counterexample: real native acquisition succeeds before operator takeover.
	// Blanket refusal of an active lifecycle would break this supported same-turn quit.
	// https://github.com/Smarty-Pants-Inc/pi/pull/309#issuecomment-6401455682
	it("permits same-turn operatorExit after ordinary disposal actually acquires its native fence (#309 RFL-F1)", async () => {
		const shutdowns: string[] = [];
		const h = await setup([
			(pi) => {
				pi.on("session_shutdown", (event) => {
					shutdowns.push(event.reason);
				});
			},
		]);
		const runtime = runtimeFor(h);
		const native = h.session as unknown as { _inputFence: object | undefined };
		const initialFence = native._inputFence;
		const generation = h.session.userMessageSessionGeneration;
		const prepare = vi.spyOn(h.session, "prepareOperatorExit");
		const cancel = vi.spyOn(h.session, "cancelForShutdown");
		const disposals: Promise<void>[] = [];
		try {
			const ordinary = runtime.dispose();
			disposals.push(ordinary);
			// The native fence and generation change synchronously, without faking ownership
			// or waiting for the runtime's acquisition continuation to run.
			const ownedFence = native._inputFence;
			const ownedGeneration = h.session.userMessageSessionGeneration;
			const operator = runtime.dispose({ operatorExit: true });
			disposals.push(operator);
			const outcomes = await Promise.allSettled(disposals);
			expect(initialFence).toBeUndefined();
			expect(ownedFence).toBeDefined();
			expect(ownedGeneration).not.toBe(generation);
			expect(outcomes).toEqual([
				{ status: "fulfilled", value: undefined },
				{ status: "fulfilled", value: undefined },
			]);
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(runtime.session).toBe(h.session);
			expect(shutdowns).toEqual(["quit"]);
			expect(h.session.shutdownSignal.aborted).toBe(true);
			expect(h.session.isDisposed).toBe(true);
			expect(runtime.inputsFenced).toBe(true);
			expect(h.session.inputsFenced).toBe(true);
			expect(h.session.agent.getQueuedMessageOccurrences()).toEqual([]);
			expect(h.faux.state.callCount).toBe(0);
		} finally {
			await Promise.allSettled(disposals);
		}
	});

	// #309 RFL-F3 keep reason: allowed-case wait cycle from the independent audit. A rejecting ordinary
	// disposal owns its native fence while abort waits on a noncooperative agent_start. Operator quit
	// must still reach shutdown cancellation, which releases that wait, instead of joining the abort.
	// https://github.com/Smarty-Pants-Inc/pi/pull/309#issuecomment-6401455682
	it("lets same-turn operatorExit cancel an owned rejecting disposal held in agent_start (#309 RFL-F3)", async () => {
		const entered = gate();
		const held = gate();
		const shutdowns: string[] = [];
		const h = await setup([
			(pi) => {
				// Noncooperative: ignores the run's abort signal and only returns on release.
				pi.on("agent_start", async () => {
					entered.release();
					await held.promise;
				});
				pi.on("session_shutdown", (event) => {
					shutdowns.push(event.reason);
				});
			},
		]);
		const runtime = runtimeFor(h);
		const native = h.session as unknown as { _inputFence: object | undefined };
		const prepare = vi.spyOn(h.session, "prepareOperatorExit");
		const cancel = vi.spyOn(h.session, "cancelForShutdown");
		const rejectQueuedInput = vi.fn();
		const bufferUnsentInput = vi.fn();
		const pending: Promise<unknown>[] = [];
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			h.setResponses([fauxAssistantMessage("must not run after shutdown cancellation")]);
			pending.push(h.session.prompt("held by noncooperative agent_start"));
			await entered.promise;
			expect(h.session.inputAdmissionCount).toBe(0);
			expect(native._inputFence).toBeUndefined();
			// No await between calls. The ordinary call installs its real native fence synchronously,
			// then waits in native abort for the held run.
			const ordinary = runtime.dispose({ rejectQueuedInput });
			pending.push(ordinary);
			const ownedFence = native._inputFence;
			const operator = runtime.dispose({ operatorExit: true, discardUnsentInput: true, bufferUnsentInput });
			pending.push(operator);
			const outcomes = await Promise.race([
				Promise.allSettled([ordinary, operator]),
				new Promise<"wait cycle">((resolve) => {
					timer = setTimeout(() => resolve("wait cycle"), 5000);
				}),
			]);
			expect(ownedFence).toBeDefined();
			expect(outcomes).toEqual([
				{ status: "fulfilled", value: undefined },
				{ status: "fulfilled", value: undefined },
			]);
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(cancel).toHaveBeenCalledTimes(1);
			// Operator preparation retained the held prompt (in-memory session: buffered, not discarded).
			expect(bufferUnsentInput).toHaveBeenCalledTimes(1);
			expect(bufferUnsentInput.mock.calls[0]?.[0]).toContain("held by noncooperative agent_start");
			expect(rejectQueuedInput).not.toHaveBeenCalled();
			expect(shutdowns).toEqual(["quit"]);
			expect(h.session.shutdownSignal.aborted).toBe(true);
			expect(h.session.isDisposed).toBe(true);
			expect(runtime.inputsFenced).toBe(true);
			expect(h.session.agent.getQueuedMessageOccurrences()).toEqual([]);
			expect(h.faux.state.callCount).toBe(0);
		} finally {
			clearTimeout(timer);
			// Explicit terminal shutdown rescues the RED wait cycle so cleanup cannot hang.
			pending.push(runtime.dispose({ terminal: true }));
			held.release();
			await Promise.allSettled(pending);
		}
	});

	it("terminal shutdown takes over an extension fence, runs hooks once, and cannot be reopened by release (#309 P1b)", async () => {
		const entered = gate();
		const held = gate();
		const shutdowns: Array<{ reason: string; state: ExtensionInputState; aborted: boolean; disposed: boolean }> = [];
		const h = await setup([
			(pi) => {
				pi.on("session_shutdown", async (event, ctx) => {
					shutdowns.push({
						reason: event.reason,
						state: ctx.getInputState(),
						aborted: h.session.shutdownSignal.aborted,
						disposed: h.session.isDisposed,
					});
					entered.release();
					await held.promise;
				});
			},
		]);
		const runtime = runtimeFor(h);
		const handle = await inExtension(h, "a", (ctx) => ctx.fenceInputs());
		const disposing = runtime.dispose({ terminal: true });
		try {
			await Promise.race([
				entered.promise,
				disposing.then(() => {
					throw new Error("Terminal disposal completed without entering the shutdown hook");
				}),
			]);
			expect(shutdowns).toEqual([
				{
					reason: "quit",
					state: { inputsFenced: true, inputAdmissionCount: 0, queued: 0, drained: true },
					aborted: true,
					disposed: false,
				},
			]);
			handle.release();
			expect(h.session.inputsFenced).toBe(true);
			await expect(h.session.followUp("old release during terminal cleanup")).rejects.toMatchObject({
				code: "INPUT_ADMISSION_FENCED",
			});
			held.release();
			await disposing;
			expect(h.session.isDisposed).toBe(true);
			handle.release();
			await runtime.dispose({ terminal: true });
			expect(shutdowns).toHaveLength(1);
			expect(runtime.inputsFenced).toBe(true);
			expect(h.session.inputsFenced).toBe(true);
			await expect(h.session.prompt("old release after disposal")).rejects.toMatchObject({
				code: "INPUT_ADMISSION_SHUTDOWN",
			});
			await expect(h.session.followUp("old release after disposal")).rejects.toMatchObject({
				code: "INPUT_ADMISSION_DISPOSED",
			});
			expect(getUserTexts(h)).toEqual([]);
		} finally {
			held.release();
			handle.release();
			await disposing;
		}
	});

	// #309 keep reason: trust boundary. Lifecycle scope permits ordinary input, not taking over
	// the runtime's native fence. Exercise real replacement, loader-bound handlers and receipt ingress.
	it.each([
		["session_start", "drained"],
		["session_start", "busy"],
		["withSession", "drained"],
		["withSession", "busy"],
	] as const)("replacement lifecycle %s refuses fence acquisition while %s (#309)", async (phase, state) => {
		const entered = gate();
		const held = gate();
		const ordinaryTexts = state === "busy" ? ["ordinary\n\u0000☃", "ordinary\n\u0000☃"] : [];
		const scopedText = "ordinary scoped input after refused acquisition";
		const errors: Array<{ event: string; error: string }> = [];
		const starts: string[] = [];
		const ready: Array<{ event: SessionReadyEvent; sessionFenced: boolean; runtimeFenced: boolean }> = [];
		let before!: LifecycleFenceSnapshot;
		let after!: LifecycleFenceSnapshot;
		let refusal: unknown;
		let callbackError: unknown;
		let acquired: ExtensionInputFence | undefined;
		let scopedAccepted = false;
		let receiving!: Harness;
		let runtime!: AgentSessionRuntime;
		const probe = async (ctx: ExtensionContext) => {
			try {
				const session = runtime.session;
				const native = session as unknown as { _inputFence: object | undefined };
				for (const text of ordinaryTexts) {
					await session.followUp(text, [{ type: "image", data: "ordinary-image-bytes", mimeType: "image/png" }]);
				}
				const snapshot = (): LifecycleFenceSnapshot => ({
					fence: native._inputFence,
					generation: ctx.userMessageSessionGeneration,
					queuedBytes: JSON.stringify(session.agent.getQueuedMessageOccurrences()),
					state: ctx.getInputState(),
				});
				before = snapshot();
				try {
					acquired = await ctx.fenceInputs();
				} catch (error) {
					refusal = error;
				} finally {
					// A buggy successful acquisition must not strand its handle or suppress cleanup/readiness.
					acquired?.release();
				}
				after = snapshot();
				await session.followUp(scopedText);
				scopedAccepted = true;
			} catch (error) {
				callbackError = error;
			} finally {
				// Runner.emit catches handler exceptions: signal even on failure and assert only in the test.
				entered.release();
				await held.promise;
			}
		};
		const lifecycle: ExtensionFactory = (pi) => {
			pi.on("session_start", async (event, ctx) => {
				starts.push(event.reason);
				if (phase === "session_start") {
					await probe(ctx);
				}
			});
			pi.on("session_ready", (event) => {
				ready.push({ event, sessionFenced: runtime.session.inputsFenced, runtimeFenced: runtime.inputsFenced });
			});
		};
		const initial = await setup();
		const services = (h: Harness) => ({
			cwd: initial.tempDir,
			agentDir: initial.tempDir,
			modelRuntime: h.modelRuntime,
			settingsManager: h.settingsManager,
			resourceLoader: h.resourceLoader,
			diagnostics: [],
		});
		runtime = new AgentSessionRuntime(initial.session, services(initial), async (options) => {
			receiving = await setup([lifecycle], options);
			return {
				session: receiving.session,
				services: services(receiving),
				extensionsResult: receiving.resourceLoader.getExtensions(),
				diagnostics: [],
			};
		});
		runtime.setRebindSession((session) => session.bindExtensions({ onError: (error) => errors.push(error) }));
		let replacementSettled = false;
		// The loader-bound command supplies real extension attribution to withSession as well.
		const replacing = inExtension(initial, "a", () =>
			runtime.newSession({ withSession: phase === "withSession" ? probe : undefined }),
		);
		void replacing.then(
			() => {
				replacementSettled = true;
			},
			() => {
				replacementSettled = true;
			},
		);
		try {
			// Early replacement completion/rejection fails promptly instead of waiting on a missing handler.
			await Promise.race([
				entered.promise,
				replacing.then(() => {
					throw new Error("Replacement completed without entering the held lifecycle probe");
				}),
			]);
			expect(acquired).toBeUndefined();
			expect(refusal).toBeInstanceOf(InputAdmissionError);
			expect(refusal).toMatchObject({ code: "INPUT_ADMISSION_FENCED" });
			expect(callbackError).toBeUndefined();
			expect(starts).toEqual(["new"]);
			expect(before.fence).toBeDefined();
			expect(before.state).toEqual({
				inputsFenced: true,
				inputAdmissionCount: 0,
				queued: ordinaryTexts.length,
				drained: state === "drained",
			});
			expect(after.fence).toBe(before.fence);
			expect(after.generation).toBe(before.generation);
			expect(after.queuedBytes).toBe(before.queuedBytes);
			expect(after.state).toEqual(before.state);
			expect(scopedAccepted).toBe(true);
			const session = receiving.session;
			expect(runtime.session).toBe(session);
			expect(session.inputsFenced).toBe(true);
			expect(session.userMessageSessionGeneration).toBe(before.generation);
			expect(session.getFollowUpMessages()).toEqual([...ordinaryTexts, scopedText]);
			const queuedBytes = JSON.stringify(session.agent.getQueuedMessageOccurrences());
			await expect(session.followUp("outside direct admission")).rejects.toMatchObject({
				code: "INPUT_ADMISSION_FENCED",
			});
			expect(
				await inExtension(receiving, "b", (_ctx, pi) =>
					pi.submitUserMessage({
						registrationEpoch: "lifecycle-fence-test",
						requestId: "outside-lifecycle",
						sessionGeneration: before.generation,
						text: "outside receipt ingress",
						deliverAs: "followUp",
						expandPromptTemplates: false,
					}),
				),
			).toEqual({ status: "rejected", reason: "session_changed", sessionGeneration: before.generation });
			expect(session.inputsFenced).toBe(true);
			expect(session.userMessageSessionGeneration).toBe(before.generation);
			expect(JSON.stringify(session.agent.getQueuedMessageOccurrences())).toBe(queuedBytes);
			expect(replacementSettled).toBe(false);
			expect(ready).toEqual([]);
			held.release();
			await expect(replacing).resolves.toEqual({ cancelled: false });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(ready).toEqual([
				{
					event: { type: "session_ready", reason: "new", sessionGeneration: before.generation },
					sessionFenced: false,
					runtimeFenced: false,
				},
			]);
			expect(errors).toEqual([]);
			receiving.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("ordinary input delivered")));
			await session.prompt("drain lifecycle queue");
			expect(getUserTexts(receiving)).toEqual(["drain lifecycle queue", ...ordinaryTexts, scopedText]);
			const fresh = await inExtension(receiving, "a", (ctx) => ctx.fenceInputs());
			try {
				expect(session.inputsFenced).toBe(true);
				await expect(session.followUp("outside fresh extension fence")).rejects.toMatchObject({
					code: "INPUT_ADMISSION_FENCED",
				});
			} finally {
				fresh.release();
			}
			expect(session.inputsFenced).toBe(false);
		} finally {
			held.release();
			acquired?.release();
			await replacing;
		}
	});

	// smarty-dev#15310: the lead's native-semantics ruling resolves original spec 7/8/11.
	// Direct disposal seals an idle fenced session and invalidates its runner/context.
	it("pins direct disposal sealing and stale context precedence over DISPOSED (spec 7/8/11 ruling)", async () => {
		const h = await setup();
		let ctx!: ExtensionContext;
		const handle = await inExtension(h, "a", (context) => {
			ctx = context;
			return context.fenceInputs();
		});
		h.session.dispose();
		expect(h.session.isDisposed).toBe(true);
		handle.release();
		handle.release();
		expect(h.session.inputsFenced).toBe(true);
		await expect(h.session.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_DISPOSED" });
		expect(() => ctx.getInputState()).toThrow(/extension ctx is stale/);
		await expect(Promise.resolve().then(() => ctx.fenceInputs())).rejects.toThrow(/extension ctx is stale/);
	});

	// smarty-dev#15310: the lead's native-semantics ruling preserves reload without acquiring
	// a fence. A retained release works, but the invalidated context cannot acquire again.
	it("pins reload replacing the runner without automatically releasing its native fence (spec 8/11 ruling)", async () => {
		let shutdownCtx!: ExtensionContext;
		let shutdownState: ExtensionInputState | undefined;
		const h = await setup([
			(pi) => {
				pi.on("session_shutdown", (_event, ctx) => {
					shutdownCtx = ctx;
					shutdownState = ctx.getInputState();
				});
			},
		]);
		let oldCtx!: ExtensionContext;
		const held = await inExtension(h, "a", (ctx) => {
			oldCtx = ctx;
			return ctx.fenceInputs();
		});
		const oldRunner = h.session.extensionRunner;
		const generation = h.session.userMessageSessionGeneration;
		await h.session.reload();
		expect(h.session.extensionRunner).not.toBe(oldRunner);
		expect(h.session.userMessageSessionGeneration).not.toBe(generation);
		expect(h.session.isDisposed).toBe(false);
		expect(h.session.inputsFenced).toBe(true);
		expect(shutdownState).toEqual({ inputsFenced: true, inputAdmissionCount: 0, queued: 0, drained: true });
		expect(() => shutdownCtx.getInputState()).toThrow(/extension ctx is stale/);
		await expect(Promise.resolve().then(() => shutdownCtx.fenceInputs())).rejects.toThrow(/extension ctx is stale/);
		expect(() => oldCtx.getInputState()).toThrow(/extension ctx is stale/);
		await expect(Promise.resolve().then(() => oldCtx.fenceInputs())).rejects.toThrow(/extension ctx is stale/);
		await inExtension(h, "a", async (ctx) => {
			expect(ctx.getInputState()).toEqual({
				inputsFenced: true,
				inputAdmissionCount: 0,
				queued: 0,
				drained: true,
			});
			await expect(ctx.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_FENCED" });
		});
		held.release();
		const fresh = await inExtension(h, "a", (ctx) => ctx.fenceInputs());
		held.release();
		expect(h.session.inputsFenced).toBe(true);
		fresh.release();
	});

	it("reports settlement as busy through the actual extension callback boundary (spec 10)", async () => {
		const entered = gate();
		const held = gate();
		const h = await setup([
			(pi) => {
				pi.on("agent_settled", async () => {
					entered.release();
					await held.promise;
				});
			},
		]);
		h.setResponses([fauxAssistantMessage("settling")]);
		const run = h.session.prompt("start settlement");
		await entered.promise;
		await inExtension(h, "a", async (ctx) => {
			expect(ctx.isSettling()).toBe(true);
			expect(ctx.getInputState().drained).toBe(false);
			await expect(ctx.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
		});
		held.release();
		await run;
		expect(await inExtension(h, "a", (ctx) => ctx.getInputState())).toMatchObject({ drained: true });
	});

	it("includes mode-owned input in the native drained predicate (spec 10)", async () => {
		const h = await setup();
		let pending = true;
		await h.session.bindExtensions({ mode: "tui", hasPendingInput: () => pending });
		await inExtension(h, "a", async (ctx) => {
			expect(ctx.getInputState()).toEqual({
				inputsFenced: false,
				inputAdmissionCount: 0,
				queued: 0,
				drained: false,
			});
			await expect(ctx.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
		});
		pending = false;
		const handle = await inExtension(h, "a", (ctx) => ctx.fenceInputs());
		handle.release();
	});

	it("matches _assertInputsDrained for every isolated native bookkeeping busy state (spec 10)", async () => {
		const h = await setup();
		// Isolate redundant bookkeeping branches that normally overlap admissions/queues. Native
		// fenceInputs and its drain assertion remain real; restore each seeded field before cleanup.
		const native = h.session as unknown as {
			_assertInputsDrained(): void;
			_inputAdmissions: Set<object>;
			_isEmittingAgentSettled: boolean;
			_steeringMessages: unknown[];
			_followUpMessages: unknown[];
			_triggeredBehindPreflight: unknown[];
			_modelSwitchDispatches: Map<object, unknown>;
			_deferredSettledActions: unknown[];
			_pendingNextTurnMessages: unknown[];
			_pendingCustomMessages: unknown[];
		};
		const fields = [
			"_steeringMessages",
			"_followUpMessages",
			"_triggeredBehindPreflight",
			"_deferredSettledActions",
			"_pendingNextTurnMessages",
			"_pendingCustomMessages",
		] as const;
		const states = [
			...fields.map((field) => ({
				name: field,
				seed: () => {
					native[field].push({});
					return () => native[field].splice(0);
				},
			})),
			{
				name: "_modelSwitchDispatches",
				seed: () => {
					const key = {};
					native._modelSwitchDispatches.set(key, {});
					return () => native._modelSwitchDispatches.delete(key);
				},
			},
			{
				name: "_inputAdmissions",
				seed: () => {
					const admission = {};
					native._inputAdmissions.add(admission);
					return () => native._inputAdmissions.delete(admission);
				},
			},
			{
				name: "isSettling",
				seed: () => {
					native._isEmittingAgentSettled = true;
					return () => {
						native._isEmittingAgentSettled = false;
					};
				},
			},
		];
		await inExtension(h, "a", async (ctx) => {
			for (const state of states) {
				const restore = state.seed();
				try {
					expect(ctx.getInputState().drained, state.name).toBe(false);
					expect(() => native._assertInputsDrained(), state.name).toThrow(InputAdmissionError);
					await expect(ctx.fenceInputs(), state.name).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
					expect(ctx.getInputState().inputsFenced, state.name).toBe(false);
				} finally {
					restore();
				}
				expect(() => native._assertInputsDrained()).not.toThrow();
				expect(ctx.getInputState().drained).toBe(true);
			}
		});
	});

	it("counts both complete native queues rather than only display text (spec 10)", async () => {
		const h = await setup();
		h.session.agent.steer({ role: "user", content: [{ type: "text", text: "native steer" }], timestamp: 1 });
		h.session.agent.followUp({ role: "user", content: [{ type: "text", text: "native follow-up" }], timestamp: 2 });
		await inExtension(h, "a", async (ctx) => {
			expect(ctx.getInputState()).toEqual({
				inputsFenced: false,
				inputAdmissionCount: 0,
				queued: 2,
				drained: false,
			});
			await expect(ctx.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
		});
		expect(h.session.agent.getQueuedMessages().map(getMessageText)).toEqual(["native steer", "native follow-up"]);
	});

	// #309 keep reason: data safety and recorded real catch. A refused extension fence must not
	// revoke a held receipt or remove tagged queue occurrences, including duplicate ordinary text.
	// https://github.com/Smarty-Pants-Inc/pi/pull/309#issuecomment-6401455682
	it("preserves held receipt ingress on extension BUSY and delivers once (#309 P2)", async () => {
		const entered = gate();
		const held = gate();
		const text = "held receipt ingress\n\u0000☃";
		let inputCalls = 0;
		const h = await setup([
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text !== text) return;
					inputCalls++;
					entered.release();
					await held.promise;
				});
			},
		]);
		const ordinaryTexts = ["ordinary queue survives\n\u0000☃", "ordinary queue survives\n\u0000☃"];
		for (const ordinary of ordinaryTexts) await h.session.followUp(ordinary);
		const queuedBytes = JSON.stringify(h.session.agent.getQueuedMessageOccurrences());
		const generation = h.session.userMessageSessionGeneration;
		const api = await inExtension(h, "b", (_ctx, pi) => pi);
		const request: SubmitUserMessageOptions = {
			registrationEpoch: "fence-test",
			requestId: "held",
			sessionGeneration: generation,
			text,
			deliverAs: "followUp",
			expandPromptTemplates: false,
		};
		h.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("held input delivered")));
		const ingress = api.submitUserMessage(request);
		const duplicate = api.submitUserMessage({ ...request });
		let receiptSettlements = 0;
		for (const receipt of [ingress, duplicate]) {
			void receipt.then(
				() => {
					receiptSettlements++;
				},
				() => {
					receiptSettlements++;
				},
			);
		}
		let acquired: ExtensionInputFence | undefined;
		try {
			await Promise.race([
				entered.promise,
				ingress.then(() => {
					throw new Error("Receipt settled without entering the held input handler");
				}),
			]);
			expect(h.session.inputAdmissionCount).toBe(1);
			const nativeAcquire = vi.spyOn(h.session, "fenceInputs");
			await expect(
				inExtension(h, "a", async (ctx) => {
					acquired = await ctx.fenceInputs();
				}),
			).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(receiptSettlements).toBe(0);
			expect(h.session.userMessageSessionGeneration).toBe(generation);
			expect(h.session.inputAdmissionCount).toBe(1);
			expect(h.session.inputsFenced).toBe(false);
			expect(JSON.stringify(h.session.agent.getQueuedMessageOccurrences())).toBe(queuedBytes);
			expect(h.session.getFollowUpMessages()).toEqual(ordinaryTexts);
			expect(nativeAcquire).not.toHaveBeenCalled();
			expect(inputCalls).toBe(1);
			expect(getUserTexts(h)).toEqual([]);
			held.release();
			expect(await ingress).toEqual({ status: "accepted", sessionGeneration: generation });
			expect(await duplicate).toEqual({
				status: "accepted",
				sessionGeneration: generation,
				duplicate: true,
				admittedSessionGeneration: generation,
			});
			await h.session.waitForIdle();
			expect(h.session.userMessageSessionGeneration).toBe(generation);
			expect(h.session.inputAdmissionCount).toBe(0);
			expect(inputCalls).toBe(1);
			expect(getUserTexts(h)).toEqual([text, ...ordinaryTexts]);
			expect(h.session.agent.getQueuedMessageOccurrences()).toEqual([]);
		} finally {
			acquired?.release();
			held.release();
			await Promise.allSettled([ingress, duplicate]);
			await h.session.waitForIdle();
		}
	});

	it("preserves every queued occurrence on extension BUSY and delivers once (#309 P2)", async () => {
		const entered = gate();
		const held = gate();
		const text = "queued receipt ingress\n\u0000☃";
		let inputCalls = 0;
		const h = await setup([
			(pi) => {
				pi.on("input", (event) => {
					if (event.text === text) inputCalls++;
				});
			},
		]);
		const api = await inExtension(h, "b", (_ctx, pi) => pi);
		h.setResponses([
			async () => {
				entered.release();
				await held.promise;
				return fauxAssistantMessage("active turn complete");
			},
			...Array.from({ length: 3 }, () => fauxAssistantMessage("queued input delivered")),
		]);
		const run = h.session.prompt("active turn");
		let acquired: ExtensionInputFence | undefined;
		try {
			await Promise.race([
				entered.promise,
				run.then(() => {
					throw new Error("Active turn completed without entering the held faux response");
				}),
			]);
			const ordinaryTexts = ["ordinary follow-up survives\n\u0000☃", "ordinary follow-up survives\n\u0000☃"];
			for (const ordinary of ordinaryTexts) await h.session.followUp(ordinary);
			const generation = h.session.userMessageSessionGeneration;
			const request: SubmitUserMessageOptions = {
				registrationEpoch: "fence-test",
				requestId: "queued",
				sessionGeneration: generation,
				text,
				deliverAs: "followUp",
				expandPromptTemplates: false,
			};
			expect(await api.submitUserMessage(request)).toEqual({ status: "queued", sessionGeneration: generation });
			const queuedBytes = JSON.stringify(h.session.agent.getQueuedMessageOccurrences());
			expect(h.session.agent.getQueuedMessages().map(getMessageText)).toEqual([...ordinaryTexts, text]);
			const nativeAcquire = vi.spyOn(h.session, "fenceInputs");
			await expect(
				inExtension(h, "a", async (ctx) => {
					acquired = await ctx.fenceInputs();
				}),
			).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
			expect(h.session.userMessageSessionGeneration).toBe(generation);
			expect(h.session.inputsFenced).toBe(false);
			expect(JSON.stringify(h.session.agent.getQueuedMessageOccurrences())).toBe(queuedBytes);
			expect(h.session.getFollowUpMessages()).toEqual([...ordinaryTexts, text]);
			expect(nativeAcquire).not.toHaveBeenCalled();
			const duplicateReceipt = {
				status: "queued",
				sessionGeneration: generation,
				duplicate: true,
				admittedSessionGeneration: generation,
			};
			expect(await api.submitUserMessage({ ...request })).toEqual(duplicateReceipt);
			expect(JSON.stringify(h.session.agent.getQueuedMessageOccurrences())).toBe(queuedBytes);
			expect(inputCalls).toBe(1);
			held.release();
			await run;
			expect(getUserTexts(h)).toEqual(["active turn", ...ordinaryTexts, text]);
			expect(h.session.agent.getQueuedMessageOccurrences()).toEqual([]);
			expect(h.session.userMessageSessionGeneration).toBe(generation);
			expect(await api.submitUserMessage({ ...request })).toEqual(duplicateReceipt);
			expect(inputCalls).toBe(1);
			expect(getUserTexts(h)).toEqual(["active turn", ...ordinaryTexts, text]);
		} finally {
			acquired?.release();
			held.release();
			await run;
		}
	});

	// #309 keep reason: data safety at the extension/native boundary. Native lifecycle fencing
	// must still cancel held-only ingress and succeed; moving the extension precheck into native breaks it.
	// https://github.com/Smarty-Pants-Inc/pi/pull/309#issuecomment-6401455682
	it("retains native lifecycle cancellation of held-only receipt ingress (#309 P2)", async () => {
		const entered = gate();
		const held = gate();
		const returned = gate();
		const text = "held-only native cancellation\n\u0000☃";
		let inputCalls = 0;
		const h = await setup([
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text !== text) return;
					inputCalls++;
					entered.release();
					try {
						await held.promise;
					} finally {
						returned.release();
					}
				});
			},
		]);
		const api = await inExtension(h, "b", (_ctx, pi) => pi);
		const generation = h.session.userMessageSessionGeneration;
		const request: SubmitUserMessageOptions = {
			registrationEpoch: "fence-test",
			requestId: "held-only-native",
			sessionGeneration: generation,
			text,
			deliverAs: "followUp",
			expandPromptTemplates: false,
		};
		const ingress = api.submitUserMessage(request);
		const duplicate = api.submitUserMessage({ ...request });
		let releaseNative: (() => void) | undefined;
		try {
			await Promise.race([
				entered.promise,
				ingress.then(() => {
					throw new Error("Receipt settled without entering the native cancellation probe");
				}),
			]);
			expect(h.session.inputAdmissionCount).toBe(1);
			expect(h.session.agent.getQueuedMessageOccurrences()).toEqual([]);
			releaseNative = await h.session.fenceInputs();
			const nextGeneration = h.session.userMessageSessionGeneration;
			expect(nextGeneration).not.toBe(generation);
			expect(h.session.inputsFenced).toBe(true);
			expect(h.session.inputAdmissionCount).toBe(0);
			const cancelled = { status: "rejected", reason: "session_changed", sessionGeneration: generation };
			expect(await ingress).toEqual(cancelled);
			expect(await duplicate).toEqual({ ...cancelled, duplicate: true });
			releaseNative();
			held.release();
			await returned.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(inputCalls).toBe(1);
			expect(h.session.inputsFenced).toBe(false);
			expect(h.session.agent.getQueuedMessageOccurrences()).toEqual([]);
			expect(getUserTexts(h)).toEqual([]);
			expect(h.faux.state.callCount).toBe(0);
			h.setResponses([fauxAssistantMessage("fresh native generation reply")]);
			expect(
				await api.submitUserMessage({
					...request,
					requestId: "after-native-cancellation",
					sessionGeneration: nextGeneration,
					text: "fresh input after native cancellation",
				}),
			).toEqual({ status: "accepted", sessionGeneration: nextGeneration });
			await h.session.waitForIdle();
			expect(getUserTexts(h)).toEqual(["fresh input after native cancellation"]);
		} finally {
			releaseNative?.();
			held.release();
			await Promise.allSettled([ingress, duplicate]);
			if (inputCalls > 0) await returned.promise;
			await h.session.waitForIdle();
		}
	});
});
