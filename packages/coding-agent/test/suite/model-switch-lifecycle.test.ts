import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

// Refs Smarty-Pants-Inc/pi#97: failure must hold in either preflight/switch completion order.
it.each(["insufficient", "cancelled"] as const)(
	"retains a trigger when switch %s precedes consumed input cleanup",
	async (failure) => {
		const inputStarted = gate(),
			inputRelease = gate(),
			responseRelease = gate();
		const h = await createHarness({
			models: [
				{ id: "opus", contextWindow: 100_000 },
				{ id: "sol", contextWindow: 16_000 },
			],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 },
				retry: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "consumed") return;
						inputStarted.release();
						await inputRelease.promise;
						return { action: "handled" };
					});
					pi.on("session_before_compact", (event) =>
						failure === "cancelled"
							? { cancel: true }
							: {
									compaction: {
										summary: "x".repeat(80_000),
										firstKeptEntryId: event.preparation.firstKeptEntryId,
										tokensBefore: event.preparation.tokensBefore,
									},
								},
					);
				},
			],
		});
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
		h.sessionManager.appendMessage({ ...fauxAssistantMessage("old"), timestamp: Date.now() - 1000 });
		h.session.refreshContext();
		h.setResponses([
			async () => {
				await responseRelease.promise;
				return fauxAssistantMessage("unexpected continuation");
			},
		]);
		const consumed = h.session.prompt("consumed");
		await inputStarted.promise;
		await h.session.sendCustomMessage(
			{ customType: "retained", content: "must wait for explicit recovery", display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		try {
			await expect(h.session.setModel(h.getModel("sol")!)).rejects.toThrow(/Current model unchanged/);
			expect(h.faux.state.callCount).toBe(0);
			inputRelease.release();
			await consumed;
			expect(h.session.isStreaming).toBe(false);
			expect(h.faux.state.callCount).toBe(0);
			expect(h.session.model?.id).toBe("opus");
			expect(h.session.agent.peekQueuedMessages()).toMatchObject([{ role: "custom", customType: "retained" }]);
			expect(h.eventsOfType("agent_settled")).toHaveLength(0);
			h.session.setAutoCompactionEnabled(false);
			h.setResponses([fauxAssistantMessage("recovered"), fauxAssistantMessage("followUp recovered")]);
			await h.session.prompt("explicit recovery");
			expect(h.session.agent.hasQueuedMessages()).toBe(false);
			expect(
				h.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message" && entry.customType === "retained"),
			).toHaveLength(1);
		} finally {
			inputRelease.release();
			responseRelease.release();
			await consumed;
			await h.session.waitForIdle();
			h.cleanup();
		}
	},
);

// Refs Smarty-Pants-Inc/pi#97: admission wake is not a true-idle notification.
it("waits for a successful switch's accepted trigger to finish before notifying idle", async () => {
	const compactStarted = gate(),
		compactRelease = gate(),
		responseStarted = gate(),
		responseRelease = gate();
	let h!: Harness;
	h = await createHarness({
		models: [
			{ id: "opus", contextWindow: 100_000 },
			{ id: "sol", contextWindow: 16_000 },
		],
		settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 }, retry: { enabled: false } },
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
				pi.on("session_compact", async () => {
					await h.session.sendCustomMessage(
						{ customType: "accepted-hook", content: "must be delivered", display: true },
						{ triggerTurn: true },
					);
				});
			},
		],
	});
	h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
	h.sessionManager.appendMessage({ ...fauxAssistantMessage("old"), timestamp: Date.now() - 1000 });
	h.session.refreshContext();
	h.setResponses([
		async () => {
			responseStarted.release();
			await responseRelease.promise;
			return fauxAssistantMessage("delivered");
		},
	]);
	const switching = h.session.setModel(h.getModel("sol")!);
	await compactStarted.promise;
	let observation: { idle: boolean; streaming: boolean; calls: number; persisted: number } | undefined;
	const idle = h.session.waitForIdle().then(() => {
		observation = {
			idle: h.session.isIdle,
			streaming: h.session.isStreaming,
			calls: h.faux.state.callCount,
			persisted: h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message").length,
		};
	});
	try {
		compactRelease.release();
		await switching;
		await responseStarted.promise;
		expect(observation).toBeUndefined();
		expect(h.session.isIdle).toBe(false);
		responseRelease.release();
		await idle;
		expect(observation).toEqual({ idle: true, streaming: false, calls: 1, persisted: 1 });
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
	} finally {
		compactRelease.release();
		responseRelease.release();
		await switching;
		await idle;
		await h.session.waitForIdle();
		h.cleanup();
	}
});

