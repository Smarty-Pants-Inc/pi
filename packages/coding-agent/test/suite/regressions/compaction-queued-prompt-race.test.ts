import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// Input queued during pre-prompt compaction is flushed at compaction_end while the
// triggering prompt is still in preflight. It must join that run, not race it
// (earendil-works/pi#5886, #6820).
describe("queued input after pre-prompt compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each(["steer", "followUp"] as const)("delivers %s input flushed at compaction_end exactly once", async (mode) => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		const now = Date.now();
		harness.sessionManager.appendMessage({ role: "user", content: "previous prompt", timestamp: now - 1000 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("previous response", { timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(101),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);

		// What InteractiveMode.flushCompactionQueue does for the first queued message.
		let queued: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.result && !queued) {
				queued = harness.session.prompt("queued during compaction", { streamingBehavior: mode });
			}
		});

		await harness.session.prompt("triggering prompt");
		await expect(queued).resolves.toBeUndefined();
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: false });
		// Later threshold compaction may summarize these turns, so read the persisted transcript.
		const userTexts = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
			);
		expect(userTexts.filter((text) => text === "triggering prompt")).toHaveLength(1);
		expect(userTexts.filter((text) => text === "queued during compaction")).toHaveLength(1);
		expect(userTexts.indexOf("triggering prompt")).toBeLessThan(userTexts.indexOf("queued during compaction"));
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.isIdle).toBe(true);
	});
});
