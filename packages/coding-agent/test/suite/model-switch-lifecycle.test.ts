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
