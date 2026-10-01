import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

// Refs Smarty-Pants-Inc/pi#97, Astra round 2 P2 queue review.
describe("model switch hook queue ownership (#97)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()!.cleanup();
	});

	function expectPersisted(h: Harness, customType: string): void {
		const expected = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === customType);
		expect(expected).toHaveLength(1);
		const jsonl = readFileSync(h.session.sessionFile!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as SessionEntry);
		expect(jsonl.filter((entry) => entry.type === "custom_message" && entry.customType === customType)).toEqual(
			expected,
		);
		const reopened = SessionManager.open(h.session.sessionFile!);
		expect(
			reopened.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === customType),
		).toEqual(expected);
	}

	async function setup(extensionFactories: HarnessOptions["extensionFactories"]): Promise<Harness> {
		const h = await createHarness({
			persistSession: true,
			models: [
				{ id: "opus", contextWindow: 100_000 },
				{ id: "sol", contextWindow: 16_000 },
			],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 },
				retry: { enabled: false },
			},
			extensionFactories,
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
		h.sessionManager.appendMessage({ ...fauxAssistantMessage("old response"), timestamp: Date.now() - 1000 });
		h.session.refreshContext();
		return h;
	}

	it.each([
		["steer", "set"],
		["followUp", "set"],
		["steer", "cycle"],
		["followUp", "cycle"],
		["steer", "scoped cycle"],
		["followUp", "scoped cycle"],
	] as const)("drains a %s trigger after consumed input ends during %s compaction", async (deliverAs, route) => {
		const inputStarted = gate();
		const inputRelease = gate();
		const compactStarted = gate();
		const compactRelease = gate();
		const h = await setup([
			(pi) => {
				pi.on("input", async () => {
					inputStarted.release();
					await inputRelease.promise;
					return { action: "handled" };
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
		]);
		h.setResponses([
			(_context, _options, _state, model) => {
				expect(model.id).toBe("sol");
				return fauxAssistantMessage("trigger delivered");
			},
		]);
		const prompt = h.session.prompt("consumed input");
		await inputStarted.promise;
		await h.session.sendCustomMessage(
			{ customType: "trigger", content: "retained trigger", display: true, details: { deliverAs } },
			{ triggerTurn: true, deliverAs },
		);
		if (route === "scoped cycle") h.session.setScopedModels(h.models.map((model) => ({ model })));
		const switching = route === "set" ? h.session.setModel(h.getModel("sol")!) : h.session.cycleModel();
		try {
			await compactStarted.promise;
			inputRelease.release();
			await prompt;
			expect(h.session.isPromptPending).toBe(false);
			expect(h.session.isIdle).toBe(false);
			expect(h.faux.state.callCount).toBe(0);
		} finally {
			inputRelease.release();
			compactRelease.release();
			await Promise.all([prompt, switching]);
		}
		await h.session.waitForIdle();
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toMatchObject([
			{ customType: "trigger", content: "retained trigger", details: { deliverAs } },
		]);
		expect(h.session.getLastAssistantText()).toBe("trigger delivered");
		expectPersisted(h, "trigger");
	});

	it.each(["steer", "followUp"] as const)(
		"accepts an actually awaited SDK %s trigger from session_compact without awaiting its own fence",
		async (deliverAs) => {
			let h!: Harness;
			let hookReturned = false;
			let hookState: { model: string | undefined; calls: number } | undefined;
			h = await setup([
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "small summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("session_compact", async () => {
						await h.session.sendCustomMessage(
							{ customType: "hook", content: "awaited hook trigger", display: true, details: { deliverAs } },
							{ triggerTurn: true, deliverAs },
						);
						hookReturned = true;
						hookState = { model: h.session.model?.id, calls: h.faux.state.callCount };
					});
				},
			]);
			h.setResponses([
				(context, _options, _state, model) => {
					expect(model.id).toBe("sol");
					expect(JSON.stringify(context.messages)).toContain("awaited hook trigger");
					return fauxAssistantMessage("hook delivered");
				},
			]);
			const switching = h.session.setModel(h.getModel("sol")!).then(
				() => true,
				() => false,
			);
			let timer: ReturnType<typeof setTimeout> | undefined;
			let completed = false;
			try {
				completed = await Promise.race([
					switching,
					new Promise<boolean>((resolve) => {
						timer = setTimeout(() => resolve(false), 1000);
					}),
				]);
			} finally {
				clearTimeout(timer);
				if (!completed) h.session.abortCompaction();
				await switching;
				await h.session.waitForIdle();
			}
			expect(completed, "the switch must not wait on a hook waiting on the same switch").toBe(true);
			expect(hookReturned).toBe(true);
			expect(hookState).toEqual({ model: "opus", calls: 0 });
			expect(h.session.getLastAssistantText()).toBe("hook delivered");
			expect(h.session.model?.id).toBe("sol");
			expect(h.faux.state.callCount).toBe(1);
			expect(h.eventsOfType("agent_settled")).toHaveLength(1);
			expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toMatchObject([
				{ customType: "hook", content: "awaited hook trigger", details: { deliverAs } },
			]);
			expectPersisted(h, "hook");
		},
	);
	it.each(["steer", "followUp"] as const)(
		"keeps an admitted input as the owner of a %s hook trigger",
		async (deliverAs) => {
			const inputStarted = gate();
			const inputRelease = gate();
			let h!: Harness;
			const inputs: string[] = [];
			h = await setup([
				(pi) => {
					pi.on("input", async (event) => {
						inputs.push(event.text);
						inputStarted.release();
						await inputRelease.promise;
						return { action: "transform", text: "transformed admitted input" };
					});
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "small summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("session_compact", async () => {
						await h.session.sendCustomMessage(
							{ customType: "hook", content: "hook trigger", display: true },
							{ triggerTurn: true, deliverAs },
						);
					});
				},
			]);
			h.setResponses([fauxAssistantMessage("prompt response"), fauxAssistantMessage("followUp response")]);
			const prompt = h.session.prompt("original input");
			await inputStarted.promise;
			try {
				await h.session.setModel(h.getModel("sol")!);
				expect(h.faux.state.callCount).toBe(0);
			} finally {
				inputRelease.release();
				await prompt;
			}
			await h.session.waitForIdle();
			expect(inputs).toEqual(["original input"]);
			expect(h.eventsOfType("agent_settled")).toHaveLength(1);
			expect(h.faux.state.callCount).toBe(deliverAs === "steer" ? 1 : 2);
			const entries = h.sessionManager.getEntries();
			const user = entries.findIndex(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes("transformed admitted input"),
			);
			const hook = entries.findIndex((entry) => entry.type === "custom_message" && entry.customType === "hook");
			const response = entries.findIndex(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message.content).includes("prompt response"),
			);
			expect(user).toBeGreaterThan(-1);
			expect(hook).toBeGreaterThan(user);
			expect(deliverAs === "steer" ? hook < response : hook > response).toBe(true);
			expectPersisted(h, "hook");
		},
	);

	it.each(["steer", "followUp"] as const)(
		"retains a %s trigger without a run after failed or cancelled switch cleanup",
		async (deliverAs) => {
			for (const failure of ["insufficient", "cancelled"] as const) {
				let h!: Harness;
				h = await setup([
					(pi) => {
						pi.on("session_before_compact", (event) => ({
							compaction: {
								summary: failure === "insufficient" ? "x".repeat(80_000) : "small summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
						pi.on("session_compact", async () => {
							await h.session.sendCustomMessage(
								{ customType: "retained", content: "recoverable hook", display: true },
								{ triggerTurn: true, deliverAs },
							);
							if (failure === "cancelled") h.session.abortCompaction();
						});
					},
				]);
				await expect(h.session.setModel(h.getModel("sol")!)).rejects.toThrow(/Current model unchanged/);
				await h.session.waitForIdle();
				expect(h.session.model?.id).toBe("opus");
				expect(h.faux.state.callCount).toBe(0);
				expect(h.eventsOfType("agent_settled")).toHaveLength(0);
				expect(h.session.agent.peekQueuedMessages()).toMatchObject([{ role: "custom", customType: "retained" }]);
				h.session.setAutoCompactionEnabled(false);
				h.setResponses([fauxAssistantMessage("recovered"), fauxAssistantMessage("followUp recovered")]);
				await h.session.prompt("explicit recovery");
				expect(h.session.agent.hasQueuedMessages()).toBe(false);
				expectPersisted(h, "retained");
			}
		},
	);

	it("keeps nextTurn and context-only hook messages out of the triggered turn", async () => {
		let h!: Harness;
		h = await setup([
			(pi) => {
				pi.on("session_before_compact", (event) => ({
					compaction: {
						summary: "small summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
				pi.on("session_compact", async () => {
					await h.session.sendCustomMessage(
						{ customType: "context", content: "context only", display: false },
						{ triggerTurn: false },
					);
					await h.session.sendCustomMessage(
						{ customType: "aside", content: "nextTurn aside", display: false },
						{ triggerTurn: true, deliverAs: "nextTurn" },
					);
					await h.session.sendCustomMessage(
						{ customType: "hook", content: "hook trigger", display: true },
						{ triggerTurn: true },
					);
				});
			},
		]);
		const contexts: string[] = [];
		h.setResponses([
			(context) => {
				contexts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("trigger response");
			},
			(context) => {
				contexts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("user response");
			},
		]);
		await h.session.setModel(h.getModel("sol")!);
		await h.session.waitForIdle();
		expect(h.faux.state.callCount).toBe(1);
		expect(contexts[0]).toContain("context only");
		expect(contexts[0]).not.toContain("nextTurn aside");
		await h.session.prompt("next user input");
		expect(contexts[1]).toContain("nextTurn aside");
		for (const customType of ["context", "aside", "hook"]) expectPersisted(h, customType);
	});

	it("does not dispatch a hook trigger before enclosing settled handlers return", async () => {
		let h!: Harness;
		let switched = false;
		const trace: string[] = [];
		h = await setup([
			(pi) => {
				pi.on("session_before_compact", (event) => ({
					compaction: {
						summary: "small summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
				pi.on("session_compact", async () => {
					await h.session.sendCustomMessage(
						{ customType: "settled-hook", content: "hook trigger", display: true },
						{ triggerTurn: true },
					);
				});
				pi.on("agent_settled", async () => {
					if (switched) return;
					switched = true;
					trace.push("settled begins");
					await h.session.setModel(h.getModel("sol")!);
					trace.push("settled returns");
				});
				pi.on("agent_start", () => {
					trace.push("run starts");
				});
			},
		]);
		h.setResponses([fauxAssistantMessage("initial response"), fauxAssistantMessage("hook response")]);
		await h.session.prompt("initial input");
		await h.session.waitForIdle();
		expect(trace).toEqual(["run starts", "settled begins", "settled returns", "run starts"]);
		expect(h.eventsOfType("agent_settled")).toHaveLength(2);
		expectPersisted(h, "settled-hook");
	});
	it.each(["steer", "followUp"] as const)(
		"queues a %s hook trigger into an earlier switch waiter's run",
		async (deliverAs) => {
			const compactStarted = gate();
			const compactRelease = gate();
			const responseStarted = gate();
			const responseRelease = gate();
			let h!: Harness;
			h = await setup([
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
					pi.on("session_compact", async () => {
						await h.session.sendCustomMessage(
							{ customType: "hook", content: "hook trigger", display: true },
							{ triggerTurn: true, deliverAs },
						);
					});
				},
			]);
			h.setResponses([
				async () => {
					responseStarted.release();
					await responseRelease.promise;
					return fauxAssistantMessage("waiter response");
				},
				fauxAssistantMessage("followUp response"),
			]);
			const switching = h.session.setModel(h.getModel("sol")!);
			await compactStarted.promise;
			const waiter = h.session.sendCustomMessage(
				{ customType: "waiter", content: "earlier switch waiter", display: true },
				{ triggerTurn: true },
			);
			try {
				compactRelease.release();
				await switching;
				await responseStarted.promise;
				expect(h.session.isStreaming).toBe(true);
				expect(h.eventsOfType("agent_settled")).toHaveLength(0);
			} finally {
				compactRelease.release();
				responseRelease.release();
				await Promise.all([switching, waiter]);
			}
			await h.session.waitForIdle();
			expect(h.eventsOfType("agent_settled")).toHaveLength(1);
			expect(h.faux.state.callCount).toBe(deliverAs === "steer" ? 1 : 2);
			expect(
				h.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message")
					.map((entry) => entry.customType),
			).toEqual(["waiter", "hook"]);
			expectPersisted(h, "hook");
		},
	);

	it.each(["steer", "followUp"] as const)(
		"retains a consumed-preflight %s trigger when its switch fails or is cancelled",
		async (deliverAs) => {
			for (const failure of ["insufficient", "cancelled"] as const) {
				const inputStarted = gate();
				const inputRelease = gate();
				const compactStarted = gate();
				const compactRelease = gate();
				const h = await setup([
					(pi) => {
						pi.on("input", async (event) => {
							if (event.text !== "consumed input") return;
							inputStarted.release();
							await inputRelease.promise;
							return { action: "handled" };
						});
						pi.on("session_before_compact", async (event) => {
							compactStarted.release();
							await compactRelease.promise;
							return failure === "cancelled"
								? { cancel: true }
								: {
										compaction: {
											summary: "x".repeat(80_000),
											firstKeptEntryId: event.preparation.firstKeptEntryId,
											tokensBefore: event.preparation.tokensBefore,
										},
									};
						});
					},
				]);
				const prompt = h.session.prompt("consumed input");
				await inputStarted.promise;
				await h.session.sendCustomMessage(
					{ customType: "retained", content: "retained preflight", display: true },
					{ triggerTurn: true, deliverAs },
				);
				const switching = h.session.setModel(h.getModel("sol")!).then(
					() => undefined,
					(error: unknown) => error,
				);
				try {
					await compactStarted.promise;
					inputRelease.release();
					await prompt;
				} finally {
					inputRelease.release();
					compactRelease.release();
					await Promise.all([prompt, switching]);
				}
				expect(await switching).toBeInstanceOf(Error);
				await h.session.waitForIdle();
				expect(h.faux.state.callCount).toBe(0);
				expect(h.session.model?.id).toBe("opus");
				expect(h.session.agent.peekQueuedMessages()).toMatchObject([{ role: "custom", customType: "retained" }]);
				h.session.setAutoCompactionEnabled(false);
				h.setResponses([fauxAssistantMessage("recovered"), fauxAssistantMessage("followUp recovered")]);
				await h.session.prompt("explicit recovery");
				expect(h.eventsOfType("agent_settled")).toHaveLength(1);
				expectPersisted(h, "retained");
			}
		},
	);
});
