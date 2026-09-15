import { type AssistantMessage, fauxAssistantMessage, type ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

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

describe("pre-prompt compaction regression", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("compacts length-stop overflow before a new prompt without continuing from an assistant message", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "pre-prompt summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "previous prompt" }],
			timestamp: now - 1000,
		});
		const lengthStopAssistant: AssistantMessage = {
			...fauxAssistantMessage("length-stop assistant response", { stopReason: "length", timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		};
		harness.sessionManager.appendMessage(lengthStopAssistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("answered next prompt")]);
		const continueSpy = vi.spyOn(harness.session.agent, "continue");

		await expect(harness.session.prompt("next prompt")).resolves.toBeUndefined();

		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(getUserTexts(harness)).toContain("next prompt");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it.each(["failed", "aborted"] as const)("retains unsent input after %s compaction", async (outcome) => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => ({
						action: "transform",
						text: `processed:${event.text}`,
						images: event.images,
					}));
					if (outcome === "aborted") pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({ role: "user", content: "previous prompt", timestamp: now - 1000 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("previous response", { timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(101),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const before = structuredClone(harness.sessionManager.getEntries());
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" })]);
		const beforeAgentStart = vi.spyOn(harness.session.extensionRunner, "emitBeforeAgentStart");
		const continueSpy = vi.spyOn(harness.session.agent, "continue");
		const queue = vi.spyOn(harness.session.agent, "followUp");
		const preflight = vi.fn();
		const images: ImageContent[] = [{ type: "image", data: "synthetic-image", mimeType: "image/png" }];

		await expect(
			harness.session.prompt("pending input", {
				images,
				streamingBehavior: "followUp",
				preflightResult: preflight,
			}),
		).rejects.toThrow("Input is retained in the followUp queue");

		expect(preflight).toHaveBeenCalledExactlyOnceWith(false);
		expect(harness.sessionManager.getEntries()).toEqual(before);
		expect(getUserTexts(harness)).not.toContain("processed:pending input");
		expect(harness.session.getFollowUpMessages()).toEqual(["processed:pending input"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(queue).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				role: "user",
				content: [{ type: "text", text: "processed:pending input" }, ...images],
			}),
		);
		expect(beforeAgentStart).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(outcome === "failed" ? 1 : 0);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			result: undefined,
			aborted: outcome === "aborted",
		});
	});
});
