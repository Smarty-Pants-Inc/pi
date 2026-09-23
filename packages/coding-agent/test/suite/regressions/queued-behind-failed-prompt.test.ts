import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// Input queued behind a prompt that is still in preflight must not wait for the next
// prompt when that preflight fails before it starts a run (Smarty-Pants-Inc/smarty-dev#244).
describe("input queued behind a prompt that fails before it starts", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each(["steer", "followUp"] as const)("delivers queued %s input without another prompt", async (mode) => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("earlier answer")]);
		await harness.session.prompt("earlier prompt");
		harness.setResponses([fauxAssistantMessage("queued answer")]);

		let queued: Promise<void> | undefined;
		vi.spyOn(harness.session.extensionRunner, "emitBeforeAgentStart").mockImplementationOnce(async () => {
			queued = harness.session.prompt("queued behind preflight", { streamingBehavior: mode });
			await queued;
			throw new Error("preflight failed");
		});

		await expect(harness.session.prompt("failing prompt")).rejects.toThrow("preflight failed");
		await expect(queued).resolves.toBeUndefined();
		await harness.session.waitForIdle();

		const userTexts = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
			);
		expect(userTexts).not.toContain("failing prompt");
		expect(userTexts.filter((text) => text === "queued behind preflight")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});
});
