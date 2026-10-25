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
} from "../../src/core/extensions/index.ts";
import { HOST_CAPABILITIES } from "../../src/core/host-capabilities.ts";
import { InputAdmissionError } from "../../src/core/input-admission.ts";
import { HOST_CAPABILITIES as PUBLIC_HOST_CAPABILITIES } from "../../src/index.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

type ProbeAction = (ctx: ExtensionCommandContext, pi: ExtensionAPI) => Promise<void>;
type ExtensionName = "a" | "b";

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

	async function setup(extensionFactories: ExtensionFactory[] = []) {
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

	it("deduplicates in-flight and fresh-context acquisition but never reuses a released handle (spec 5)", async () => {
		const h = await setup();
		const nativeAcquire = vi.spyOn(h.session, "fenceInputs");
		const first = await inExtension(h, "a", async (ctx) => {
			const [one, two] = await Promise.all([ctx.fenceInputs(), ctx.fenceInputs()]);
			expect(two).toBe(one);
			return one;
		});
		expect(await inExtension(h, "a", (ctx) => ctx.fenceInputs())).toBe(first);
		expect(nativeAcquire).toHaveBeenCalledTimes(1);
		expect(nativeAcquire).toHaveBeenLastCalledWith();
		first.release();
		first.release();
		expect(h.session.inputsFenced).toBe(false);
		const second = await inExtension(h, "a", (ctx) => ctx.fenceInputs());
		expect(second).not.toBe(first);
		first.release();
		expect(h.session.inputsFenced).toBe(true);
		second.release();
		expect(h.session.inputsFenced).toBe(false);
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

	it("pins cancellation of held receipt ingress before a BUSY drain refusal (spec 12)", async () => {
		const entered = gate();
		const held = gate();
		const h = await setup([
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text !== "held receipt ingress") return;
					entered.release();
					await held.promise;
				});
			},
		]);
		await h.session.followUp("ordinary queue survives");
		const ordinaryBytes = JSON.stringify(h.session.agent.getQueuedMessages());
		const generation = h.session.userMessageSessionGeneration;
		const ingress = inExtension(h, "b", (_ctx, pi) =>
			pi.submitUserMessage({
				registrationEpoch: "fence-test",
				requestId: "held",
				sessionGeneration: generation,
				text: "held receipt ingress",
				deliverAs: "followUp",
				expandPromptTemplates: false,
			}),
		);
		await entered.promise;
		expect(h.session.inputAdmissionCount).toBe(1);
		await inExtension(h, "a", async (ctx) => {
			await expect(ctx.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
			expect(ctx.getInputState().inputsFenced).toBe(false);
		});
		expect(await ingress).toEqual({ status: "rejected", reason: "session_changed", sessionGeneration: generation });
		expect(h.session.userMessageSessionGeneration).not.toBe(generation);
		expect(JSON.stringify(h.session.agent.getQueuedMessages())).toBe(ordinaryBytes);
		held.release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(h.session.inputAdmissionCount).toBe(0);
		expect(h.session.agent.getQueuedMessages().map(getMessageText)).toEqual(["ordinary queue survives"]);
		expect(getUserTexts(h)).toEqual([]);
	});

	it("pins cancellation of queued receipt ingress while preserving ordinary follow-ups on BUSY (spec 12)", async () => {
		const entered = gate();
		const held = gate();
		const h = await setup();
		h.setResponses([
			async () => {
				entered.release();
				await held.promise;
				return fauxAssistantMessage("active turn complete");
			},
			fauxAssistantMessage("ordinary follow-up delivered"),
		]);
		const run = h.session.prompt("active turn");
		await entered.promise;
		await h.session.followUp("ordinary follow-up survives");
		const ordinaryBytes = JSON.stringify(h.session.agent.getQueuedMessages());
		const generation = h.session.userMessageSessionGeneration;
		expect(
			await inExtension(h, "b", (_ctx, pi) =>
				pi.submitUserMessage({
					registrationEpoch: "fence-test",
					requestId: "queued",
					sessionGeneration: generation,
					text: "queued receipt ingress",
					deliverAs: "followUp",
					expandPromptTemplates: false,
				}),
			),
		).toEqual({ status: "queued", sessionGeneration: generation });
		expect(h.session.agent.getQueuedMessages().map(getMessageText)).toEqual([
			"ordinary follow-up survives",
			"queued receipt ingress",
		]);
		await inExtension(h, "a", async (ctx) => {
			await expect(ctx.fenceInputs()).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
			expect(ctx.getInputState()).toMatchObject({ inputsFenced: false, queued: 1, drained: false });
		});
		expect(h.session.userMessageSessionGeneration).not.toBe(generation);
		expect(JSON.stringify(h.session.agent.getQueuedMessages())).toBe(ordinaryBytes);
		held.release();
		await run;
		expect(getUserTexts(h)).toEqual(["active turn", "ordinary follow-up survives"]);
	});
});
