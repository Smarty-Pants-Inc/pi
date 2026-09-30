import { fauxAssistantMessage, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeSummarization, estimateProjectedContextTokens } from "../../src/core/compaction/compaction.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

// Refs Smarty-Pants-Inc/smarty-dev#2742: in-place large-window -> small-window switches.
describe("model switch context admission (#2742)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function setup(options: HarnessOptions = {}): Promise<Harness> {
		const h = await createHarness({
			models: [
				{ id: "opus", contextWindow: 1_000_000, maxTokens: 16_384 },
				{ id: "sol", contextWindow: 272_000, maxTokens: 16_384 },
			],
			settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: false } },
			...options,
		});
		harnesses.push(h);
		return h;
	}

	function seed(h: Harness, tokens = 230_000): void {
		h.sessionManager.appendMessage({ role: "user", content: "history to summarize", timestamp: Date.now() - 2000 });
		h.sessionManager.appendMessage({
			...fauxAssistantMessage("old response", { timestamp: Date.now() - 1000 }),
			api: h.getModel().api,
			provider: h.getModel().provider,
			model: h.getModel().id,
			usage: {
				input: tokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: tokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		h.session.refreshContext();
	}

	it.each(["SDK", "cycle", "scoped cycle", "extension", "/model"] as const)(
		"%s compacts immediately with the old model before committing the target",
		async (route) => {
			let api: ExtensionAPI | undefined;
			const h = await setup({
				extensionFactories: [
					(pi) => {
						api = pi;
					},
				],
			});
			seed(h);
			const oldModel = h.session.model;
			const target = h.getModel("sol")!;
			const requestModels: string[] = [];
			const stream = h.session.agent.streamFunction;
			h.session.agent.streamFunction = (model, context, options) => {
				requestModels.push(model.id);
				expect(h.session.model?.id).toBe(requestModels.length === 1 ? oldModel?.id : target.id);
				return stream(model, context, options);
			};
			h.setResponses([fauxAssistantMessage("summary"), fauxAssistantMessage("continued on Sol")]);
			if (route === "SDK") await h.session.setModel(target, { persist: true });
			else if (route === "cycle" || route === "scoped cycle") {
				if (route === "scoped cycle") h.session.setScopedModels(h.models.map((model) => ({ model })));
				await h.session.cycleModel();
			} else if (route === "extension") await api!.setModel(target);
			else {
				const ui = {
					session: h.session,
					findExactModelMatch: async () => target,
					footer: { invalidate: vi.fn() },
					updateEditorBorderColor: vi.fn(),
					showStatus: vi.fn(),
					showError: vi.fn(),
					maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
					checkDaxnutsEasterEgg: vi.fn(),
				};
				const command = Reflect.get(InteractiveMode.prototype, "handleModelCommand") as (
					this: typeof ui,
					reference: string,
				) => Promise<void>;
				await command.call(ui, "faux/sol");
				expect(ui.showError).not.toHaveBeenCalled();
			}
			expect(requestModels).toEqual(["opus"]);
			expect(h.session.model?.id).toBe("sol");
			expect(h.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
			expect(h.eventsOfType("compaction_end")[0]?.result?.summary).toContain("summary");
			const branch = h.sessionManager.getBranch();
			expect(branch.findIndex((e) => e.type === "compaction")).toBeLessThan(
				branch.findIndex((e) => e.type === "model_change"),
			);
			expect(estimateProjectedContextTokens(h.sessionManager.buildSessionProjection(), branch).tokens).toBeLessThan(
				0.8 * target.contextWindow,
			);
			await h.session.prompt("next request");
			expect(requestModels).toEqual(["opus", "sol"]);
			expect(h.session.getLastAssistantText()).toBe("continued on Sol");
			expect(h.eventsOfType("compaction_start")).toHaveLength(1);
		},
	);

	it.each(["disabled", "cancelled", "failed", "nothing", "insufficient", "busy"] as const)(
		"refuses a switch when compaction is %s, preserving model, thinking and defaults",
		async (failure) => {
			const h = await setup({
				extensionFactories: [
					(pi) => {
						if (failure === "cancelled") pi.on("session_before_compact", () => ({ cancel: true }));
						if (failure === "insufficient")
							pi.on("session_before_compact", (event) => ({
								compaction: {
									summary: "x".repeat(900_000),
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							}));
					},
				],
			});
			seed(h);
			if (failure === "disabled") h.session.setAutoCompactionEnabled(false);
			if (failure === "nothing") h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1_000_000 } });
			if (failure === "busy") vi.spyOn(h.session, "isStreaming", "get").mockReturnValue(true);
			h.setResponses([
				failure === "failed"
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" })
					: fauxAssistantMessage("summary"),
			]);
			const oldModel = h.session.model;
			const thinking = h.session.thinkingLevel;
			await expect(h.session.setModel(h.getModel("sol")!, { persist: true })).rejects.toThrow(
				/model switch refused/i,
			);
			expect(h.session.model).toBe(oldModel);
			expect(h.session.thinkingLevel).toBe(thinking);
			expect(h.settingsManager.getDefaultModel()).toBeUndefined();
			expect(h.sessionManager.getEntries().filter((e) => e.type === "model_change")).toEqual([]);
		},
	);

	it.each([350_000, 900_000])("compacts context already over the target window (%s tokens)", async (tokens) => {
		const h = await setup();
		seed(h, tokens);
		h.setResponses([
			(_context, _options, _state, model) => {
				expect(model.id).toBe("opus");
				return fauxAssistantMessage("large history summarized");
			},
		]);
		await h.session.setModel(h.getModel("sol")!);
		expect(h.session.model?.id).toBe("sol");
		expect(h.eventsOfType("compaction_end")[0]?.result?.summary).toContain("large history summarized");
	});

	it("compacts when refreshed metadata shrinks the same model's window", async () => {
		const h = await setup();
		seed(h);
		h.setResponses([fauxAssistantMessage("summary")]);
		await h.session.setModel({ ...h.getModel(), contextWindow: 272_000 });
		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
		expect(h.session.model?.contextWindow).toBe(272_000);
	});

	it("starts input queued by the compaction UI only after the switch commits", async () => {
		const h = await setup();
		seed(h);
		h.setResponses([
			fauxAssistantMessage("summary"),
			(_context, _options, _state, model) => {
				expect(model.id).toBe("sol");
				return fauxAssistantMessage("queued input delivered");
			},
		]);
		let queued: Promise<void> | undefined;
		h.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.result) {
				queued = h.session.prompt("queued during switch", { streamingBehavior: "followUp" });
			}
		});
		await h.session.setModel(h.getModel("sol")!);
		await queued;
		await h.session.waitForIdle();
		expect(h.session.getLastAssistantText()).toBe("queued input delivered");
		expect(h.session.getFollowUpMessages()).toEqual([]);
		expect(h.faux.state.callCount).toBe(2);
	});

	it("does not compact at 80% or when moving to a larger window", async () => {
		const h = await setup();
		seed(h, 0.8 * 272_000);
		await h.session.setModel(h.getModel("sol")!);
		await h.session.setModel(h.getModel("opus")!);
		expect(h.eventsOfType("compaction_start")).toEqual([]);
		expect(h.faux.state.callCount).toBe(0);
	});

	it("uses the projection after compaction rather than stale retained assistant usage", async () => {
		const h = await setup();
		seed(h, 600_000);
		h.setResponses([fauxAssistantMessage("small summary")]);
		await h.session.compact();
		await h.session.setModel(h.getModel("sol")!);
		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
	});

	it.each([false, true])("blocks oversized first input before contacting a provider (auto: %s)", async (enabled) => {
		const h = await setup({ settings: { compaction: { enabled }, retry: { enabled: false } } });
		h.session.agent.state.model = { ...h.getModel(), contextWindow: 20_000 };
		await h.session.prompt("x".repeat(100_000));
		expect(h.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringMatching(/context exceeds window/i),
		});
		expect(h.faux.state.callCount).toBe(0);
		expect(h.session.isIdle).toBe(true);
	});

	it("recovers oversized projected history through overflow before the first request", async () => {
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "recovered",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		seed(h);
		const oldAssistant = h.session.messages.at(-1)!;
		h.sessionManager.appendCompaction("old summary", h.sessionManager.getEntries()[0]!.id, 230_000);
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(1_200_000), timestamp: Date.now() });
		h.sessionManager.appendMessage({ ...fauxAssistantMessage("recent"), timestamp: oldAssistant.timestamp });
		h.session.agent.state.model = h.getModel("sol")!;
		h.session.refreshContext();
		h.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("recovered");
				return fauxAssistantMessage("continued");
			},
		]);
		await h.session.prompt("next");
		expect(h.eventsOfType("compaction_start").at(-1)?.reason).toBe("overflow");
		expect(h.faux.state.callCount).toBe(1);
	});

	it("blocks oversized extension-transformed context", async () => {
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("context", () => ({
						messages: [{ role: "user", content: "x".repeat(4_100_000), timestamp: Date.now() }],
					}));
				},
			],
		});
		await h.session.prompt("small input");
		expect(h.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringMatching(/context exceeds window/i),
		});
		expect(h.faux.state.callCount).toBe(0);
	});

	it("fences input and other switches while the old model compacts", async () => {
		let started!: () => void;
		let release!: () => void;
		const beginning = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						started();
						await gate;
						return {
							compaction: {
								summary: "small summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		seed(h);
		const switching = h.session.setModel(h.getModel("sol")!);
		try {
			await beginning;
			expect(h.session.model?.id).toBe("opus");
			await expect(h.session.prompt("do not send yet")).rejects.toThrow(/model switch compaction is in progress/i);
			await expect(h.session.setModel(h.getModel("opus")!)).rejects.toThrow(/model switch refused/i);
			expect(h.faux.state.callCount).toBe(0);
		} finally {
			release();
			await switching;
		}
		expect(h.session.model?.id).toBe("sol");
	});

	it("blocks summary formatting added by provider-message conversion", async () => {
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({ systemPrompt: "" }));
					pi.on("context", () => ({
						messages: [
							{
								role: "compactionSummary",
								summary: "x".repeat(80_000),
								tokensBefore: 40_000,
								timestamp: Date.now(),
							},
						],
					}));
				},
			],
		});
		h.session.setActiveToolsByName([]);
		h.session.agent.state.model = { ...h.getModel(), contextWindow: 20_000 };
		await h.session.prompt("small input");
		expect(h.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringMatching(/context exceeds window/i),
		});
		expect(h.faux.state.callCount).toBe(0);
	});

	it.each(["SDK", "cycle", "scoped cycle"] as const)(
		"%s settles idle only after the model switch commits",
		async (route) => {
			let started!: () => void;
			let release!: () => void;
			const beginning = new Promise<void>((resolve) => {
				started = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const h = await setup({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							started();
							await gate;
							return {
								compaction: {
									summary: "small summary",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			seed(h);
			if (route === "scoped cycle") h.session.setScopedModels(h.models.map((model) => ({ model })));
			const switching = route === "SDK" ? h.session.setModel(h.getModel("sol")!) : h.session.cycleModel();
			await beginning;
			const observed: string[] = [];
			const idle = h.session.waitForIdle().then(() => {
				observed.push(h.session.model!.id);
			});
			release();
			await Promise.all([switching, idle]);
			expect(observed).toEqual(["sol"]);
		},
	);

	it("allows intentional model selection inside before_agent_start", async () => {
		let api!: ExtensionAPI;
		let target!: Model<string>;
		const h = await setup({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("before_agent_start", async () => {
						await api.setModel(target);
					});
				},
			],
		});
		target = h.getModel("sol")!;
		seed(h);
		h.setResponses([
			fauxAssistantMessage("summary"),
			(_context, _options, _state, model) => {
				expect(model.id).toBe("sol");
				return fauxAssistantMessage("selected inside hook");
			},
		]);
		await h.session.prompt("switch intentionally");
		expect(h.session.getLastAssistantText()).toBe("selected inside hook");
		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
	});

	it("retains a prompt already admitted into an input hook during a switch", async () => {
		let inputStarted!: () => void;
		let resumeInput!: () => void;
		let compactStarted!: () => void;
		let resumeCompact!: () => void;
		const inputBeginning = new Promise<void>((resolve) => {
			inputStarted = resolve;
		});
		const inputGate = new Promise<void>((resolve) => {
			resumeInput = resolve;
		});
		const compactBeginning = new Promise<void>((resolve) => {
			compactStarted = resolve;
		});
		const compactGate = new Promise<void>((resolve) => {
			resumeCompact = resolve;
		});
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						inputStarted();
						await inputGate;
						return { action: "continue" };
					});
					pi.on("session_before_compact", async (event) => {
						compactStarted();
						await compactGate;
						return {
							compaction: {
								summary: "small summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		seed(h);
		h.setResponses([
			(_context, _options, _state, model) => {
				expect(model.id).toBe("sol");
				return fauxAssistantMessage("input retained");
			},
		]);
		const prompt = h.session.prompt("admitted input");
		// Attach immediately so a RED rejection is observed rather than unhandled.
		const outcome = prompt.then(
			() => undefined,
			(error: unknown) => error,
		);
		await inputBeginning;
		const switching = h.session.setModel(h.getModel("sol")!);
		await compactBeginning;
		resumeInput();
		await Promise.resolve();
		await Promise.resolve();
		resumeCompact();
		await switching;
		expect(await outcome).toBeUndefined();
		expect(h.session.getLastAssistantText()).toBe("input retained");
		expect(h.faux.state.callCount).toBe(1);
	});

	it("retains admitted input across consecutive shrinking switches", async () => {
		let startInput!: () => void;
		let releaseInput!: () => void;
		let startFirst!: () => void;
		let releaseFirst!: () => void;
		let startSecond!: () => void;
		let releaseSecond!: () => void;
		const inputStarted = new Promise<void>((resolve) => {
			startInput = resolve;
		});
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const firstStarted = new Promise<void>((resolve) => {
			startFirst = resolve;
		});
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const secondStarted = new Promise<void>((resolve) => {
			startSecond = resolve;
		});
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		let compactions = 0;
		const h = await setup({
			models: [
				{ id: "opus", contextWindow: 1_000_000, maxTokens: 16_384 },
				{ id: "sol", contextWindow: 272_000, maxTokens: 16_384 },
				{ id: "tiny", contextWindow: 80_000, maxTokens: 16_384 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						startInput();
						await inputGate;
						return { action: "continue" };
					});
					pi.on("session_before_compact", async (event) => {
						const first = ++compactions === 1;
						if (first) startFirst();
						else startSecond();
						await (first ? firstGate : secondGate);
						return {
							compaction: {
								summary: first ? "x".repeat(400_000) : "small summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		seed(h);
		h.setResponses([
			(_context, _options, _state, model) => {
				expect(model.id).toBe("tiny");
				return fauxAssistantMessage("retained across switches");
			},
		]);
		const outcome = h.session.prompt("admitted input").then(
			() => undefined,
			(error: unknown) => error,
		);
		await inputStarted;
		const firstSwitch = h.session.setModel(h.getModel("sol")!);
		await firstStarted;
		const secondSwitch = h.session.waitForIdle().then(() => {
			// A fresh completed boundary makes a second compaction preparable.
			seed(h, 100_000);
			return h.session.cycleModel();
		});
		releaseInput();
		// Let the admitted prompt join the first switch's existing idle waiters.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		releaseFirst();
		await secondStarted;
		releaseSecond();
		await Promise.all([firstSwitch, secondSwitch]);
		expect(await outcome).toBeUndefined();
		expect(h.session.getLastAssistantText()).toBe("retained across switches");
		expect(h.faux.state.callCount).toBe(1);
	});

	it("blocks oversized standalone summary requests before the provider", async () => {
		const h = await setup();
		const model: Model<string> = { ...h.getModel(), contextWindow: 1000 };
		await expect(
			completeSummarization(
				model,
				normalizeContext({ messages: [{ role: "user", content: "x".repeat(5000), timestamp: Date.now() }] }),
				{},
			),
		).rejects.toThrow(/context exceeds window/i);
		expect(h.faux.state.callCount).toBe(0);
	});
});