// Refs Smarty-Pants-Inc/pi#97, Astra round 4 P1: an external-only admission waiter owns pending delivery.
it.each(["steer", "followUp"] as const)(
	"waits for an external-only %s switch trigger's response before notifying true idle",
	async (deliverAs) => {
		const compactStarted = gate(),
			compactRelease = gate(),
			responseStarted = gate(),
			responseRelease = gate();
		const h = await createHarness({
			models: [
				{ id: "opus", contextWindow: 100_000 },
				{ id: "sol", contextWindow: 16_000 },
			],
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
		h.sessionManager.appendMessage({ ...fauxAssistantMessage("old"), timestamp: Date.now() - 1000 });
		h.session.refreshContext();
		h.setResponses([
			async (context, _options, _state, model) => {
				expect(model.id).toBe("sol");
				expect(JSON.stringify(context.messages)).toContain("external input");
				responseStarted.release();
				await responseRelease.promise;
				return fauxAssistantMessage("external delivered");
			},
		]);
		const switching = h.session.setModel(h.getModel("sol")!);
		await compactStarted.promise;
		let delivered = false;
		const waiter = h.session
			.sendCustomMessage(
				{ customType: "external", content: "external input", display: true, details: { deliverAs } },
				{ triggerTurn: true, deliverAs },
			)
			.then(() => {
				delivered = true;
			});
		let observation: { streaming: boolean; response: string | undefined } | undefined;
		const idle = h.session.waitForIdle().then(() => {
			observation = { streaming: h.session.isStreaming, response: h.session.getLastAssistantText() };
		});
		try {
			compactRelease.release();
			await switching;
			await responseStarted.promise;
			expect(observation).toBeUndefined();
			expect(delivered).toBe(false);
			expect(h.session.isIdle).toBe(false);
			responseRelease.release();
			await Promise.all([waiter, idle]);
			expect(observation).toEqual({ streaming: false, response: "external delivered" });
			expect(h.faux.state.callCount).toBe(1);
			expect(h.eventsOfType("agent_settled")).toHaveLength(1);
			expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toMatchObject([
				{ customType: "external", content: "external input", details: { deliverAs } },
			]);
		} finally {
			compactRelease.release();
			responseRelease.release();
			await Promise.all([switching, waiter, idle]);
			h.cleanup();
		}
	},
);

// Refs Smarty-Pants-Inc/pi#97, Astra round 4 P1: exercise session.abort(), not just abortCompaction().
it.each([
	["steer", "abort"],
	["followUp", "abort"],
	["steer", "cancelled"],
	["followUp", "cancelled"],
	["steer", "insufficient"],
	["followUp", "insufficient"],
] as const)("retains an external %s switch waiter without a run after %s", async (deliverAs, failure) => {
	const compactStarted = gate(),
		compactRelease = gate(),
		responseRelease = gate();
	const h = await createHarness({
		models: [
			{ id: "opus", contextWindow: 100_000 },
			{ id: "sol", contextWindow: 16_000 },
		],
		settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 }, retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					compactStarted.release();
					await compactRelease.promise;
					if (failure === "cancelled") return { cancel: true };
					return {
						compaction: {
							summary: failure === "insufficient" ? "x".repeat(80_000) : "small summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		],
	});
	h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
	h.sessionManager.appendMessage({ ...fauxAssistantMessage("old"), timestamp: Date.now() - 1000 });
	h.session.refreshContext();
	h.setResponses([
		async () => {
			await responseRelease.promise;
			return fauxAssistantMessage("unexpected continuation");
		},
	]);
	const switching = h.session.setModel(h.getModel("sol")!).catch((error: unknown) => error);
	await compactStarted.promise;
	const waiter = h.session.sendCustomMessage(
		{ customType: "external", content: "recover external input", display: true, details: { deliverAs } },
		{ triggerTurn: true, deliverAs },
	);
	const idle = h.session.waitForIdle();
	const aborted = failure === "abort" ? h.session.abort() : undefined;
	try {
		// Abort must settle even while preparation remains held; its late result cannot restart delivery.
		if (failure !== "abort") compactRelease.release();
		expect(await switching).toBeInstanceOf(Error);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(h.faux.state.callCount).toBe(0);
		await Promise.all([waiter, idle, aborted]);
		expect(h.session.isStreaming).toBe(false);
		expect(h.session.isIdle).toBe(true);
		expect(h.session.model?.id).toBe("opus");
		expect(h.eventsOfType("agent_settled")).toHaveLength(0);
		expect(h.session.agent.peekQueuedMessages()).toMatchObject([
			{ role: "custom", customType: "external", content: "recover external input", details: { deliverAs } },
		]);
		compactRelease.release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(h.faux.state.callCount).toBe(0);
		h.session.setAutoCompactionEnabled(false);
		h.setResponses([fauxAssistantMessage("recovered"), fauxAssistantMessage("followUp recovered")]);
		await h.session.prompt("explicit recovery");
		expect(h.faux.state.callCount).toBe(deliverAs === "steer" ? 1 : 2);
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toMatchObject([
			{ customType: "external", content: "recover external input", details: { deliverAs } },
		]);
	} finally {
		compactRelease.release();
		responseRelease.release();
		await Promise.all([switching, waiter, idle, aborted]);
		h.cleanup();
	}
});

// Refs Smarty-Pants-Inc/pi#97, Astra round 4 P1: settlement deferral is still pending external dispatch.
it.each(["deliver", "abort", "clear"] as const)(
	"keeps an external switch waiter owned through enclosing settlement (%s)",
	async (disposition) => {
		const compactStarted = gate(),
			compactRelease = gate(),
			selectStarted = gate(),
			selectRelease = gate(),
			responseStarted = gate(),
			responseRelease = gate();
		let h!: Harness;
		let switched = false;
		h = await createHarness({
			models: [
				{ id: "opus", contextWindow: 100_000 },
				{ id: "sol", contextWindow: 16_000 },
			],
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
						if (switched) return;
						switched = true;
						await h.session.setModel(h.getModel("sol")!);
					});
					pi.on("model_select", async () => {
						selectStarted.release();
						await selectRelease.promise;
					});
				},
			],
		});
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
		h.sessionManager.appendMessage({ ...fauxAssistantMessage("old"), timestamp: Date.now() - 1000 });
		h.session.refreshContext();
		h.setResponses([
			fauxAssistantMessage("initial"),
			async () => {
				responseStarted.release();
				await responseRelease.promise;
				return fauxAssistantMessage("external delivered");
			},
		]);
		const main = h.session.prompt("initial input");
		await compactStarted.promise;
		const waiter = h.session.sendCustomMessage(
			{ customType: "external", content: "external input", display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		let notified = false;
		const idle = h.session.waitForIdle().then(() => {
			notified = true;
		});
		try {
			compactRelease.release();
			await selectStarted.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(h.session.isIdle).toBe(false);
			expect(notified).toBe(false);
			expect(h.faux.state.callCount).toBe(1);
			if (disposition === "deliver") {
				selectRelease.release();
				await responseStarted.promise;
				expect(notified).toBe(false);
				expect(h.session.isStreaming).toBe(true);
				responseRelease.release();
				await Promise.all([waiter, idle, main]);
				expect(h.session.getLastAssistantText()).toBe("external delivered");
				expect(h.faux.state.callCount).toBe(2);
			} else {
				if (disposition === "abort") await h.session.abort();
				else h.session.clearQueue();
				await idle;
				expect(h.session.agent.peekQueuedMessages()).toHaveLength(disposition === "abort" ? 1 : 0);
				selectRelease.release();
				await Promise.all([waiter, main]);
				expect(h.faux.state.callCount).toBe(1);
			}
		} finally {
			compactRelease.release();
			selectRelease.release();
			responseRelease.release();
			await Promise.all([main, waiter, idle]);
			h.cleanup();
		}
	},
);

// Refs Smarty-Pants-Inc/pi#97, Astra round 5 P1: the enclosing handler actually awaits its send.
it.each(
	(
		[
			["steer", "deliver"],
			["followUp", "deliver"],
			["steer", "cancelled"],
			["followUp", "cancelled"],
			["steer", "insufficient"],
			["followUp", "insufficient"],
			["steer", "abort"],
			["followUp", "abort"],
			["steer", "abort after commit"],
			["followUp", "abort after commit"],
		] as const
	).flatMap(([deliverAs, disposition]) => [
		[deliverAs, disposition, false] as const,
		[deliverAs, disposition, true] as const,
	]),
)(
	"accepts an awaited settled %s switch trigger without deadlock (%s, external: %s)",
	async (deliverAs, disposition, withExternal) => {
		const handlerStarted = gate(),
			handlerRelease = gate(),
			sendReturned = gate(),
			handlerEndRelease = gate(),
			compactStarted = gate(),
			compactRelease = gate(),
			responseStarted = gate(),
			responseRelease = gate();
		let h!: Harness;
		let handled = false;
		let handlerReturned = false;
		let mainReturned = false;
		let idleNotified = false;
		let idlePersisted: number | undefined;
		let externalReturned = false;
		h = await createHarness({
			models: [
				{ id: "opus", contextWindow: 100_000 },
				{ id: "sol", contextWindow: 16_000 },
			],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 },
				retry: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						if (handled) return;
						handled = true;
						handlerStarted.release();
						await handlerRelease.promise;
						await h.session.sendCustomMessage(
							{ customType: "settled", content: "awaited settled input", display: true, details: { deliverAs } },
							{ triggerTurn: true, deliverAs },
						);
						sendReturned.release();
						await handlerEndRelease.promise;
						handlerReturned = true;
					});
					pi.on("session_before_compact", async (event) => {
						compactStarted.release();
						await compactRelease.promise;
						if (disposition === "cancelled") return { cancel: true };
						return {
							compaction: {
								summary: disposition === "insufficient" ? "x".repeat(80_000) : "small summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
		h.sessionManager.appendMessage({ ...fauxAssistantMessage("old"), timestamp: Date.now() - 1000 });
		h.session.refreshContext();
		h.setResponses([
			fauxAssistantMessage("initial"),
			async () => {
				responseStarted.release();
				await responseRelease.promise;
				return fauxAssistantMessage("delivered");
			},
			fauxAssistantMessage("followUp delivered"),
		]);
		const main = h.session.prompt("initial input").then(() => {
			mainReturned = true;
		});
		// Observe even a broken implementation's detached rejection during test cleanup.
		void main.catch(() => {});
		await handlerStarted.promise;
		const switching = h.session.setModel(h.getModel("sol")!).catch((error: unknown) => error);
		await compactStarted.promise;
		// Same settlement, different async origin: this caller must still await delivery.
		const external = withExternal
			? h.session
					.sendCustomMessage(
						{ customType: "external", content: "external input", display: true },
						{ triggerTurn: true },
					)
					.then(() => {
						externalReturned = true;
					})
			: undefined;
		void external?.catch(() => {});
		const idle = h.session.waitForIdle().then(() => {
			idleNotified = true;
			idlePersisted = h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message").length;
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			handlerRelease.release();
			await new Promise<void>((resolve) => setImmediate(resolve));
			let aborted = disposition === "abort" ? h.session.abort() : undefined;
			if (disposition !== "abort") compactRelease.release();
			const result = await switching;
			if (disposition === "deliver" || disposition === "abort after commit") expect(result).toBeUndefined();
			else expect(result).toBeInstanceOf(Error);
			const accepted = await Promise.race([
				sendReturned.promise.then(() => true),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), 1000);
				}),
			]);
			expect(accepted, "settlement handler must await acceptance, not its own deferred delivery").toBe(true);
			expect(handlerReturned).toBe(false);
			expect(mainReturned).toBe(false);
			expect(externalReturned).toBe(false);
			if (disposition === "abort after commit") {
				aborted = h.session.abort();
				const abortReturned = await Promise.race([
					aborted.then(() => true),
					new Promise<boolean>((resolve) => {
						clearTimeout(timer);
						timer = setTimeout(() => resolve(false), 1000);
					}),
				]);
				expect(abortReturned, "abort must retain accepted input without awaiting the held settlement handler").toBe(
					true,
				);
			}
			if (disposition === "deliver") expect(idleNotified).toBe(false);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(h.faux.state.callCount).toBe(1);
			expect(handlerReturned).toBe(false);
			if (disposition === "deliver") {
				expect(idleNotified).toBe(false);
				expect(externalReturned).toBe(false);
			}
			handlerEndRelease.release();
			if (disposition === "deliver") {
				await responseStarted.promise;
				expect(handlerReturned).toBe(true);
				expect(idleNotified).toBe(false);
				expect(externalReturned).toBe(false);
				expect(h.session.isIdle).toBe(false);
				responseRelease.release();
			} else {
				await aborted;
			}
			await Promise.all([main, external, idle]);
			expect(handlerReturned).toBe(true);
			expect(mainReturned).toBe(true);
			expect(h.session.isSettling).toBe(false);
			expect(h.session.isIdle).toBe(true);
			expect(h.session.model?.id).toBe(
				disposition === "deliver" || disposition === "abort after commit" ? "sol" : "opus",
			);
			expect(idlePersisted).toBe(disposition === "deliver" ? (withExternal ? 2 : 1) : 0);
			if (disposition === "deliver") {
				expect(h.session.getLastAssistantText()).toBe(withExternal ? "followUp delivered" : "delivered");
			}
			if (disposition !== "deliver") {
				expect(h.faux.state.callCount).toBe(1);
				expect(h.eventsOfType("agent_settled")).toHaveLength(1);
				// peekQueuedMessages previews one selected queue item, not the whole retained backlog.
				expect(h.session.agent.peekQueuedMessages()).toMatchObject([
					withExternal
						? { customType: "external", content: "external input" }
						: { customType: "settled", content: "awaited settled input", details: { deliverAs } },
				]);
				expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(0);
				compactRelease.release();
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(h.faux.state.callCount).toBe(1);
			}
			// A following explicit prompt remains usable and recovers retained input exactly once.
			h.session.setAutoCompactionEnabled(false);
			h.setResponses([fauxAssistantMessage("next response"), fauxAssistantMessage("recovered followUp")]);
			await h.session.prompt("next explicit input");
			expect(["next response", "recovered followUp"]).toContain(h.session.getLastAssistantText());
			expect(h.eventsOfType("agent_settled").every((event) => event.outcome === "completed")).toBe(true);
			expect(h.session.agent.hasQueuedMessages()).toBe(false);
			for (const customType of withExternal ? ["settled", "external"] : ["settled"]) {
				expect(
					h.sessionManager
						.getEntries()
						.filter((entry) => entry.type === "custom_message" && entry.customType === customType),
				).toHaveLength(1);
			}
			expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toMatchObject([
				...(withExternal ? [{ customType: "external", content: "external input" }] : []),
				{ customType: "settled", content: "awaited settled input", details: { deliverAs } },
			]);
		} finally {
			clearTimeout(timer);
			handlerRelease.release();
			handlerEndRelease.release();
			compactRelease.release();
			responseRelease.release();
			h.session.abortCompaction();
			await switching;
			// Do not await circularly blocked main/external promises when exercising RED.
			h.cleanup();
		}
	},
);

// Refs Smarty-Pants-Inc/pi#97: every preflight drain must respect enclosing settlement hooks.
it("defers consumed-preflight trigger dispatch until enclosing settled model-select returns", async () => {
	const inputStarted = gate(),
		inputRelease = gate(),
		selectStarted = gate(),
		selectRelease = gate(),
		responseStarted = gate(),
		responseRelease = gate();
	let h!: Harness;
	let switched = false;
	let inSelect = false;
	const trace: string[] = [];
	h = await createHarness({
		models: [
			{ id: "opus", contextWindow: 100_000 },
			{ id: "sol", contextWindow: 16_000 },
		],
		settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 }, retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text === "consumed") {
						inputStarted.release();
						await inputRelease.promise;
						return { action: "handled" };
					}
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
						{ customType: "hook", content: "trigger", display: true },
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
				pi.on("model_select", async () => {
					inSelect = true;
					trace.push("select begins");
					selectStarted.release();
					await selectRelease.promise;
					inSelect = false;
					trace.push("select returns");
				});
				pi.on("agent_start", () => {
					trace.push(inSelect ? "run starts inside select" : "run starts");
				});
			},
		],
	});
	h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
	h.sessionManager.appendMessage({ ...fauxAssistantMessage("old"), timestamp: Date.now() - 1000 });
	h.session.refreshContext();
	const consumed = h.session.prompt("consumed", { streamingBehavior: "steer" });
	await inputStarted.promise;
	h.setResponses([
		fauxAssistantMessage("initial"),
		async () => {
			responseStarted.release();
			await responseRelease.promise;
			return fauxAssistantMessage("hook response");
		},
	]);
	const main = h.session.prompt("initial");
	try {
		await selectStarted.promise;
		inputRelease.release();
		await consumed;
		expect(trace).toEqual(["run starts", "settled begins", "select begins"]);
		expect(h.faux.state.callCount).toBe(1);
		selectRelease.release();
		await responseStarted.promise;
		expect(trace).toEqual([
			"run starts",
			"settled begins",
			"select begins",
			"select returns",
			"settled returns",
			"run starts",
		]);
	} finally {
		inputRelease.release();
		selectRelease.release();
		responseRelease.release();
		await Promise.all([consumed, main]);
		await h.session.waitForIdle();
		h.cleanup();
	}
	expect(h.faux.state.callCount).toBe(2);
	expect(h.eventsOfType("agent_settled")).toHaveLength(2);
});

