import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI, ExtensionFactory, InputEvent } from "../../src/core/extensions/index.ts";
import type { PromptTemplate } from "../../src/core/prompt-templates.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import type { SubmitUserMessageOptions, UserMessageReceipt } from "../../src/index.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import {
	createHarness,
	getAssistantTexts,
	getMessageText,
	getUserTexts,
	type Harness,
	type HarnessOptions,
} from "./harness.ts";

type Submission = SubmitUserMessageOptions;
type Receipt = UserMessageReceipt;

function duplicateReceipt(first: Receipt, sessionGeneration = first.sessionGeneration): Receipt {
	return {
		...first,
		sessionGeneration,
		duplicate: true,
		...(first.status !== "rejected" ? { admittedSessionGeneration: first.sessionGeneration } : {}),
	};
}

async function within<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Ingress did not finish at the admission boundary")), 2000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// smarty-dev#5533: drive the loader-created API through real AgentSession admission and faux model turns.
// Gates hold real extension handlers or faux responses; no ingress, queue, or generation implementation is mocked.
describe("extension submitUserMessage ingress (#5533)", () => {
	const harnesses: Harness[] = [];
	const releases: Array<() => void> = [];
	const providerCleanups: Array<() => void> = [];

	function gate() {
		let release!: () => void;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		releases.push(release);
		return { promise, release };
	}

	afterEach(async () => {
		while (releases.length) releases.pop()!();
		while (harnesses.length) {
			const harness = harnesses.pop()!;
			try {
				await within(harness.session.abort());
			} finally {
				harness.cleanup();
			}
		}
		while (providerCleanups.length) providerCleanups.pop()!();
	});

	async function setup(options: HarnessOptions = {}) {
		let api!: ExtensionAPI;
		let generation = "";
		const contexts: Array<{ event: string; generation: string }> = [];
		const inputs: InputEvent[] = [];
		const probe: ExtensionFactory = (pi) => {
			api = pi;
			pi.on("session_start", (_event, ctx) => {
				generation = ctx.userMessageSessionGeneration;
				contexts.push({ event: "session_start", generation });
			});
			pi.on("input", (event, ctx) => {
				inputs.push(event);
				contexts.push({ event: "input", generation: ctx.userMessageSessionGeneration });
			});
			pi.on("before_agent_start", (_event, ctx) => {
				contexts.push({ event: "before_agent_start", generation: ctx.userMessageSessionGeneration });
			});
			pi.registerCommand("ingress-generation", {
				handler: async (_args, ctx) => {
					generation = ctx.userMessageSessionGeneration;
				},
			});
			pi.registerCommand("ingress-new", {
				handler: async (_args, ctx) => {
					contexts.push({ event: "command", generation: ctx.userMessageSessionGeneration });
					await ctx.newSession();
				},
			});
			pi.registerCommand("ingress-switch", {
				handler: async (path, ctx) => {
					await ctx.switchSession(path);
				},
			});
			pi.registerCommand("ingress-reload", {
				handler: async (_args, ctx) => {
					await ctx.reload();
				},
			});
		};
		const factories = [probe, ...(options.extensionFactories ?? [])];
		const harness = await createHarness({
			...options,
			settings: { compaction: { enabled: false }, retry: { enabled: false }, ...options.settings },
			extensionFactories: factories,
		});
		harnesses.push(harness);
		// The harness's resource loader models resource discovery. A real reload must load fresh APIs,
		// not reuse the already-invalidated extension runtime returned at initial construction.
		let extensionsResult = harness.resourceLoader.getExtensions();
		const fauxApi = getApiProvider(harness.faux.api);
		if (!fauxApi) throw new Error("Harness faux API was not registered");
		const fauxSource = `ingress-reload:${harness.faux.api}`;
		providerCleanups.push(() => unregisterApiProviders(fauxSource));
		harness.resourceLoader.getExtensions = () => extensionsResult;
		harness.resourceLoader.reload = async () => {
			// AgentSession.reload resets compat APIs; preserve this same scripted faux instance,
			// just as a provider extension re-registers its implementation after real resource reload.
			registerApiProvider(fauxApi, fauxSource);
			extensionsResult = await createTestExtensionsResult(factories, options.cwd ?? harness.tempDir);
		};
		await harness.session.bindExtensions({});
		const request = (text: string, requestId = "request-1", registrationEpoch = "epoch-1"): Submission => ({
			registrationEpoch,
			requestId,
			sessionGeneration: generation,
			text,
			deliverAs: "followUp",
			expandPromptTemplates: false,
		});
		return { harness, api: () => api, generation: () => generation, request, contexts, inputs };
	}

	async function withRuntime(options: HarnessOptions = {}) {
		const initial = await setup({ ...options, persistSession: true });
		const probes = [initial];
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const next = await setup({ ...options, cwd, sessionManager, sessionStartEvent });
			probes.push(next);
			return {
				session: next.harness.session,
				extensionsResult: next.harness.resourceLoader.getExtensions(),
				services: {
					cwd,
					agentDir: initial.harness.tempDir,
					modelRuntime: next.harness.modelRuntime,
					settingsManager: next.harness.settingsManager,
					resourceLoader: next.harness.resourceLoader,
					diagnostics: [],
				},
				diagnostics: [],
			};
		};
		const h = initial.harness;
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
			createRuntime,
		);
		const bind = async () => {
			await runtime.session.bindExtensions({
				commandContextActions: {
					waitForIdle: () => runtime.session.waitForIdle(),
					newSession: (options) => runtime.newSession(options),
					switchSession: (path, options) => runtime.switchSession(path, options),
					fork: (entryId, options) => runtime.fork(entryId, options),
					navigateTree: (targetId, options) => runtime.session.navigateTree(targetId, options),
					reload: () => runtime.session.reload(),
				},
			});
		};
		runtime.setRebindSession(bind);
		await bind();
		return { runtime, initial, current: () => probes.at(-1)! };
	}

	// #5533 SOL-5533-04: the actual terminal caller must finish cleanup despite cancellation publication errors.
	it.each(["native", "session", "normal"] as const)(
		"aborts and joins busy runtime disposal, invalidates APIs and detaches after %s cancellation publication",
		async (layer) => {
			const started = gate();
			const aborted = gate();
			const releaseProvider = gate();
			const bashStarted = gate();
			let shutdowns = 0;
			const { runtime, initial } = await withRuntime({
				extensionFactories: [
					(pi) => {
						pi.on("session_shutdown", () => {
							shutdowns++;
						});
					},
				],
			});
			const { harness } = initial;
			const oldApi = initial.api();
			const sentinel = new Error(`${layer} terminal cancellation failure`);
			let armed = false;
			let throws = 0;
			let nativeSignal: AbortSignal | undefined;
			let providerReturned = false;
			let runFinished = false;
			let disposalFinished = false;
			const detachNative = harness.session.agent.observeLifecycle((event) => {
				if (layer === "native" && armed && event.type === "queue_update" && event.followUp === 0) {
					armed = false;
					throws++;
					throw sentinel;
				}
			});
			const detachSession = harness.session.subscribe((event) => {
				if (layer === "session" && armed && event.type === "queue_update" && event.followUp.length === 0) {
					armed = false;
					throws++;
					throw sentinel;
				}
			});
			harness.setResponses([
				async (_context, options) => {
					nativeSignal = options?.signal;
					if (!nativeSignal) throw new Error("Missing native run signal");
					nativeSignal.addEventListener("abort", aborted.release, { once: true });
					started.release();
					await aborted.promise;
					await releaseProvider.promise;
					providerReturned = true;
					return fauxAssistantMessage("ordinary stopped");
				},
			]);
			const run = runtime.session.prompt("ordinary").then(() => {
				runFinished = true;
			});
			const bash = harness.session.executeBash("printf 'runtime-bash-ready\\n'; exec sleep 30", (chunk) => {
				if (chunk.includes("runtime-bash-ready")) bashStarted.release();
			});
			try {
				await within(Promise.all([started.promise, bashStarted.promise]));
				expect(harness.session.isBashRunning).toBe(true);
				const submission = initial.request("cancelled terminal ingress", `terminal-${layer}`);
				const first = await within(oldApi.submitUserMessage(submission));
				expect(first).toEqual({ status: "queued", sessionGeneration: submission.sessionGeneration });
				expect(harness.session.getFollowUpMessages()).toEqual([submission.text]);
				expect(harness.session.agent.peekQueuedMessages().map(getMessageText)).toEqual([submission.text]);
				armed = true;
				// Observe the rejection immediately; an early exception must not become unhandled.
				const disposing = runtime.dispose().then(
					() => {
						disposalFinished = true;
						return { error: undefined };
					},
					(error: unknown) => {
						disposalFinished = true;
						return { error };
					},
				);
				await within(Promise.race([aborted.promise, disposing]));
				expect(nativeSignal?.aborted).toBe(true);
				expect(disposalFinished).toBe(false);
				expect(providerReturned).toBe(false);
				expect(harness.session.shutdownSignal.aborted).toBe(true);
				releaseProvider.release();
				const result = await within(disposing);
				expect(result.error).toBe(layer === "normal" ? undefined : sentinel);
				expect(throws).toBe(layer === "normal" ? 0 : 1);
				expect(providerReturned).toBe(true);
				expect(runFinished).toBe(true);
				expect(shutdowns).toBe(1);
				await within(harness.session.agent.waitForIdle());
				expect(harness.session.isStreaming).toBe(false);
				expect(harness.session.getFollowUpMessages()).toEqual([]);
				expect(harness.session.agent.hasQueuedMessages()).toBe(false);
				expect(await within(bash)).toMatchObject({ cancelled: true, exitCode: undefined });
				expect(harness.session.isBashRunning).toBe(false);
				expect(() => oldApi.getActiveTools()).toThrow(/stale/);
				const late = initial.request("after runtime disposal", `late-${layer}`);
				expect(await within(oldApi.submitUserMessage(late))).toEqual({
					status: "rejected",
					reason: "session_changed",
					sessionGeneration: late.sessionGeneration,
				});
				expect(getUserTexts(harness)).toEqual(["ordinary"]);
				expect(harness.faux.state.callCount).toBe(1);
				const eventCount = harness.events.length;
				const contextCount = initial.contexts.length;
				const entryCount = harness.sessionManager.getEntries().length;
				// A real subsequent native run must no longer publish through the disposed session.
				harness.setResponses([fauxAssistantMessage("detached native probe")]);
				await within(harness.session.agent.prompt("post-disposal native probe"));
				expect(harness.events).toHaveLength(eventCount);
				expect(initial.contexts).toHaveLength(contextCount);
				expect(harness.sessionManager.getEntries()).toHaveLength(entryCount);
			} finally {
				armed = false;
				detachNative();
				detachSession();
				releaseProvider.release();
				harness.session.abortBash();
				await within(harness.session.abort());
				await within(Promise.all([run, bash]));
			}
		},
	);

	// #5533 S5533-03: public echoing is request-bound, but rejected ledger outcomes must remain byte-bounded.
	it("does not retain huge incorrect generation strings in real ingress outcomes or admit fresh-generation duplicates", async () => {
		const { harness, api, request, inputs } = await setup();
		const requests: Submission[] = [];
		const receipts: Receipt[] = [];
		for (const [index, size] of [1, 2, 4].entries()) {
			const submission = {
				...request("x", `huge-generation-${index}`),
				sessionGeneration: `${index}:${"g".repeat(size * 1024 * 1024)}`,
			};
			requests.push(submission);
			const first = await within(api().submitUserMessage(submission));
			receipts.push(first);
			expect(first).toEqual({
				status: "rejected",
				reason: "session_changed",
				sessionGeneration: submission.sessionGeneration,
			});
			expect(await within(api().submitUserMessage(submission))).toEqual(duplicateReceipt(first));
			const retry = { ...submission, sessionGeneration: harness.session.userMessageSessionGeneration };
			expect(await within(api().submitUserMessage(retry))).toEqual(duplicateReceipt(first, retry.sessionGeneration));
			expect(await within(api().submitUserMessage({ ...retry, text: "changed text" }))).toEqual({
				status: "rejected",
				reason: "payload_mismatch",
				sessionGeneration: retry.sessionGeneration,
			});
		}
		expect(inputs).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
		// Supplement the real API path with read-only inspection, not a replacement ingress or core mock.
		const ingress = (
			harness.session as unknown as {
				_userMessageIngress: { reservations: Map<string, Record<string, unknown>>; reservedPayloadBytes: number };
			}
		)._userMessageIngress;
		expect(ingress.reservations.size).toBe(3);
		expect(ingress.reservedPayloadBytes).toBeLessThan(1024);
		for (const reservation of ingress.reservations.values()) {
			const stored: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(reservation)) stored[key] = await value;
			expect(stored.textFingerprint).toBeInstanceOf(Buffer);
			expect((stored.textFingerprint as Buffer).byteLength).toBe(32);
			expect(stored).not.toHaveProperty("text");
			expect(stored.receipt).toEqual({ status: "rejected", reason: "session_changed" });
			const encoded = JSON.stringify(stored);
			expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(1024);
			expect(encoded).not.toContain("sessionGeneration");
		}
		// Actual reload preserves the bounded historical refusal, not the caller's huge generation.
		await within(harness.session.reload());
		for (const [index, submission] of requests.entries()) {
			const retry = { ...submission, sessionGeneration: harness.session.userMessageSessionGeneration };
			expect(await within(api().submitUserMessage(retry))).toEqual(
				duplicateReceipt(receipts[index], retry.sessionGeneration),
			);
		}
		harness.setResponses([fauxAssistantMessage("fresh generation control")]);
		const fresh = {
			...request("fresh control", "huge-generation-control"),
			sessionGeneration: harness.session.userMessageSessionGeneration,
		};
		expect(await within(api().submitUserMessage(fresh))).toEqual({
			status: "accepted",
			sessionGeneration: fresh.sessionGeneration,
		});
		await within(harness.session.waitForIdle());
		expect(getUserTexts(harness)).toEqual(["fresh control"]);
		expect(inputs).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(1);
	});

	// #5533 SOL-5533-01 / S5533-01: a refused ID is not a new attempt after a real switch veto.
	it("retains the first refusal for an identical key submitted during a held switch that is vetoed", async () => {
		const entered = gate();
		const release = gate();
		let switchingGeneration = "";
		const { runtime, initial } = await withRuntime({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_switch", async (_event, ctx) => {
						switchingGeneration = ctx.userMessageSessionGeneration;
						entered.release();
						await release.promise;
						return { cancel: true };
					});
				},
			],
		});
		const switching = runtime.newSession();
		await within(entered.promise);
		const submission = {
			...initial.request("refused during veto", "veto-refused"),
			sessionGeneration: switchingGeneration,
		};
		const first = await within(initial.api().submitUserMessage(submission));
		expect(first).toEqual({ status: "rejected", reason: "session_changed", sessionGeneration: switchingGeneration });
		release.release();
		await within(switching);
		expect(runtime.session).toBe(initial.harness.session);
		expect(await within(initial.api().submitUserMessage(submission))).toEqual(duplicateReceipt(first));
		expect(await within(initial.api().submitUserMessage({ ...submission, text: "changed veto payload" }))).toEqual({
			status: "rejected",
			reason: "payload_mismatch",
			sessionGeneration: switchingGeneration,
		});
		expect(initial.inputs).toEqual([]);
		expect(getUserTexts(initial.harness)).toEqual([]);
		expect(initial.harness.faux.state.callCount).toBe(0);
		initial.harness.setResponses([fauxAssistantMessage("new ID after veto")]);
		const fresh = { ...submission, requestId: "fresh-veto-regression", text: "new ID after veto" };
		expect(await within(initial.api().submitUserMessage(fresh))).toEqual({
			status: "accepted",
			sessionGeneration: switchingGeneration,
		});
		await within(runtime.session.waitForIdle());
		expect(getUserTexts(initial.harness)).toEqual(["new ID after veto"]);
		expect(initial.harness.faux.state.callCount).toBe(1);
	});

	// #5533 SOL-5533-01 / S5533-01: both early stale and suspended refusals survive the real loader reload.
	it.each(["stale", "suspended"] as const)(
		"retains an early %s refusal across reload with request-bound retry generations",
		async (kind) => {
			const entered = gate();
			const release = gate();
			const { harness, api, request, inputs } = await setup({
				extensionFactories: [
					(pi) => {
						pi.on("session_shutdown", async () => {
							entered.release();
							await release.promise;
						});
					},
				],
			});
			let reload: Promise<void> | undefined;
			if (kind === "suspended") {
				reload = harness.session.reload();
				await within(entered.promise);
			}
			const submission = {
				...request(`early ${kind}`, `early-${kind}`),
				sessionGeneration: kind === "stale" ? "obsolete-generation" : harness.session.userMessageSessionGeneration,
			};
			const first = await within(api().submitUserMessage(submission));
			expect(first).toEqual({
				status: "rejected",
				reason: "session_changed",
				sessionGeneration: submission.sessionGeneration,
			});
			if (!reload) reload = harness.session.reload();
			release.release();
			await within(reload);
			const retry = { ...submission, sessionGeneration: harness.session.userMessageSessionGeneration };
			expect(await within(api().submitUserMessage(retry))).toEqual(duplicateReceipt(first, retry.sessionGeneration));
			expect(await within(api().submitUserMessage({ ...retry, text: "changed refused payload" }))).toEqual({
				status: "rejected",
				reason: "payload_mismatch",
				sessionGeneration: retry.sessionGeneration,
			});
			expect(inputs).toEqual([]);
			expect(getUserTexts(harness)).toEqual([]);
			expect(harness.faux.state.callCount).toBe(0);
			harness.setResponses([fauxAssistantMessage("fresh reload input")]);
			expect(
				(
					await within(
						api().submitUserMessage({
							...retry,
							requestId: "fresh-reload-regression",
							text: "fresh reload input",
						}),
					)
				).status,
			).toBe("accepted");
			await within(harness.session.waitForIdle());
			expect(getUserTexts(harness)).toEqual(["fresh reload input"]);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	// #5533 S5533-02: individually supported payloads refused by aggregate budget still fence their keys.
	it("retains aggregate-budget refusals and rejects changed text without another input hook", async () => {
		const { harness, api, request, inputs } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "handled" }));
				},
			],
		});
		const text = "x".repeat(65536);
		for (let index = 0; index < 127; index++) {
			expect((await within(api().submitUserMessage(request(text, `budget-${index}`)))).reason).toBe(
				"admission_refused",
			);
		}
		expect(inputs).toHaveLength(127);
		const submission = request(text, "aggregate-refused");
		const first = await within(api().submitUserMessage(submission));
		expect(first).toEqual({
			status: "rejected",
			reason: "admission_refused",
			sessionGeneration: submission.sessionGeneration,
		});
		expect(inputs).toHaveLength(127);
		expect(await within(api().submitUserMessage(submission))).toEqual(duplicateReceipt(first));
		expect(await within(api().submitUserMessage({ ...submission, text: "changed under aggregate limit" }))).toEqual({
			status: "rejected",
			reason: "payload_mismatch",
			sessionGeneration: submission.sessionGeneration,
		});
		expect(inputs).toHaveLength(127);
		// Positive control: budget refusal does not forbid a genuinely new small key.
		expect((await within(api().submitUserMessage(request("small new ID", "small-budget-control")))).reason).toBe(
			"admission_refused",
		);
		expect(inputs).toHaveLength(128);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	// #5533 S5533-02: oversized text is fingerprinted, not retained or admitted under a later smaller payload.
	it("retains an oversized-text refusal and rejects a smaller changed payload under its key", async () => {
		const { harness, api, request, inputs } = await setup();
		const submission = request("é".repeat(32769), "oversized-refused");
		const first = await within(api().submitUserMessage(submission));
		expect(first).toEqual({
			status: "rejected",
			reason: "admission_refused",
			sessionGeneration: submission.sessionGeneration,
		});
		expect(await within(api().submitUserMessage(submission))).toEqual(duplicateReceipt(first));
		expect(await within(api().submitUserMessage({ ...submission, text: "smaller changed payload" }))).toEqual({
			status: "rejected",
			reason: "payload_mismatch",
			sessionGeneration: submission.sessionGeneration,
		});
		expect(inputs).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	// #5533 exact-text contract: UTF-8 encoding maps distinct lone surrogates to the same replacement bytes.
	it("distinguishes lone-surrogate text under the same refused key without UTF-8 normalization", async () => {
		const { harness, api, request, inputs } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "handled" }));
				},
			],
		});
		const submission = request("\ud800", "surrogate-key");
		expect(Buffer.from(submission.text, "utf8")).toEqual(Buffer.from("\ud801", "utf8"));
		const first = await within(api().submitUserMessage(submission));
		expect(first.reason).toBe("admission_refused");
		expect(await within(api().submitUserMessage(submission))).toEqual(duplicateReceipt(first));
		expect(await within(api().submitUserMessage({ ...submission, text: "\ud801" }))).toEqual({
			status: "rejected",
			reason: "payload_mismatch",
			sessionGeneration: submission.sessionGeneration,
		});
		expect(inputs).toHaveLength(1);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	// #5533 SOL-5533-02: this is Agent.observeLifecycle, not the later AgentSession queue_update layer.
	it("returns a truthful busy receipt when the native insertion observer throws once", async () => {
		const started = gate();
		const release = gate();
		const { harness, api, request } = await setup();
		let throws = 0;
		const detach = harness.session.agent.observeLifecycle((event) => {
			if (event.type === "queue_update" && event.followUp > 0 && throws === 0) {
				throws++;
				throw new Error("native insertion observer failure");
			}
		});
		harness.setResponses([
			async () => {
				started.release();
				await release.promise;
				return fauxAssistantMessage("ordinary done");
			},
			fauxAssistantMessage("native follow-up done"),
		]);
		const run = harness.session.prompt("ordinary");
		await within(started.promise);
		const submission = request("native throw follow-up", "native-throw");
		const receipt = await within(api().submitUserMessage(submission));
		expect(throws).toBe(1);
		expect(receipt.sessionGeneration).toBe(submission.sessionGeneration);
		if (receipt.status === "rejected") {
			expect(harness.session.getFollowUpMessages()).toEqual([]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		} else {
			expect(receipt.status).toBe("queued");
			expect(harness.session.getFollowUpMessages()).toEqual([submission.text]);
			expect(harness.session.agent.peekQueuedMessages().map(getMessageText)).toEqual([submission.text]);
		}
		expect(await within(api().submitUserMessage(submission))).toEqual(duplicateReceipt(receipt));
		release.release();
		await within(run);
		detach();
		expect(getUserTexts(harness)).toEqual(receipt.status === "queued" ? ["ordinary", submission.text] : ["ordinary"]);
		expect(harness.faux.state.callCount).toBe(receipt.status === "queued" ? 2 : 1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	// #5533 SOL-5533-02: native run_start precedes agent_start subscribers and extension handlers.
	it("never rejects then executes when the native run_start observer synchronously reloads", async () => {
		const { harness, api, request } = await setup();
		let reloading: Promise<void> | undefined;
		let starts = 0;
		const detach = harness.session.agent.observeLifecycle((event) => {
			if (event.type === "run_start" && !reloading) {
				starts++;
				reloading = harness.session.reload();
			}
		});
		harness.setResponses([fauxAssistantMessage("native dispatch done")]);
		const submission = request("native dispatch", "native-dispatch");
		const receipt = await within(api().submitUserMessage(submission));
		expect(starts).toBe(1);
		expect(reloading).toBeDefined();
		await within(reloading!);
		await within(harness.session.waitForIdle());
		expect(receipt.sessionGeneration).toBe(submission.sessionGeneration);
		if (receipt.status === "rejected") {
			expect(getUserTexts(harness)).toEqual([]);
			expect(harness.faux.state.callCount).toBe(0);
		} else {
			expect(receipt.status).toBe("accepted");
			expect(getUserTexts(harness)).toEqual([submission.text]);
			expect(harness.faux.state.callCount).toBe(1);
		}
		const retry = { ...submission, sessionGeneration: harness.session.userMessageSessionGeneration };
		expect(await within(api().submitUserMessage(retry))).toEqual(duplicateReceipt(receipt, retry.sessionGeneration));
		expect(harness.faux.state.callCount).toBe(receipt.status === "accepted" ? 1 : 0);
		detach();
	});

	// #5533 SOL-5533-03: transition entry publication must not leak suspension after an observer exception.
	it("recovers after an AgentSession cancellation queue_update observer throws during reload", async () => {
		const started = gate();
		const release = gate();
		const { harness, api, request } = await setup();
		harness.setResponses([
			async () => {
				started.release();
				await release.promise;
				return fauxAssistantMessage("ordinary done");
			},
			fauxAssistantMessage("fresh recovery done"),
		]);
		const run = harness.session.prompt("ordinary");
		await within(started.promise);
		const submission = request("cancelled queue", "cancelled-queue");
		const first = await within(api().submitUserMessage(submission));
		expect(first.status).toBe("queued");
		let throws = 0;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "queue_update" && event.followUp.length === 0) {
				unsubscribe();
				throws++;
				throw new Error("cancellation observer failure");
			}
		});
		const oldApi = api();
		await expect(within(harness.session.reload())).rejects.toThrow("cancellation observer failure");
		expect(throws).toBe(1);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(
			await within(oldApi.submitUserMessage(request("failed runtime", "failed-cancellation-runtime"))),
		).toMatchObject({ status: "rejected", reason: "session_changed" });
		release.release();
		await within(run);
		await within(harness.session.reload());
		expect(api()).not.toBe(oldApi);
		// This minimal host has no reload bindings: read the live context through its actual command.
		await harness.session.prompt("/ingress-generation");
		const retry = { ...submission, sessionGeneration: harness.session.userMessageSessionGeneration };
		expect(await within(api().submitUserMessage(retry))).toEqual(duplicateReceipt(first, retry.sessionGeneration));
		const fresh = request("fresh recovery", "fresh-cancellation-recovery");
		expect(await within(api().submitUserMessage(fresh))).toEqual({
			status: "accepted",
			sessionGeneration: fresh.sessionGeneration,
		});
		await within(harness.session.waitForIdle());
		expect(getUserTexts(harness)).toEqual(["ordinary", "fresh recovery"]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	// #5533 SOL-5533-02 positive control: fixing ingress must not suppress ordinary native observer errors.
	it("preserves ordinary native queue observer failure and its already inserted follow-up", async () => {
		const started = gate();
		const release = gate();
		const { harness } = await setup();
		let throws = 0;
		const detach = harness.session.agent.observeLifecycle((event) => {
			if (event.type === "queue_update" && event.followUp > 0 && throws === 0) {
				throws++;
				throw new Error("ordinary native queue failure");
			}
		});
		harness.setResponses([
			async () => {
				started.release();
				await release.promise;
				return fauxAssistantMessage("ordinary done");
			},
			fauxAssistantMessage("ordinary follow-up done"),
		]);
		const run = harness.session.prompt("ordinary");
		await within(started.promise);
		await expect(within(harness.session.followUp("ordinary retained"))).rejects.toThrow(
			"ordinary native queue failure",
		);
		expect(throws).toBe(1);
		expect(harness.session.agent.peekQueuedMessages().map(getMessageText)).toEqual(["ordinary retained"]);
		release.release();
		await within(run);
		detach();
		expect(getUserTexts(harness)).toEqual(["ordinary", "ordinary retained"]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	// #5533 SOL-5533-02 positive control: ordinary run_start errors still produce a native failed turn.
	it("preserves ordinary native run_start failure and permits a later successful ordinary turn", async () => {
		const { harness } = await setup();
		let throws = 0;
		const detach = harness.session.agent.observeLifecycle((event) => {
			if (event.type === "run_start" && throws === 0) {
				throws++;
				throw new Error("ordinary native run failure");
			}
		});
		await within(harness.session.prompt("not dispatched"));
		expect(throws).toBe(1);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toMatchObject([
			{ stopReason: "error", errorMessage: "ordinary native run failure" },
		]);
		harness.setResponses([fauxAssistantMessage("ordinary retry done")]);
		await within(harness.session.prompt("ordinary retry"));
		detach();
		expect(getUserTexts(harness)).toEqual(["ordinary retry"]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("returns accepted before an idle turn's model response finishes and exposes the same generation to hooks", async () => {
		const started = gate();
		const release = gate();
		const { harness, api, request, generation, contexts, inputs } = await setup();
		harness.setResponses([
			async (context) => {
				expect(context.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
					"first prompt",
				]);
				started.release();
				await release.promise;
				return fauxAssistantMessage("received");
			},
		]);
		expect(generation()).toEqual(expect.any(String));
		expect(generation().length).toBeGreaterThan(0);
		const receipt = await within(api().submitUserMessage(request("first prompt")));
		expect(receipt).toEqual({ status: "accepted", sessionGeneration: generation() });
		await within(started.promise);
		expect(getUserTexts(harness)).toEqual(["first prompt"]);
		expect(getAssistantTexts(harness)).toEqual([]);
		expect(harness.session.isStreaming).toBe(true);
		expect(inputs).toMatchObject([{ text: "first prompt", source: "extension" }]);
		expect(contexts).toEqual([
			{ event: "session_start", generation: generation() },
			{ event: "input", generation: generation() },
			{ event: "before_agent_start", generation: generation() },
		]);
		release.release();
		await within(harness.session.waitForIdle());
		expect(getAssistantTexts(harness)).toEqual(["received"]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("queues a busy follow-up without interrupting the running response and admits it exactly once", async () => {
		const started = gate();
		const release = gate();
		const { harness, api, request, generation, inputs } = await setup();
		const providerInputs: string[][] = [];
		harness.setResponses([
			async (context) => {
				providerInputs.push(context.messages.filter((message) => message.role === "user").map(getMessageText));
				started.release();
				await release.promise;
				return fauxAssistantMessage("original completed");
			},
			(context) => {
				providerInputs.push(context.messages.filter((message) => message.role === "user").map(getMessageText));
				return fauxAssistantMessage("follow-up completed");
			},
		]);
		const run = harness.session.prompt("original");
		await within(started.promise);
		const submission = request("busy follow-up");
		const first = await within(api().submitUserMessage(submission));
		expect(first).toEqual({ status: "queued", sessionGeneration: generation() });
		expect(await within(api().submitUserMessage(submission))).toEqual(duplicateReceipt(first));
		expect(harness.session.getFollowUpMessages()).toEqual(["busy follow-up"]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["original"]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(inputs).toMatchObject([
			{ text: "original", source: "interactive" },
			{ text: "busy follow-up", source: "extension", streamingBehavior: "followUp" },
		]);
		release.release();
		await within(run);
		expect(getUserTexts(harness)).toEqual(["original", "busy follow-up"]);
		expect(getAssistantTexts(harness)).toEqual(["original completed", "follow-up completed"]);
		expect(providerInputs).toEqual([["original"], ["original", "busy follow-up"]]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("shares an in-flight reservation, returns the original receipt on retry, and refuses changed text", async () => {
		const entered = gate();
		const release = gate();
		const { harness, api, request, generation, inputs } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						entered.release();
						await release.promise;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("once")]);
		const submission = request("identical text");
		const first = api().submitUserMessage(submission);
		await within(entered.promise);
		const duplicate = api().submitUserMessage({ ...submission });
		expect(await within(api().submitUserMessage({ ...submission, text: "changed text" }))).toEqual({
			status: "rejected",
			sessionGeneration: generation(),
			reason: "payload_mismatch",
		});
		expect(inputs).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(0);
		release.release();
		const receipt = await within(first);
		expect(receipt.status).toBe("accepted");
		expect(await within(duplicate)).toEqual(duplicateReceipt(receipt));
		await within(harness.session.waitForIdle());
		expect(await within(api().submitUserMessage(submission))).toEqual(duplicateReceipt(receipt));
		expect(getUserTexts(harness)).toEqual(["identical text"]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it.each(["input", "before_agent_start"] as const)("queues behind a prompt held in %s preflight", async (hook) => {
		const entered = gate();
		const release = gate();
		const { harness, api, request, generation } = await setup({
			extensionFactories: [
				(pi) => {
					if (hook === "input") {
						pi.on("input", async (event) => {
							if (event.text !== "original") return;
							entered.release();
							await release.promise;
						});
					} else {
						pi.on("before_agent_start", async (event) => {
							if (event.prompt !== "original") return;
							entered.release();
							await release.promise;
						});
					}
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("original done"), fauxAssistantMessage("queued done")]);
		const run = harness.session.prompt("original");
		await within(entered.promise);
		expect(await within(api().submitUserMessage(request("preflight follow-up")))).toEqual({
			status: "queued",
			sessionGeneration: generation(),
		});
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.getFollowUpMessages()).toEqual(["preflight follow-up"]);
		release.release();
		await within(run);
		expect(getUserTexts(harness)).toEqual(["original", "preflight follow-up"]);
		expect(getAssistantTexts(harness)).toEqual(["original done", "queued done"]);
	});

	it("queues behind held settlement without starting a competing turn", async () => {
		const entered = gate();
		const release = gate();
		let settlements = 0;
		const { harness, api, request, generation } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						if (++settlements !== 1) return;
						entered.release();
						await release.promise;
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("original done"), fauxAssistantMessage("settlement follow-up done")]);
		const run = harness.session.prompt("original");
		await within(entered.promise);
		expect(harness.session.isSettling).toBe(true);
		expect(await within(api().submitUserMessage(request("settlement follow-up")))).toEqual({
			status: "queued",
			sessionGeneration: generation(),
		});
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).toEqual(["original"]);
		release.release();
		await within(run);
		await within(harness.session.waitForIdle());
		expect(getUserTexts(harness)).toEqual(["original", "settlement follow-up"]);
		expect(getAssistantTexts(harness)).toEqual(["original done", "settlement follow-up done"]);
	});

	it.each([false, true])("rejects input consumed by a real hook (busy: %s), including retries", async (busy) => {
		const started = gate();
		const release = gate();
		const { harness, api, request, generation, inputs } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => (event.text === "consumed" ? { action: "handled" } : undefined));
				},
			],
		});
		harness.setResponses([
			async () => {
				started.release();
				await release.promise;
				return fauxAssistantMessage("original done");
			},
		]);
		const run = busy ? harness.session.prompt("original") : Promise.resolve();
		if (busy) await within(started.promise);
		const submission = request("consumed");
		const receipt: Receipt = { status: "rejected", sessionGeneration: generation(), reason: "admission_refused" };
		expect(await within(api().submitUserMessage(submission))).toEqual(receipt);
		expect(await within(api().submitUserMessage(submission))).toEqual({ ...receipt, duplicate: true });
		expect(inputs.filter((event) => event.text === "consumed")).toHaveLength(1);
		expect(harness.session.pendingMessageCount).toBe(0);
		release.release();
		await within(run);
		expect(getUserTexts(harness)).toEqual(busy ? ["original"] : []);
		expect(harness.faux.state.callCount).toBe(busy ? 1 : 0);
	});

	it("rejects missing authentication at admission without falsely acknowledging a turn", async () => {
		const { harness, api, request, generation } = await setup({ withConfiguredAuth: false });
		expect(await within(api().submitUserMessage(request("unauthenticated")))).toEqual({
			status: "rejected",
			sessionGeneration: generation(),
			reason: "admission_refused",
		});
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("refuses admission during real manual compaction, without entering its queues", async () => {
		const entered = gate();
		const release = gate();
		const { harness, api, request } = await setup({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						entered.release();
						await release.promise;
						return {
							compaction: {
								summary: "manual summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const compact = harness.session.compact();
		await within(entered.promise);
		expect(await within(api().submitUserMessage(request("refused during compaction")))).toMatchObject({
			status: "rejected",
			reason: "admission_refused",
		});
		expect(harness.session.pendingMessageCount).toBe(0);
		release.release();
		await within(compact);
		expect(getUserTexts(harness)).not.toContain("refused during compaction");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("keeps slash commands, skills, templates, whitespace and shell-like text literal", async () => {
		const { harness, api, request } = await setup();
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "EXPANDED $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		harness.resourceLoader.getPrompts = () => ({ prompts: [template], diagnostics: [] });
		const skillPath = join(harness.tempDir, "literal-skill.md");
		writeFileSync(skillPath, "# Literal Skill\n\nEXPANDED SKILL BODY");
		harness.resourceLoader.getSkills = () => ({
			skills: [
				{
					name: "literal",
					description: "Literal skill",
					filePath: skillPath,
					baseDir: harness.tempDir,
					disableModelInvocation: false,
					sourceInfo: createSyntheticSourceInfo(skillPath, {
						source: "local",
						scope: "temporary",
						origin: "top-level",
					}),
				},
			],
			diagnostics: [],
		});
		const texts = [
			"/review src/index.ts",
			"/ingress-new",
			"/skill:literal args",
			"  echo $(touch /tmp/never)\n; 'quoted'\t  ",
		];
		const providerTexts: string[] = [];
		for (const [index, text] of texts.entries()) {
			harness.setResponses([
				(context) => {
					providerTexts.push(getMessageText(context.messages.filter((message) => message.role === "user").at(-1)));
					return fauxAssistantMessage("literal");
				},
			]);
			expect((await within(api().submitUserMessage(request(text, `literal-${index}`)))).status).toBe("accepted");
			await within(harness.session.waitForIdle());
		}
		expect(getUserTexts(harness)).toEqual(texts);
		expect(providerTexts).toEqual(texts);
		expect(harness.faux.state.callCount).toBe(texts.length);
	});

	it("uses registrationEpoch as part of the key, not just requestId", async () => {
		const { harness, api, request } = await setup();
		for (const epoch of ["epoch-1", "epoch-2"]) {
			harness.setResponses([fauxAssistantMessage(epoch)]);
			expect((await within(api().submitUserMessage(request("same request ID", "same-id", epoch)))).status).toBe(
				"accepted",
			);
			await within(harness.session.waitForIdle());
		}
		expect(getUserTexts(harness)).toEqual(["same request ID", "same request ID"]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("preserves existing input error isolation and acknowledges the actually admitted message", async () => {
		const errors: string[] = [];
		const { harness, api, request } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => {
						throw new Error("isolated input hook failure");
					});
				},
			],
		});
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		harness.setResponses([fauxAssistantMessage("admitted despite isolated handler error")]);
		expect((await within(api().submitUserMessage(request("real admitted input")))).status).toBe("accepted");
		await within(harness.session.waitForIdle());
		expect(errors).toEqual(["isolated input hook failure"]);
		expect(getUserTexts(harness)).toEqual(["real admitted input"]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("refuses terminal shutdown without invoking input hooks or starting a turn", async () => {
		const { harness, api, request, inputs } = await setup();
		harness.session.cancelForShutdown();
		expect(await within(api().submitUserMessage(request("too late")))).toMatchObject({
			status: "rejected",
			reason: "shutting_down",
		});
		expect(inputs).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it.each([{ deliverAs: "steer" }, { expandPromptTemplates: true }, { requestId: "" }, { registrationEpoch: "" }])(
		"refuses unsupported v1 options $deliverAs $expandPromptTemplates $requestId $registrationEpoch",
		async (unsupported) => {
			const { harness, api, request, inputs } = await setup();
			const submission = { ...request("unsupported"), ...unsupported } as unknown as Submission;
			expect(await within(api().submitUserMessage(submission))).toMatchObject({
				status: "rejected",
				reason: "unsupported",
			});
			expect(inputs).toEqual([]);
			expect(harness.faux.state.callCount).toBe(0);
		},
	);

	it.each([null, undefined, false, 42, "untyped text", {}, []])(
		"returns an unsupported receipt for malformed untyped payload %j, not a thrown error",
		async (malformed) => {
			const { harness, api, inputs } = await setup();
			await expect(api().submitUserMessage(malformed as unknown as Submission)).resolves.toMatchObject({
				status: "rejected",
				reason: "unsupported",
			});
			expect(inputs).toEqual([]);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.faux.state.callCount).toBe(0);
		},
	);

	it("refuses a stale generation before calling input handlers", async () => {
		const { harness, api, request, inputs } = await setup();
		expect(
			await within(api().submitUserMessage({ ...request("obsolete"), sessionGeneration: "obsolete-generation" })),
		).toEqual({
			status: "rejected",
			sessionGeneration: "obsolete-generation",
			reason: "session_changed",
		});
		expect(inputs).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it.each(
		(["new", "switch", "reload"] as const).flatMap((transition) =>
			(["input", "before_agent_start"] as const).map((hook) => ({ transition, hook })),
		),
	)(
		"refuses $hook admission held across real $transition and allows fresh-generation input",
		async ({ transition, hook }) => {
			const entered = gate();
			const release = gate();
			const { runtime, initial, current } = await withRuntime({
				extensionFactories: [
					(pi) => {
						if (hook === "input") {
							pi.on("input", async (event) => {
								if (event.text !== "delayed admission") return;
								entered.release();
								await release.promise;
							});
						} else {
							pi.on("before_agent_start", async (event) => {
								if (event.prompt !== "delayed admission") return;
								entered.release();
								await release.promise;
							});
						}
					},
				],
			});
			initial.harness.setResponses([fauxAssistantMessage("baseline")]);
			await initial.harness.session.prompt("baseline");
			const firstFile = runtime.session.sessionFile!;
			if (transition === "switch") await runtime.session.prompt("/ingress-new");
			const outgoing = current();
			const oldGeneration = outgoing.generation();
			const submission = outgoing.request("delayed admission");
			const pending = outgoing.api().submitUserMessage(submission);
			await within(entered.promise);
			const command = transition === "switch" ? `/ingress-switch ${firstFile}` : `/ingress-${transition}`;
			await within(runtime.session.prompt(command));
			const incoming = current();
			expect(incoming.generation()).not.toBe(oldGeneration);
			release.release();
			const refused = await within(pending);
			expect(refused.status).toBe("rejected");
			expect(refused.reason).toBe("session_changed");
			expect(refused.sessionGeneration).toBe(submission.sessionGeneration);
			const retry = await within(incoming.api().submitUserMessage(submission));
			expect(retry).toMatchObject({
				status: "rejected",
				reason: "session_changed",
				sessionGeneration: submission.sessionGeneration,
			});
			if (transition === "reload") {
				expect(retry).toEqual({ ...refused, duplicate: true });
				const changedPayload = {
					...submission,
					sessionGeneration: incoming.generation(),
					text: "changed after cancellation",
				};
				expect(await within(incoming.api().submitUserMessage(changedPayload))).toMatchObject({
					status: "rejected",
					reason: "payload_mismatch",
				});
			}
			expect(getUserTexts(outgoing.harness)).not.toContain("delayed admission");
			expect(getUserTexts(incoming.harness)).not.toContain("delayed admission");
			incoming.harness.setResponses([fauxAssistantMessage("fresh accepted")]);
			expect(
				(await within(incoming.api().submitUserMessage(incoming.request("fresh input", "fresh-id")))).status,
			).toBe("accepted");
			await within(runtime.session.waitForIdle());
			expect(getUserTexts(incoming.harness)).toContain("fresh input");
			expect(getAssistantTexts(incoming.harness).at(-1)).toBe("fresh accepted");
		},
	);

	// smarty-dev#5533 Astra R1: pre-teardown errors must not disable the still-live outgoing runtime.
	it.each(["import", "switch"] as const)(
		"keeps ingress usable after a %s fails before teardown",
		async (operation) => {
			let shutdowns = 0;
			const { runtime, initial } = await withRuntime({
				extensionFactories: [
					(pi) => {
						pi.on("session_shutdown", () => {
							shutdowns++;
						});
					},
				],
			});
			const { harness } = initial;
			const oldRequest = initial.request("stale after failed replacement", "stale-replacement");
			const path = join(harness.tempDir, "missing.jsonl");
			if (operation === "import") {
				await expect(within(runtime.importFromJsonl(path))).rejects.toThrow("File not found");
			} else {
				await expect(
					within(runtime.switchSession(path, { cwdOverride: join(harness.tempDir, "missing-cwd") })),
				).rejects.toThrow("Stored session working directory does not exist");
			}
			expect(runtime.session).toBe(harness.session);
			expect(shutdowns).toBe(0);
			expect(await within(initial.api().submitUserMessage(oldRequest))).toMatchObject({
				status: "rejected",
				reason: "session_changed",
			});
			await runtime.session.prompt("/ingress-generation");
			expect(initial.generation()).not.toBe(oldRequest.sessionGeneration);
			harness.setResponses([fauxAssistantMessage("still-live runtime reply")]);
			const fresh = initial.request("after failed replacement", "fresh-replacement");
			expect(await within(initial.api().submitUserMessage(fresh))).toEqual({
				status: "accepted",
				sessionGeneration: fresh.sessionGeneration,
			});
			await within(runtime.session.waitForIdle());
			expect(getUserTexts(harness)).toEqual(["after failed replacement"]);
			expect(getAssistantTexts(harness)).toEqual(["still-live runtime reply"]);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	// smarty-dev#5533 Astra R1 counterexample: teardown failure must still close ingress before disposal.
	it("keeps ingress closed after replacement teardown starts and fails", async () => {
		const { runtime, initial } = await withRuntime();
		const sentinel = new Error("outgoing teardown failure");
		runtime.setBeforeSessionInvalidate(() => {
			throw sentinel;
		});
		await expect(within(runtime.newSession())).rejects.toBe(sentinel);
		expect(runtime.session).toBe(initial.harness.session);
		// The loader API is still bound: refusal must come from ingress, not API invalidation or disposal.
		expect(() => initial.api().getActiveTools()).not.toThrow();
		await runtime.session.prompt("/ingress-generation");
		const fresh = initial.request("after teardown failure", "teardown-failure");
		expect(await within(initial.api().submitUserMessage(fresh))).toEqual({
			status: "rejected",
			reason: "session_changed",
			sessionGeneration: fresh.sessionGeneration,
		});
		expect(initial.inputs).toEqual([]);
		expect(getUserTexts(initial.harness)).toEqual([]);
		expect(initial.harness.faux.state.callCount).toBe(0);
	});

	// smarty-dev#5533 R1: a failed resource reload must not leak its suspension into a successful retry.
	it("recovers ingress after a failed reload without replaying delayed admissions or queued reservations", async () => {
		const entered = gate();
		const release = gate();
		const { runtime, initial } = await withRuntime({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.prompt !== "delayed before failure") return;
						entered.release();
						await release.promise;
					});
				},
			],
		});
		const { harness } = initial;
		harness.setResponses([fauxAssistantMessage("baseline"), fauxAssistantMessage("fresh after recovery")]);
		await runtime.session.prompt("baseline");
		const oldApi = initial.api();
		const delayedRequest = initial.request("delayed before failure", "delayed-failure");
		const delayed = oldApi.submitUserMessage(delayedRequest);
		await within(entered.promise);
		const duplicate = oldApi.submitUserMessage({ ...delayedRequest });
		const queuedRequest = initial.request("queued before failure", "queued-failure");
		const queuedReceipt = await within(oldApi.submitUserMessage(queuedRequest));
		expect(queuedReceipt.status).toBe("queued");
		const reloadResources = harness.resourceLoader.reload;
		let attempts = 0;
		harness.resourceLoader.reload = async () => {
			if (++attempts === 1) throw new Error("one resource reload failure");
			await reloadResources();
		};

		await expect(within(runtime.session.reload())).rejects.toThrow("one resource reload failure");
		const cancelled = await within(delayed);
		expect(cancelled).toEqual({
			status: "rejected",
			reason: "session_changed",
			sessionGeneration: delayedRequest.sessionGeneration,
		});
		expect(await within(duplicate)).toEqual({ ...cancelled, duplicate: true });
		expect(harness.session.isPromptPending).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		const failedRequest = {
			...initial.request("failed runtime input", "failed-runtime"),
			sessionGeneration: harness.session.userMessageSessionGeneration,
		};
		expect(await within(oldApi.submitUserMessage(failedRequest))).toMatchObject({
			status: "rejected",
			reason: "session_changed",
		});
		expect(await within(harness.session.submitUserMessage(failedRequest))).toMatchObject({ status: "rejected" });
		expect(() => oldApi.getActiveTools()).toThrow(/stale/);

		await within(runtime.session.reload());
		expect(attempts).toBe(2);
		expect(initial.api()).not.toBe(oldApi);
		expect(initial.generation()).not.toBe(delayedRequest.sessionGeneration);
		expect(initial.contexts.filter(({ event }) => event === "session_start").at(-1)?.generation).toBe(
			harness.session.userMessageSessionGeneration,
		);
		release.release();
		expect(await within(initial.api().submitUserMessage(delayedRequest))).toEqual({ ...cancelled, duplicate: true });
		expect(
			await within(initial.api().submitUserMessage({ ...queuedRequest, sessionGeneration: initial.generation() })),
		).toEqual(duplicateReceipt(queuedReceipt, initial.generation()));
		expect(
			await within(initial.api().submitUserMessage({ ...delayedRequest, text: "changed cancelled payload" })),
		).toMatchObject({ status: "rejected", reason: "payload_mismatch" });
		expect(await within(oldApi.submitUserMessage(initial.request("obsolete API", "obsolete-api")))).toMatchObject({
			status: "rejected",
			reason: "session_changed",
		});
		const freshRequest = initial.request("fresh recovery input", "fresh-recovery");
		const receipt = await within(initial.api().submitUserMessage(freshRequest));
		expect(receipt).toEqual({ status: "accepted", sessionGeneration: initial.generation() });
		expect(await within(initial.api().submitUserMessage(freshRequest))).toEqual(duplicateReceipt(receipt));
		await within(runtime.session.waitForIdle());
		expect(getUserTexts(harness)).toEqual(["baseline", "fresh recovery input"]);
		expect(getAssistantTexts(harness)).toEqual(["baseline", "fresh after recovery"]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	// smarty-dev#5533 R1: failure after core binding must invalidate the partial runtime, not just balance depth.
	it.each(["beforeSessionStart", "resources"] as const)(
		"closes a partially bound runtime after %s failure and recovers on retry",
		async (stage) => {
			const { runtime, initial } = await withRuntime({
				extensionFactories: [
					(pi) => {
						pi.on("resources_discover", (event) =>
							event.reason === "reload" ? { promptPaths: ["/virtual/reload-prompt.md"] } : undefined,
						);
					},
				],
			});
			const { harness } = initial;
			const oldApi = initial.api();
			let failResources = stage === "resources";
			harness.resourceLoader.extendResources = () => {
				if (!failResources) return;
				failResources = false;
				throw new Error("resource extension failure");
			};
			await expect(
				within(
					runtime.session.reload({
						beforeSessionStart: () => {
							if (stage === "beforeSessionStart") throw new Error("before session start failure");
						},
					}),
				),
			).rejects.toThrow(stage === "resources" ? "resource extension failure" : "before session start failure");
			const partialApi = initial.api();
			expect(partialApi).not.toBe(oldApi);
			const failedRequest = {
				...initial.request("partial runtime input"),
				sessionGeneration: harness.session.userMessageSessionGeneration,
			};
			expect(await within(partialApi.submitUserMessage(failedRequest))).toMatchObject({
				status: "rejected",
				reason: "session_changed",
			});
			expect(await within(harness.session.submitUserMessage(failedRequest))).toMatchObject({
				status: "rejected",
				reason: "session_changed",
			});
			expect(() => partialApi.getActiveTools()).toThrow(/stale/);
			await within(runtime.session.reload());
			expect(initial.api()).not.toBe(partialApi);
			harness.setResponses([fauxAssistantMessage("fresh startup recovery")]);
			expect(
				(
					await within(
						initial.api().submitUserMessage(initial.request("after startup recovery", "fresh-startup-recovery")),
					)
				).status,
			).toBe("accepted");
			await within(runtime.session.waitForIdle());
			expect(getUserTexts(harness)).toEqual(["after startup recovery"]);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	// smarty-dev#5533 R1: balancing one reload cannot release another reload's live suspension.
	it.each(["failed", "successful"] as const)(
		"keeps ingress fenced while a concurrent reload is held after another %s reload",
		async (outcome) => {
			const entered = gate();
			const release = gate();
			const { runtime, initial } = await withRuntime();
			const { harness } = initial;
			const reloadResources = harness.resourceLoader.reload;
			let attempts = 0;
			harness.resourceLoader.reload = async () => {
				if (++attempts === 1) {
					entered.release();
					await release.promise;
				} else if (attempts === 2 && outcome === "failed") {
					throw new Error("concurrent reload failure");
				}
				await reloadResources();
			};
			const heldReload = runtime.session.reload();
			await within(entered.promise);
			let intermediateApi = initial.api();
			if (outcome === "failed") {
				await expect(within(runtime.session.reload())).rejects.toThrow("concurrent reload failure");
			} else {
				await within(runtime.session.reload());
				intermediateApi = initial.api();
			}
			expect(
				await within(
					harness.session.submitUserMessage({
						...initial.request("too early", "held-reload"),
						sessionGeneration: harness.session.userMessageSessionGeneration,
					}),
				),
			).toMatchObject({ status: "rejected", reason: "session_changed" });
			expect(harness.faux.state.callCount).toBe(0);
			release.release();
			await within(heldReload);
			harness.setResponses([fauxAssistantMessage("only after both settle")]);
			expect((await within(initial.api().submitUserMessage(initial.request("after held reload")))).status).toBe(
				"accepted",
			);
			await within(runtime.session.waitForIdle());
			expect(getUserTexts(harness)).toEqual(["after held reload"]);
			expect(harness.faux.state.callCount).toBe(1);
			expect(
				await within(
					intermediateApi.submitUserMessage(initial.request("superseded runtime", "superseded-runtime")),
				),
			).toMatchObject({ status: "rejected", reason: "session_changed" });
		},
	);

	// smarty-dev#5533 R1: late resource-loader completion cannot undo terminal closure.
	it.each(["session", "runtime"] as const)("does not reopen after %s disposal during held reload", async (owner) => {
		const entered = gate();
		const release = gate();
		const { runtime, initial } = await withRuntime();
		const { harness } = initial;
		const oldApi = initial.api();
		const reloadResources = harness.resourceLoader.reload;
		harness.resourceLoader.reload = async () => {
			entered.release();
			await release.promise;
			await reloadResources();
		};
		const heldReload = runtime.session.reload();
		const rejection = expect(within(heldReload)).rejects.toThrow();
		await within(entered.promise);
		if (owner === "runtime") await within(runtime.dispose());
		else harness.session.dispose();
		release.release();
		await rejection;
		const submission = {
			...initial.request("after terminal disposal"),
			sessionGeneration: harness.session.userMessageSessionGeneration,
		};
		expect(await within(oldApi.submitUserMessage(submission))).toMatchObject({
			status: "rejected",
			reason: "session_changed",
		});
		expect(await within(initial.api().submitUserMessage(submission))).toMatchObject({ status: "rejected" });
		expect(await within(harness.session.submitUserMessage(submission))).toMatchObject({
			status: "rejected",
			reason: owner === "runtime" ? "shutting_down" : "no_session",
		});
		expect(initial.contexts.filter(({ event }) => event === "session_start")).toHaveLength(2);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("retains completed receipts across reload, never re-admitting the old request with a fresh generation", async () => {
		const { runtime, initial } = await withRuntime();
		initial.harness.setResponses([fauxAssistantMessage("once")]);
		const submission = initial.request("one message");
		const receipt = await within(initial.api().submitUserMessage(submission));
		await within(runtime.session.waitForIdle());
		await within(runtime.session.prompt("/ingress-reload"));
		expect(initial.generation()).not.toBe(submission.sessionGeneration);
		const retry = { ...submission, sessionGeneration: initial.generation() };
		expect(await within(initial.api().submitUserMessage(retry))).toEqual(
			duplicateReceipt(receipt, retry.sessionGeneration),
		);
		expect(await within(initial.api().submitUserMessage({ ...retry, text: "different" }))).toMatchObject({
			status: "rejected",
			reason: "payload_mismatch",
		});
		expect(getUserTexts(initial.harness)).toEqual(["one message"]);
		expect(initial.harness.faux.state.callCount).toBe(1);
	});

	it.each(["new", "switch"] as const)("does not retarget an accepted busy follow-up across %s", async (transition) => {
		const started = gate();
		const release = gate();
		const { runtime, initial, current } = await withRuntime();
		initial.harness.setResponses([fauxAssistantMessage("baseline")]);
		await runtime.session.prompt("baseline");
		const originalFile = runtime.session.sessionFile!;
		if (transition === "switch") await runtime.session.prompt("/ingress-new");
		const outgoing = current();
		outgoing.harness.setResponses([
			async (_context, options) => {
				started.release();
				await Promise.race([
					release.promise,
					new Promise<void>((resolve) =>
						options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				return fauxAssistantMessage("outgoing response");
			},
		]);
		const run = runtime.session.prompt("working");
		await within(started.promise);
		const submission = outgoing.request("session-bound follow-up");
		expect((await within(outgoing.api().submitUserMessage(submission))).status).toBe("queued");
		expect(outgoing.harness.session.getFollowUpMessages()).toEqual(["session-bound follow-up"]);
		await within(
			runtime.session.prompt(transition === "switch" ? `/ingress-switch ${originalFile}` : "/ingress-new"),
		);
		release.release();
		await within(run);
		const incoming = current();
		expect(incoming.generation()).not.toBe(submission.sessionGeneration);
		expect(incoming.harness.session.getFollowUpMessages()).toEqual([]);
		expect(incoming.harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(await within(incoming.api().submitUserMessage(submission))).toMatchObject({
			status: "rejected",
			reason: "session_changed",
		});
		incoming.harness.setResponses([fauxAssistantMessage("new session only")]);
		await runtime.session.prompt("destination input");
		expect(getUserTexts(incoming.harness)).not.toContain("session-bound follow-up");
		expect(getAssistantTexts(incoming.harness).at(-1)).toBe("new session only");
		expect(incoming.harness.faux.state.callCount).toBe(1);
	});

	it("removes only ingress follow-ups on reload while ordinary and custom queued messages survive", async () => {
		const started = gate();
		const release = gate();
		const { runtime, initial } = await withRuntime();
		const { harness } = initial;
		harness.setResponses([
			async () => {
				started.release();
				await release.promise;
				return fauxAssistantMessage("original completed");
			},
			fauxAssistantMessage("ordinary completed"),
			fauxAssistantMessage("custom completed"),
		]);
		const run = runtime.session.prompt("original");
		await within(started.promise);
		const submission = initial.request("cancelled ingress");
		const receipt = await within(initial.api().submitUserMessage(submission));
		expect(receipt.status).toBe("queued");
		await harness.session.followUp("ordinary follow-up");
		initial
			.api()
			.sendMessage(
				{ customType: "reload-counterexample", content: "custom follow-up", display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		expect(harness.session.getFollowUpMessages()).toEqual(["cancelled ingress", "ordinary follow-up"]);
		await within(runtime.session.prompt("/ingress-reload"));
		expect(initial.generation()).not.toBe(submission.sessionGeneration);
		expect(harness.session.getFollowUpMessages()).toEqual(["ordinary follow-up"]);
		expect(
			await within(initial.api().submitUserMessage({ ...submission, sessionGeneration: initial.generation() })),
		).toEqual(duplicateReceipt(receipt, initial.generation()));
		release.release();
		await within(run);
		expect(getUserTexts(harness)).toEqual(["original", "ordinary follow-up"]);
		expect(harness.session.messages.filter((message) => message.role === "custom").map(getMessageText)).toEqual([
			"custom follow-up",
		]);
		expect(getAssistantTexts(harness)).toEqual(["original completed", "ordinary completed", "custom completed"]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it.each([
		{ field: "text", value: "é".repeat(32769) },
		{ field: "requestId", value: "é".repeat(129) },
		{ field: "registrationEpoch", value: "é".repeat(129) },
	])("refuses oversized UTF-8 $field before invoking input hooks", async ({ field, value }) => {
		const { harness, api, request, inputs } = await setup();
		expect(await within(api().submitUserMessage({ ...request("bounded"), [field]: value }))).toMatchObject({
			status: "rejected",
			reason: "admission_refused",
		});
		expect(inputs).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("fences a reload started synchronously by a queue_update listener, leaving no stale insertion or display", async () => {
		const started = gate();
		const release = gate();
		const { runtime, initial } = await withRuntime();
		const { harness } = initial;
		harness.setResponses([
			async () => {
				started.release();
				await release.promise;
				return fauxAssistantMessage("original completed");
			},
		]);
		const run = runtime.session.prompt("original");
		await within(started.promise);
		let reloading: Promise<void> | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "queue_update" && event.followUp.includes("reentrant ingress") && !reloading) {
				unsubscribe();
				reloading = harness.session.reload();
			}
		});
		const receipt = await within(initial.api().submitUserMessage(initial.request("reentrant ingress")));
		expect(reloading).toBeDefined();
		await within(reloading!);
		// queue_update may fire after actual admission. Its first queued receipt remains valid
		// even though this synchronous listener immediately cancels execution through reload.
		expect(receipt.status).toBe("queued");
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		release.release();
		await within(run);
		expect(getUserTexts(harness)).toEqual(["original"]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("preserves sparse ordinary reservation slots around cancelled ingress during a held batch", async () => {
		const started = gate();
		const releaseProvider = gate();
		const batchEntered = gate();
		const releaseBatch = gate();
		const { runtime, initial } = await withRuntime({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role !== "user" || getMessageText(event.message) !== "ordinary A") return;
						batchEntered.release();
						await releaseBatch.promise;
					});
				},
			],
		});
		const { harness } = initial;
		harness.session.setFollowUpMode("all");
		harness.setResponses([
			async () => {
				started.release();
				await releaseProvider.promise;
				return fauxAssistantMessage("original completed");
			},
			fauxAssistantMessage("survivors completed"),
		]);
		const run = runtime.session.prompt("original");
		await within(started.promise);
		await harness.session.followUp("ordinary A");
		expect((await within(initial.api().submitUserMessage(initial.request("same text")))).status).toBe("queued");
		// Equal text is intentional: only the ingress identity may be removed, not an ordinary survivor.
		await harness.session.followUp("same text");
		await harness.session.followUp("ordinary B");
		releaseProvider.release();
		await within(batchEntered.promise);
		await within(harness.session.reload());
		releaseBatch.release();
		await within(run);
		expect(getUserTexts(harness)).toEqual(["original", "ordinary A", "same text", "ordinary B"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("cancels fresh-generation queued ingress admitted during before-switch when teardown commits", async () => {
		const started = gate();
		const releaseProvider = gate();
		const switchEntered = gate();
		const releaseSwitch = gate();
		let switchingGeneration = "";
		const { runtime, initial, current } = await withRuntime({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_switch", async (_event, ctx) => {
						switchingGeneration = ctx.userMessageSessionGeneration;
						switchEntered.release();
						await releaseSwitch.promise;
					});
				},
			],
		});
		initial.harness.setResponses([
			async (_context, options) => {
				started.release();
				await Promise.race([
					releaseProvider.promise,
					new Promise<void>((resolve) =>
						options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				return fauxAssistantMessage("outgoing stopped");
			},
		]);
		const run = runtime.session.prompt("original");
		await within(started.promise);
		const switching = runtime.session.prompt("/ingress-new");
		await within(switchEntered.promise);
		expect(switchingGeneration).not.toBe(initial.generation());
		const submission = { ...initial.request("fresh but outgoing"), sessionGeneration: switchingGeneration };
		const receipt = await within(initial.api().submitUserMessage(submission));
		// A replacement may refuse fresh ingress while its before-switch hook runs, or queue it
		// in the outgoing session. In either case committed teardown must prevent its execution.
		expect(["queued", "rejected"]).toContain(receipt.status);
		releaseSwitch.release();
		await within(switching);
		releaseProvider.release();
		await within(run);
		const incoming = current();
		expect(getUserTexts(initial.harness)).not.toContain("fresh but outgoing");
		expect(getUserTexts(incoming.harness)).not.toContain("fresh but outgoing");
		expect(incoming.harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("rejects cancelled pre-prompt compaction without retaining runnable ingress, preserving ordinary retention", async () => {
		const { harness, api, request } = await setup({
			models: [{ id: "small", contextWindow: 4000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harness.sessionManager.appendMessage({ role: "user", content: "x".repeat(30000), timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("old reply"));
		harness.session.refreshContext();
		const receipt = await within(api().submitUserMessage(request("retained ingress")));
		expect(receipt).toMatchObject({ status: "rejected", reason: "admission_refused" });
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.faux.state.callCount).toBe(0);
		await expect(harness.session.prompt("ordinary retained", { streamingBehavior: "followUp" })).rejects.toThrow(
			/compaction/,
		);
		expect(harness.session.getFollowUpMessages()).toEqual(["ordinary retained"]);
		harness.session.setAutoCompactionEnabled(false);
		harness.setResponses([fauxAssistantMessage("recovery reply"), fauxAssistantMessage("retained reply")]);
		await harness.session.prompt("explicit recovery");
		expect(getUserTexts(harness)).not.toContain("retained ingress");
		expect(getUserTexts(harness).filter((text) => text === "ordinary retained")).toHaveLength(1);
	});

	it("keeps the same session usable with a fresh generation after a real switch veto", async () => {
		const { runtime, initial } = await withRuntime({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_switch", () => ({ cancel: true }));
				},
			],
		});
		const oldRequest = initial.request("stale after veto");
		await within(runtime.session.prompt("/ingress-new"));
		expect(runtime.session).toBe(initial.harness.session);
		// No session_start occurs for a veto; obtain the fresh generation through a real extension command.
		await runtime.session.prompt("/ingress-generation");
		const freshGeneration = initial.generation();
		expect(freshGeneration).not.toBe(oldRequest.sessionGeneration);
		expect(await within(initial.api().submitUserMessage(oldRequest))).toMatchObject({
			status: "rejected",
			reason: "session_changed",
		});
		initial.harness.setResponses([fauxAssistantMessage("fresh after veto")]);
		const fresh = { ...initial.request("fresh after veto", "fresh-veto-id"), sessionGeneration: freshGeneration };
		expect((await within(initial.api().submitUserMessage(fresh))).status).toBe("accepted");
		await within(runtime.session.waitForIdle());
		expect(getUserTexts(initial.harness)).toEqual(["fresh after veto"]);
		expect(initial.harness.faux.state.callCount).toBe(1);
	});

	it("never returns rejected for input that crosses dispatch when an agent_start handler reloads synchronously", async () => {
		let reloading: Promise<void> | undefined;
		let harness!: Harness;
		const setupResult = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", () => {
						if (!reloading) reloading = harness.session.reload();
					});
				},
			],
		});
		harness = setupResult.harness;
		const submission = setupResult.request("reentrant dispatch");
		harness.setResponses([fauxAssistantMessage("dispatch completed")]);
		const receipt = await within(setupResult.api().submitUserMessage(submission));
		expect(receipt.sessionGeneration).toBe(submission.sessionGeneration);
		expect(reloading).toBeDefined();
		await within(reloading!);
		await within(harness.session.waitForIdle());
		// A dispatched turn belongs to the old session even if lifecycle handlers invalidate later work.
		// A cancellation before dispatch must instead leave no transcript or provider input.
		if (receipt.status === "rejected") {
			expect(getUserTexts(harness)).toEqual([]);
			expect(harness.faux.state.callCount).toBe(0);
		} else {
			expect(receipt.status).toBe("accepted");
			expect(getUserTexts(harness)).toEqual(["reentrant dispatch"]);
			expect(harness.faux.state.callCount).toBe(1);
		}
	});

	it("removes the exact equal-text ingress display entry without changing ordinary queue order", async () => {
		const started = gate();
		const release = gate();
		const { runtime, initial } = await withRuntime();
		const { harness } = initial;
		harness.setResponses([
			async () => {
				started.release();
				await release.promise;
				return fauxAssistantMessage("original completed");
			},
			fauxAssistantMessage("Y completed"),
			fauxAssistantMessage("X completed"),
		]);
		const run = runtime.session.prompt("original");
		await within(started.promise);
		expect((await within(initial.api().submitUserMessage(initial.request("X")))).status).toBe("queued");
		await harness.session.followUp("Y");
		await harness.session.followUp("X");
		expect(harness.session.getFollowUpMessages()).toEqual(["X", "Y", "X"]);
		await within(runtime.session.prompt("/ingress-reload"));
		expect(harness.session.getFollowUpMessages()).toEqual(["Y", "X"]);
		release.release();
		await within(run);
		expect(getUserTexts(harness)).toEqual(["original", "Y", "X"]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("refuses ledger exhaustion without evicting and replaying a completed key", async () => {
		const { harness, api, request, generation, inputs } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => (event.text === "capacity filler" ? { action: "handled" } : undefined));
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("once")]);
		const firstRequest = request("first admitted", "first");
		const firstReceipt = await within(api().submitUserMessage(firstRequest));
		await within(harness.session.waitForIdle());
		// #5533: capacity is 1024 reservations; exhaustion must refuse, not discard old idempotency keys.
		for (let index = 1; index < 1024; index++) {
			expect((await api().submitUserMessage(request("capacity filler", `filler-${index}`))).status).toBe("rejected");
		}
		expect(inputs).toHaveLength(1024);
		expect(await within(api().submitUserMessage(request("overflow", "overflow")))).toEqual({
			status: "rejected",
			sessionGeneration: generation(),
			reason: "admission_refused",
		});
		expect(await within(api().submitUserMessage(firstRequest))).toEqual(duplicateReceipt(firstReceipt));
		expect(inputs).toHaveLength(1024);
		expect(getUserTexts(harness)).toEqual(["first admitted"]);
		expect(harness.faux.state.callCount).toBe(1);
	});
});
