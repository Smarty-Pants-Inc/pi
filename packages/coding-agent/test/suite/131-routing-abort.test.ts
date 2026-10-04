import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { VIRTUAL_MODEL_STATE_ENTRY } from "../../src/core/virtual-models.ts";
import { createHarness } from "./harness.ts";

// PR #131 P2-19: automatic compaction inherits raw originating-agent cancellation.
it("links routed automatic compaction to the originating agent signal", async () => {
	const entered = deferred();
	const release = deferred();
	let small = false;
	let compactionSignal!: AbortSignal;
	const harness = await createHarness({
		models: [
			{ id: "small", contextWindow: 1000 },
			{ id: "large", contextWindow: 50_000 },
		],
		settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
		extensionFactories: [
			(pi) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "auto",
					name: "auto",
					contextWindow: 50_000,
					route(_request, ctx) {
						return { model: ctx.modelRegistry.find("faux", small ? "small" : "large")!, thinkingLevel: "off" };
					},
				});
				pi.on("session_before_compact", async ({ signal, preparation: { firstKeptEntryId, tokensBefore } }) => {
					compactionSignal = signal;
					entered.resolve();
					await release.promise;
					return { compaction: { summary: "cancelled summary", firstKeptEntryId, tokensBefore } };
				});
			},
		],
	});
	try {
		await harness.session.setModel(harness.session.modelRuntime.getModel("router", "auto")!);
		harness.setResponses([fauxAssistantMessage("history".repeat(1500))]);
		await harness.session.prompt("first");
		small = true;
		const prompt = harness.session.prompt("next");
		await entered.promise;
		// Unlike session.abort(), this does not separately abort the compaction controller.
		harness.session.agent.abort();
		const cancelled = compactionSignal.aborted;
		release.resolve();
		await prompt;
		expect(cancelled).toBe(true);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toEqual([]);
	} finally {
		release.resolve();
		harness.cleanup();
	}
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// PR #131 P2-19: a router that ignores cancellation must not publish or compact.
it("fences a late route after prompt abort before state publication and automatic compaction", async () => {
	let release!: () => void;
	let entered!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const harness = await createHarness({
		models: [
			{ id: "small", contextWindow: 1000 },
			{ id: "large", contextWindow: 50_000 },
		],
		settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
		extensionFactories: [
			(pi) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "auto",
					name: "auto",
					contextWindow: 50_000,
					async route(_request, ctx) {
						entered();
						await pending;
						return {
							model: ctx.modelRegistry.find("faux", "small")!,
							thinkingLevel: "off",
							state: { late: true },
						};
					},
				});
				pi.on("session_before_compact", ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
					compaction: { summary: "must not run", firstKeptEntryId, tokensBefore },
				}));
			},
		],
	});
	try {
		harness.setResponses([fauxAssistantMessage("history".repeat(1500))]);
		await harness.session.setModel(harness.getModel("large")!);
		await harness.session.prompt("first");
		await harness.session.setModel(harness.session.modelRuntime.getModel("router", "auto")!);
		const prompt = harness.session.prompt("next");
		await started;
		const abort = harness.session.abort();
		release();
		await Promise.all([prompt, abort]);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY),
		).toEqual([]);
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.faux.state.callCount).toBe(1);
	} finally {
		release();
		harness.cleanup();
	}
});
