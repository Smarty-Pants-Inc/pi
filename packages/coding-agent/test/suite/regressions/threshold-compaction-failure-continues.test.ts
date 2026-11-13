import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

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

describe("automatic compaction failure continuation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("continues after a failed threshold compaction and delivers its queued follow-up", async () => {
		let harness: Harness;
		let failSummary = false;
		let queued = false;
		const harnessPromise = createHarness({
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 1000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 98_500 },
				retry: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						if (!queued) {
							queued = true;
							await harness.session.followUp("queued after threshold failure");
						}
						failSummary = true;
					});
					pi.on("session_compact_failed", () => {
						failSummary = false;
					});
				},
			],
		});
		harness = await harnessPromise;
		harnesses.push(harness);

		const model = harness.getModel();
		const olderAssistant: AssistantMessage = {
			...fauxAssistantMessage("older answer", { timestamp: Date.now() - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		};
		harness.sessionManager.appendMessage({ role: "user", content: "older request", timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage(olderAssistant);
		harness.session.refreshContext();

		const originalStreamFunction = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (...args) => {
			if (failSummary) throw new Error("summary generator unavailable");
			return originalStreamFunction(...args);
		};
		const firstResponse: AssistantMessage = fauxAssistantMessage("first turn completed");
		harness.setResponses([firstResponse, fauxAssistantMessage("queued follow-up answered")]);

		await harness.session.prompt(`start threshold run ${"x".repeat(500)}`);

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: expect.stringContaining("Auto-compaction failed"),
		});
		expect(getUserTexts(harness)).toContain("queued after threshold failure");
		expect(getAssistantTexts(harness)).toContain("first turn completed");
		expect(getAssistantTexts(harness)).toContain("queued follow-up answered");
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("ends visibly after failed overflow recovery without delivering queued work", async () => {
		let harness: Harness;
		let failSummary = false;
		const harnessPromise = createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
				retry: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						await harness.session.followUp("queued after overflow failure");
						failSummary = true;
					});
					pi.on("session_compact_failed", () => {
						failSummary = false;
					});
				},
			],
		});
		harness = await harnessPromise;
		harnesses.push(harness);

		const originalStreamFunction = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (...args) => {
			if (failSummary) throw new Error("summary generator unavailable");
			return originalStreamFunction(...args);
		};
		const overflow = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "context window exceeded",
		});
		overflow.recovery = { recovery: "context_length_exceeded", retryable: false };
		harness.setResponses([overflow, fauxAssistantMessage("must not run")]);

		await harness.session.prompt("overflowing request");

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: expect.stringContaining("Context overflow recovery failed"),
		});
		expect(getUserTexts(harness)).not.toContain("queued after overflow failure");
		expect(harness.session.getFollowUpMessages()).toEqual(["queued after overflow failure"]);
		expect(harness.faux.state.callCount).toBe(1);
	});
});