// Refs Smarty-Pants-Inc/pi#97: clearing an accepted held trigger must release true-idle waiters.
it("notifies idle after a held preflight trigger is explicitly cleared", async () => {
	const inputStarted = gate();
	const inputRelease = gate();
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("input", async () => {
					inputStarted.release();
					await inputRelease.promise;
					return { action: "handled" };
				});
			},
		],
	});
	const prompt = h.session.prompt("consumed input");
	await inputStarted.promise;
	await h.session.sendCustomMessage(
		{ customType: "cleared", content: "must not run", display: true },
		{ triggerTurn: true },
	);
	expect(h.session.isIdle).toBe(false);
	let notified = false;
	const idle = h.session.waitForIdle().then(() => {
		notified = true;
	});
	try {
		h.session.clearQueue();
		await new Promise<void>((resolve) => setImmediate(resolve));
		// smarty-dev#3048: clearing queues cannot hide an earlier input admission.
		expect(h.session.isIdle).toBe(false);
		expect(notified).toBe(false);
		inputRelease.release();
		await prompt;
		expect(h.session.isIdle).toBe(true);
		expect(notified).toBe(true);
		await idle;
		expect(h.faux.state.callCount).toBe(0);
	} finally {
		inputRelease.release();
		await prompt;
		h.cleanup();
	}
});
