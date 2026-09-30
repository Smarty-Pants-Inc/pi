import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

// Refs Smarty-Pants-Inc/pi#97, Astra round 1; owning issue smarty-dev#2742.
describe("model switch review regressions (#97)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()!.cleanup();
	});
	async function setup(options: HarnessOptions = {}) {
		const h = await createHarness({
			models: [
				{ id: "opus", contextWindow: 100_000 },
				{ id: "sol", contextWindow: 16_000 },
			],
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } },
			...options,
		});
		harnesses.push(h);
		return h;
	}

	it.each([false, true])("admits excluded bash output (auto: %s)", async (enabled) => {
		const h = await setup({ settings: { compaction: { enabled }, retry: { enabled: false } } });
		h.session.agent.state.model = h.getModel("sol")!;
		h.session.recordBashResult(
			"large diagnostic",
			{ output: "x".repeat(80_000), exitCode: 0, cancelled: false, truncated: false },
			{ excludeFromContext: true },
		);
		h.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain("large diagnostic");
				return fauxAssistantMessage("short request accepted");
			},
		]);
		await h.session.prompt("short input");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.session.getLastAssistantText()).toBe("short request accepted");
	});

	it.each([false, true])("admits a shrinking context transform (auto: %s)", async (enabled) => {
		const h = await setup({
			settings: { compaction: { enabled }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("context", () => ({
						messages: [{ role: "user", content: "short transformed input", timestamp: Date.now() }],
					}));
				},
			],
		});
		h.session.agent.state.model = h.getModel("sol")!;
		h.setResponses([fauxAssistantMessage("transformed request accepted")]);
		await h.session.prompt("x".repeat(80_000));
		expect(h.faux.state.callCount).toBe(1);
		expect(h.session.getLastAssistantText()).toBe("transformed request accepted");
	});

	it.each([false, true])("admits a shrinking prepared context (auto: %s)", async (enabled) => {
		const h = await setup({
			settings: { compaction: { enabled }, retry: { enabled: false } },
			prepareRequest: () => ({
				context: { messages: [{ role: "user", content: "short prepared input", timestamp: Date.now() }] },
			}),
		});
		h.session.agent.state.model = h.getModel("sol")!;
		h.setResponses([fauxAssistantMessage("prepared context accepted")]);
		await h.session.prompt("x".repeat(80_000));
		expect(h.faux.state.callCount).toBe(1);
		expect(h.session.getLastAssistantText()).toBe("prepared context accepted");
	});

	it("admits a forced prompt that excludes a large persisted system prompt", async () => {
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({ systemPrompt: "small forced prompt" }));
				},
			],
		});
		h.session.agent.state.model = h.getModel("sol")!;
		h.sessionManager.appendMessage({ role: "system", content: "x".repeat(80_000), timestamp: Date.now() });
		h.session.refreshContext();
		h.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("small forced prompt");
				expect(JSON.stringify(context.messages)).not.toContain("x".repeat(80_000));
				return fauxAssistantMessage("forced prompt accepted");
			},
		]);
		await h.session.prompt("short input");
		expect(h.faux.state.callCount).toBe(1);
	});

	it("does not discard oversized request-specific context to recover overflow", async () => {
		const h = await setup({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 }, retry: { enabled: false } },
			prepareRequest: (request) => ({
				model: { ...request.model, contextWindow: 16_000 },
				context: {
					...request.context,
					messages: [
						...request.context.messages,
						{ role: "user", content: `request-specific input${"x".repeat(80_000)}`, timestamp: Date.now() },
					],
				},
			}),
		});
		h.sessionManager.appendMessage({ role: "user", content: "preparable history", timestamp: Date.now() - 2000 });
		h.sessionManager.appendMessage({ ...fauxAssistantMessage("old response"), timestamp: Date.now() - 1000 });
		h.session.refreshContext();
		await h.session.prompt("short input");
		expect(h.faux.state.callCount).toBe(0);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringMatching(/context exceeds window/i),
		});
	});

	it.each(["same-context", "omitted-context", "model-only"] as const)(
		"does not lose input from %s preparation during overflow recovery",
		async (mode) => {
			let preparations = 0;
			const h = await setup({
				settings: {
					compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 },
					retry: { enabled: false },
				},
				prepareRequest: (request) => {
					preparations++;
					if (mode !== "model-only")
						request.context.messages.push({
							role: "user",
							content: "request-specific input must not be discarded",
							timestamp: Date.now(),
						});
					const model = { ...request.model, contextWindow: 16_000 };
					return mode === "same-context" ? { context: request.context, model } : { model };
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => ({
							compaction: {
								summary: "small summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
					},
				],
			});
			// The ordinary session model fits this history, but the prepared request
			// model needs compaction. Request-specific input is not in persisted history.
			h.sessionManager.appendMessage({ role: "user", content: "x".repeat(80_000), timestamp: Date.now() - 2000 });
			h.sessionManager.appendMessage({ ...fauxAssistantMessage("old response"), timestamp: Date.now() - 1000 });
			h.session.refreshContext();
			h.setResponses([
				(context) => {
					expect(JSON.stringify(context.messages)).toContain("new ordinary input");
					return fauxAssistantMessage("recovered safely");
				},
			]);
			await h.session.prompt("new ordinary input");
			expect(preparations).toBe(1);
			expect(h.faux.state.callCount).toBe(mode === "model-only" ? 1 : 0);
			expect(h.eventsOfType("compaction_start")).toHaveLength(mode === "model-only" ? 1 : 0);
			if (mode !== "model-only")
				expect(h.eventsOfType("message_end").at(-1)?.message).toMatchObject({
					stopReason: "error",
					errorMessage: expect.stringMatching(/context exceeds window/i),
				});
		},
	);

	it("admits fitting prepared input with nonserializable SDK-only metadata", async () => {
		const details: { self?: unknown } = {};
		details.self = details;
		const h = await setup({
			prepareRequest: (request) => {
				request.context.messages.push({
					role: "custom",
					customType: "sdk-metadata",
					content: "small prepared input",
					display: false,
					details,
					timestamp: Date.now(),
				});
				return { context: request.context };
			},
		});
		h.setResponses([fauxAssistantMessage("metadata excluded from provider input")]);
		await h.session.prompt("short input");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.session.getLastAssistantText()).toBe("metadata excluded from provider input");
	});

	it.each(["larger", "smaller"] as const)(
		"uses the %s prepared model for the first input bound",
		async (direction) => {
			const h = await setup({
				prepareRequest: (request) => ({
					model: { ...request.model, id: "prepared", contextWindow: direction === "larger" ? 100_000 : 16_000 },
				}),
			});
			h.session.agent.state.model = h.getModel(direction === "larger" ? "sol" : "opus")!;
			h.setResponses([
				(_context, _options, _state, model) => {
					expect(model.id).toBe("prepared");
					return fauxAssistantMessage("prepared model accepted");
				},
			]);
			await h.session.prompt("x".repeat(80_000));
			expect(h.faux.state.callCount).toBe(direction === "larger" ? 1 : 0);
			if (direction === "larger") expect(h.session.getLastAssistantText()).toBe("prepared model accepted");
			else
				expect(h.eventsOfType("message_end").at(-1)?.message).toMatchObject({
					stopReason: "error",
					errorMessage: expect.stringMatching(/context exceeds window/i),
				});
		},
	);

	it.each(["steer", "followUp"] as const)(
		"re-admits two triggered messages as %s without competing run owners",
		async (deliverAs) => {
			const compactStarted = gate();
			const compactRelease = gate();
			const responseStarted = gate();
			const responseRelease = gate();
			const h = await setup({
				settings: {
					compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 },
					retry: { enabled: false },
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							compactStarted.release();
							await compactRelease.promise;
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
			h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
			h.sessionManager.appendMessage({ ...fauxAssistantMessage("old response"), timestamp: Date.now() - 1000 });
			h.session.refreshContext();
			h.setResponses([
				async () => {
					responseStarted.release();
					await responseRelease.promise;
					return fauxAssistantMessage("first response");
				},
				fauxAssistantMessage("second response"),
			]);
			const switching = h.session.setModel(h.getModel("sol")!);
			await compactStarted.promise;
			const first = h.session.sendCustomMessage(
				{ customType: "first", content: "first triggered", display: true },
				{ triggerTurn: true },
			);
			const second = h.session.sendCustomMessage(
				{ customType: "second", content: "second triggered", display: true },
				{ triggerTurn: true, deliverAs },
			);
			const secondResult = second.then(
				() => undefined,
				(error: unknown) => error,
			);
			try {
				compactRelease.release();
				await switching;
				await responseStarted.promise;
				expect(await secondResult).toBeUndefined();
				expect(h.session.isStreaming).toBe(true);
				expect(h.session.isIdle).toBe(false);
				expect(h.eventsOfType("agent_settled")).toHaveLength(0);
			} finally {
				responseRelease.release();
				await first;
			}
			await h.session.waitForIdle();
			expect(h.eventsOfType("agent_settled")).toHaveLength(1);
			expect(
				h.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message")
					.map((entry) => entry.customType),
			).toEqual(["first", "second"]);
			expect(h.session.isIdle).toBe(true);
		},
	);

	it.each(["steer", "followUp"] as const)(
		"re-admits a deferred settled trigger as %s after crossing the switch fence",
		async (deliverAs) => {
			const compactStarted = gate();
			const compactRelease = gate();
			const handlerStarted = gate();
			const handlerRelease = gate();
			const responseStarted = gate();
			const responseRelease = gate();
			let h!: Harness;
			let handled = false;
			h = await setup({
				settings: {
					compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 },
					retry: { enabled: false },
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							compactStarted.release();
							await compactRelease.promise;
							return {
								compaction: {
									summary: "small summary",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
						pi.on("agent_settled", async () => {
							if (handled) return;
							handled = true;
							await h.session.sendCustomMessage(
								{ customType: "deferred", content: "deferred triggered input", display: true },
								{ triggerTurn: true, deliverAs },
							);
							handlerStarted.release();
							await handlerRelease.promise;
						});
					},
				],
			});
			h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
			h.sessionManager.appendMessage({ ...fauxAssistantMessage("old response"), timestamp: Date.now() - 1000 });
			h.session.refreshContext();
			h.setResponses([
				fauxAssistantMessage("initial response"),
				async () => {
					responseStarted.release();
					await responseRelease.promise;
					return fauxAssistantMessage("earlier waiter response");
				},
				fauxAssistantMessage("deferred response"),
			]);
			const initial = h.session.prompt("initial ordinary input").then(
				() => undefined,
				(error: unknown) => error,
			);
			let switching: Promise<void> | undefined;
			let waiter: Promise<void> | undefined;
			try {
				await handlerStarted.promise;
				switching = h.session.setModel(h.getModel("sol")!);
				await compactStarted.promise;
				waiter = h.session.sendCustomMessage(
					{ customType: "waiter", content: "earlier waiter input", display: true },
					{ triggerTurn: true },
				);
				handlerRelease.release();
				await new Promise<void>((resolve) => setImmediate(resolve));
				compactRelease.release();
				await switching;
				await responseStarted.promise;
				expect(await initial).toBeUndefined();
				expect(h.session.agent.state.isStreaming).toBe(true);
				expect(h.session.isStreaming).toBe(true);
				expect(h.session.isIdle).toBe(false);
				expect(h.eventsOfType("agent_settled")).toHaveLength(1);
				// Steering may already have transferred before the held provider call.
				expect(
					h.session.agent
						.peekQueuedMessages()
						.some((message) => message.role === "custom" && message.customType === "deferred") ||
						h.sessionManager
							.getEntries()
							.some((entry) => entry.type === "custom_message" && entry.customType === "deferred"),
				).toBe(true);
			} finally {
				handlerRelease.release();
				compactRelease.release();
				responseRelease.release();
				await initial;
				await switching;
				await waiter;
			}
			await h.session.waitForIdle();
			expect(h.eventsOfType("agent_settled")).toHaveLength(2);
			expect(
				h.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message")
					.map((entry) => entry.customType),
			).toEqual(["waiter", "deferred"]);
		},
	);

	it.each(["input", "before_agent_start"] as const)(
		"queues a triggered message behind a prompt admitted into %s before the switch",
		async (hook) => {
			const inputStarted = gate();
			const inputRelease = gate();
			const compactStarted = gate();
			const compactRelease = gate();
			const responseStarted = gate();
			const responseRelease = gate();
			const h = await setup({
				settings: {
					compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 },
					retry: { enabled: false },
				},
				extensionFactories: [
					(pi) => {
						if (hook === "input")
							pi.on("input", async () => {
								inputStarted.release();
								await inputRelease.promise;
								return { action: "continue" };
							});
						else
							pi.on("before_agent_start", async () => {
								inputStarted.release();
								await inputRelease.promise;
							});
						pi.on("session_before_compact", async (event) => {
							compactStarted.release();
							await compactRelease.promise;
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
			h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
			h.sessionManager.appendMessage({ ...fauxAssistantMessage("old response"), timestamp: Date.now() - 1000 });
			h.session.refreshContext();
			h.setResponses([
				async () => {
					responseStarted.release();
					await responseRelease.promise;
					return fauxAssistantMessage("prompt completed");
				},
				fauxAssistantMessage("trigger completed"),
			]);
			const promptResult = h.session.prompt("admitted prompt").then(
				() => undefined,
				(error: unknown) => error,
			);
			await inputStarted.promise;
			const switching = h.session.setModel(h.getModel("sol")!);
			await compactStarted.promise;
			inputRelease.release();
			// Let the admitted hook finish while compaction remains held. A late hook
			// used to remove the admission token and wait inside _runAgentPrompt.
			await new Promise<void>((resolve) => setImmediate(resolve));
			const triggerResult = h.session
				.sendCustomMessage(
					{ customType: "trigger", content: "triggered during switch", display: true },
					{ triggerTurn: true },
				)
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			try {
				compactRelease.release();
				await switching;
				await responseStarted.promise;
				expect(await triggerResult).toBeUndefined();
				expect(h.session.isStreaming).toBe(true);
				expect(h.eventsOfType("agent_settled")).toHaveLength(0);
			} finally {
				responseRelease.release();
			}
			expect(await promptResult).toBeUndefined();
			await h.session.waitForIdle();
			expect(h.eventsOfType("agent_settled")).toHaveLength(1);
			expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
			expect(
				h.session.messages.some(
					(message) => message.role === "user" && JSON.stringify(message.content).includes("admitted prompt"),
				),
			).toBe(true);
		},
	);
});
