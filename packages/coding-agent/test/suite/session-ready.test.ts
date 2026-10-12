import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI, ExtensionFactory, SessionReadyEvent } from "../../src/core/extensions/index.ts";
import type { SubmitUserMessageOptions, UserMessageReceipt } from "../../src/index.ts";
import { createHarness, getUserTexts, type Harness, type HarnessOptions } from "./harness.ts";

interface Probe {
	harness: Harness;
	api: () => ExtensionAPI;
	/** Generation registered by this session's latest session_start handler. */
	generation: () => string;
	request: (text: string, requestId: string, sessionGeneration?: string) => SubmitUserMessageOptions;
}

type LogEntry =
	| { event: "session_start"; reason: string; generation: string }
	| { event: "session_start_done" }
	| { event: "session_ready"; reason: string; generation: string; runtimeFenced: boolean; sessionFenced: boolean };

interface RuntimeOptions {
	/** Hold the second session_start handler of replacement sessions until released. */
	holdStart?: { entered: () => void; release: Promise<void> };
	onReady?: (event: SessionReadyEvent, probe: Probe) => void;
	extensionFactories?: ExtensionFactory[];
	failCreate?: () => boolean;
}

async function within<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("did not finish")), 2000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

// smarty-dev#10453: session_ready fires after a replacement's input fence lifts, so the generation
// registered in session_start can be submitted from it. Real runtime, sessions and faux turns; nothing mocked.
describe("session_ready (smarty-dev#10453)", () => {
	const harnesses: Harness[] = [];
	const releases: Array<() => void> = [];

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
	});

	async function withRuntime(options: RuntimeOptions = {}) {
		const log: LogEntry[] = [];
		let runtime!: AgentSessionRuntime;
		const createProbe = async (harnessOptions: HarnessOptions): Promise<Probe> => {
			let api!: ExtensionAPI;
			let generation = "";
			const probe = {} as Probe;
			const factories: ExtensionFactory[] = [
				(pi) => {
					api = pi;
					pi.on("session_start", (event, ctx) => {
						generation = ctx.userMessageSessionGeneration;
						log.push({ event: "session_start", reason: event.reason, generation });
					});
					pi.on("session_ready", (event) => {
						log.push({
							event: "session_ready",
							reason: event.reason,
							generation: event.sessionGeneration,
							runtimeFenced: runtime.inputsFenced,
							sessionFenced: probe.harness.session.inputsFenced,
						});
						options.onReady?.(event, probe);
					});
					pi.registerCommand("ready-new", {
						handler: async (_args, ctx) => {
							await ctx.newSession();
						},
					});
				},
				(pi) => {
					pi.on("session_start", async (event) => {
						if (!options.holdStart || event.reason === "startup") return;
						options.holdStart.entered();
						await options.holdStart.release;
						log.push({ event: "session_start_done" });
					});
				},
				...(options.extensionFactories ?? []),
			];
			const harness = await createHarness({
				...harnessOptions,
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: factories,
			});
			harnesses.push(harness);
			Object.assign(probe, {
				harness,
				api: () => api,
				generation: () => generation,
				request: (text: string, requestId: string, sessionGeneration = generation) => ({
					registrationEpoch: "epoch-1",
					requestId,
					sessionGeneration,
					text,
					deliverAs: "followUp" as const,
					expandPromptTemplates: false as const,
				}),
			});
			return probe;
		};
		const initial = await createProbe({ persistSession: true });
		const probes = [initial];
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			if (options.failCreate?.()) throw new Error("replacement construction failed");
			const next = await createProbe({ cwd, sessionManager, sessionStartEvent });
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
		runtime = new AgentSessionRuntime(
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
					newSession: (o) => runtime.newSession(o),
					switchSession: (path, o) => runtime.switchSession(path, o),
					fork: (entryId, o) => runtime.fork(entryId, o),
					navigateTree: (targetId, o) => runtime.session.navigateTree(targetId, o),
					reload: () => runtime.session.reload(),
				},
			});
		};
		runtime.setRebindSession(bind);
		await bind();
		const ready = () => log.filter((entry) => entry.event === "session_ready");
		return { runtime, initial, current: () => probes.at(-1)!, log, ready };
	}

	it("is advertised to extensions as pi.hostCapabilities.sessionReadyEvent", async () => {
		const { initial } = await withRuntime();
		expect(initial.api().hostCapabilities.sessionReadyEvent).toBe(true);
	});

	it("fires once, after a slow session_start handler resolves and the input fence lifts", async () => {
		const entered = gate();
		const release = gate();
		const { runtime, current, log, ready } = await withRuntime({
			holdStart: { entered: entered.release, release: release.promise },
		});
		const replacing = runtime.newSession();
		await within(entered.promise);
		await settle();
		expect(ready()).toEqual([]);
		expect(runtime.inputsFenced).toBe(true);
		release.release();
		await within(replacing);
		await settle();
		const incoming = current();
		const start = log.filter((entry) => entry.event === "session_start").at(-1);
		expect(ready()).toEqual([
			{
				event: "session_ready",
				reason: "new",
				generation: incoming.generation(),
				runtimeFenced: false,
				sessionFenced: false,
			},
		]);
		expect(start).toEqual({ event: "session_start", reason: "new", generation: incoming.generation() });
		expect(log.slice(-2).map((entry) => entry.event)).toEqual(["session_start_done", "session_ready"]);
		expect(runtime.inputsFenced).toBe(false);
	});

	it.each(["handler", "continuation"] as const)(
		"refuses the registered generation during session_start and accepts it from the session_ready %s",
		async (from) => {
			const entered = gate();
			const release = gate();
			let submitted: Promise<UserMessageReceipt> | undefined;
			const { runtime, current } = await withRuntime({
				holdStart: { entered: entered.release, release: release.promise },
				onReady: (event, probe) => {
					probe.harness.setResponses([fauxAssistantMessage("ready reply")]);
					const submit = () =>
						probe
							.api()
							.submitUserMessage(probe.request("from session_ready", "ready-id", event.sessionGeneration));
					submitted = from === "handler" ? submit() : Promise.resolve().then(submit);
				},
			});
			const replacing = runtime.newSession();
			await within(entered.promise);
			const incoming = current();
			const registered = incoming.generation();
			expect(await within(incoming.api().submitUserMessage(incoming.request("during start", "during-id")))).toEqual({
				status: "rejected",
				reason: "session_changed",
				sessionGeneration: registered,
			});
			release.release();
			await within(replacing);
			await settle();
			expect(submitted).toBeDefined();
			expect(await within(submitted!)).toEqual({ status: "accepted", sessionGeneration: registered });
			await within(runtime.session.waitForIdle());
			expect(getUserTexts(incoming.harness)).toEqual(["from session_ready"]);
		},
	);

	it("descendants of a handler dispatched inside a fenced scope do not inherit it (pi#163)", async () => {
		let detached: Promise<UserMessageReceipt> | undefined;
		const { initial } = await withRuntime({
			onReady: (event, probe) => {
				probe.harness.setResponses([fauxAssistantMessage("detached reply")]);
				detached = new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
					probe.api().submitUserMessage(probe.request("detached", "detached-id", event.sessionGeneration)),
				);
			},
		});
		const session = initial.harness.session;
		const releaseFence = await session.fenceInputs();
		// The scope goes inactive when withFencedInput returns, before the handler's timer fires.
		await session.withFencedInput(async () => {
			releaseFence();
			session.emitSessionReady("new");
		});
		expect(detached).toBeDefined();
		expect(await within(detached!)).toMatchObject({ status: "accepted" });
		await within(session.waitForIdle());
		expect(getUserTexts(initial.harness)).toEqual(["detached"]);
	});

	it.each(["new", "fork"] as const)("is not emitted when session_before_%s cancels", async (kind) => {
		const { runtime, initial, ready } = await withRuntime({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_switch", () => ({ cancel: true }));
					pi.on("session_before_fork", () => ({ cancel: true }));
				},
			],
		});
		initial.harness.setResponses([fauxAssistantMessage("baseline")]);
		await runtime.session.prompt("baseline");
		const userEntry = runtime.session.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user")!;
		const result = kind === "new" ? await runtime.newSession() : await runtime.fork(userEntry.id);
		expect(result.cancelled).toBe(true);
		await settle();
		expect(runtime.session).toBe(initial.harness.session);
		expect(ready()).toEqual([]);
	});

	it("is not emitted when the replacement session is never published", async () => {
		const { runtime, ready } = await withRuntime({ failCreate: () => true });
		await expect(within(runtime.newSession())).rejects.toThrow("replacement construction failed");
		await settle();
		expect(ready()).toEqual([]);
	});

	it("is not emitted when terminal shutdown begins during session_start", async () => {
		const entered = gate();
		const release = gate();
		const { runtime, ready } = await withRuntime({
			holdStart: { entered: entered.release, release: release.promise },
		});
		const replacing = runtime.newSession();
		void replacing.catch(() => {});
		await within(entered.promise);
		await within(runtime.dispose({ terminal: true, rejectQueuedInput: () => {} }));
		await expect(replacing).rejects.toThrow();
		release.release();
		await settle();
		expect(ready()).toEqual([]);
	});

	it("is not emitted for a replacement superseded by another lifecycle before dispatch", async () => {
		const { runtime, current, ready } = await withRuntime();
		let second: Promise<{ cancelled: boolean }> | undefined;
		runtime.setLifecycleCompleteHandler(() => {
			second ??= runtime.newSession();
		});
		await within(runtime.newSession());
		const superseded = current();
		expect(second).toBeDefined();
		await within(second!);
		await settle();
		expect(current()).not.toBe(superseded);
		expect(ready()).toEqual([expect.objectContaining({ reason: "new", generation: current().generation() })]);
	});

	// smarty-dev#10453 (pi#218 security P3): a handler still awaiting when the next /new starts keeps its old generation.
	it("a session_ready handler still running when the next replacement starts cannot submit into it", async () => {
		const held = gate();
		const secondEntered = gate();
		const secondRelease = gate();
		let holdSecondStart = false;
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		let continuation: Promise<UserMessageReceipt[]> | undefined;
		let replacingSecond: Promise<{ cancelled: boolean }> | undefined;
		try {
			const { runtime, current, ready } = await withRuntime({
				onReady: (event, probe) => {
					if (continuation) return;
					probe.harness.setResponses([fauxAssistantMessage("stale reply")]);
					continuation = (async () => {
						await held.promise;
						const during = await probe
							.api()
							.submitUserMessage(probe.request("stale during", "stale-during-id", event.sessionGeneration));
						secondRelease.release();
						await within(replacingSecond!);
						const after = await probe
							.api()
							.submitUserMessage(probe.request("stale after", "stale-after-id", event.sessionGeneration));
						return [during, after];
					})();
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async () => {
							if (!holdSecondStart) return;
							holdSecondStart = false;
							secondEntered.release();
							await secondRelease.promise;
						});
					},
				],
			});

			await within(runtime.newSession());
			await settle();
			const first = current();
			const firstGeneration = first.generation();
			expect(ready()).toEqual([expect.objectContaining({ reason: "new", generation: firstGeneration })]);
			expect(continuation).toBeDefined();

			// The first handler is still awaiting `held` when the second /new starts.
			holdSecondStart = true;
			replacingSecond = runtime.newSession();
			await within(secondEntered.promise);
			const second = current();
			expect(second).not.toBe(first);
			second.harness.setResponses([fauxAssistantMessage("must not run")]);
			held.release();

			const [during, after] = await within(continuation!);
			expect(during).toEqual({ status: "rejected", reason: "session_changed", sessionGeneration: firstGeneration });
			expect(after).toEqual({ status: "rejected", reason: "session_changed", sessionGeneration: firstGeneration });
			await settle();

			expect(runtime.session).toBe(second.harness.session);
			expect(second.generation()).not.toBe(firstGeneration);
			expect(ready()).toEqual([
				expect.objectContaining({ reason: "new", generation: firstGeneration }),
				{
					event: "session_ready",
					reason: "new",
					generation: second.generation(),
					runtimeFenced: false,
					sessionFenced: false,
				},
			]);
			await within(runtime.session.waitForIdle());
			expect(getUserTexts(second.harness)).toEqual([]);
			expect(getUserTexts(first.harness)).toEqual([]);
			expect(second.harness.session.isStreaming).toBe(false);
			await settle();
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("emits once with the right reason for /new, /resume and fork", async () => {
		const { runtime, initial, current, ready } = await withRuntime();
		initial.harness.setResponses([fauxAssistantMessage("baseline")]);
		await runtime.session.prompt("baseline");
		const firstFile = runtime.session.sessionFile!;

		await within(runtime.session.prompt("/ready-new"));
		await settle();
		expect(ready().map((entry) => entry.reason)).toEqual(["new"]);

		await within(runtime.switchSession(firstFile));
		await settle();
		expect(runtime.session.sessionFile).toBe(firstFile);
		expect(ready().map((entry) => entry.reason)).toEqual(["new", "resume"]);

		const userEntry = runtime.session.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user")!;
		await within(runtime.fork(userEntry.id, { position: "at" }));
		await settle();
		expect(ready()).toEqual([
			expect.objectContaining({ reason: "new" }),
			expect.objectContaining({ reason: "resume" }),
			expect.objectContaining({ reason: "fork", generation: current().generation(), runtimeFenced: false }),
		]);
	});
});
