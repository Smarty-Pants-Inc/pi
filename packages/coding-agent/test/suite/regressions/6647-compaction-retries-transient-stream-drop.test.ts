import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCompaction } from "../../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression for #6647: compaction runs a single non-retried summarization call, so a
 * transient mid-stream socket death (`terminated`) failed the whole compaction.
 * Compaction retains transient retry through the existing classifier/backoff,
 * but now has one operation-wide retry independent of ordinary settings.retry.
 * Aborts and non-retryable errors remain terminal.
 */
describe("#6647 compaction retries transient summarization failures", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

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

	function seedCompactableSession(harness: Harness): void {
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		const model = harness.getModel();
		const assistant: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "stop", timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		};
		assistant.content = [{ type: "text", text: "assistant response to compact" }];
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	}

	/** streamFn that responds with the given sequence of assistant messages across calls. */
	function useScriptedStreamFn(harness: Harness, script: AssistantMessage[]): () => number {
		let callCount = 0;
		const streamFunction: StreamFn = (model) => {
			const message = script[callCount] ?? script[script.length - 1]!;
			callCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const response = { ...message, api: model.api, provider: model.provider, model: model.id };
				if (response.stopReason === "pending") {
					const error: AssistantMessage = {
						...response,
						stopReason: "error",
						errorMessage: "Scripted response ended without a stop reason",
					};
					stream.push({ type: "error", reason: "error", error });
				} else if (response.stopReason === "error" || response.stopReason === "aborted") {
					stream.push({ type: "error", reason: response.stopReason, error: response });
				} else {
					stream.push({ type: "done", reason: response.stopReason, message: response });
				}
			});
			return stream;
		};
		harness.session.agent.streamFunction = streamFunction;
		return () => callCount;
	}

	it("retries a transient `terminated` summarization error and compacts successfully", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } });

		const model = harness.getModel();
		const error = (errorMessage: string): AssistantMessage => ({
			...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			usage: createUsage(10),
		});
		const success: AssistantMessage = {
			...fauxAssistantMessage("recovered summary"),
			usage: createUsage(10),
		};
		expect(
			prepareCompaction(harness.sessionManager.getBranch(), harness.settingsManager.getCompactionSettings(model)),
		).toMatchObject({
			isSplitTurn: true,
			messagesToSummarize: [],
			turnPrefixMessages: [expect.objectContaining({ role: "user" })],
		});
		const getCallCount = useScriptedStreamFn(harness, [error("terminated"), success]);
		vi.useFakeTimers();
		const compaction = harness.session.compact();
		await vi.advanceTimersByTimeAsync(2000);
		const result = await compaction;

		expect(result.summary).toContain("recovered summary");
		expect(getCallCount()).toBe(2); // 1 prefix-summary attempt + 1 compaction retry
		const starts = harness.eventsOfType("summarization_retry_scheduled");
		const ends = harness.eventsOfType("summarization_retry_finished");
		expect(starts).toHaveLength(1);
		expect(ends).toHaveLength(1);
		expect(starts[0]).toMatchObject({ attempt: 1, maxAttempts: 1, delayMs: 2000, errorMessage: "terminated" });
		expect(ends[0]).toMatchObject({ type: "summarization_retry_finished" });
		// model.* referenced to keep imports honest
		expect(model.id).toBeTruthy();
	});

	it("does not retry a non-retryable error (insufficient_quota)", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } });

		const error: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
			usage: createUsage(10),
		};
		const getCallCount = useScriptedStreamFn(harness, [error]);

		await expect(harness.session.compact()).rejects.toThrow("insufficient_quota");
		expect(getCallCount()).toBe(1);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(0);
	});

	it("keeps compaction retry independent of disabled ordinary retries", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: false, maxRetries: 3, baseDelayMs: 0 } });

		const error: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
			usage: createUsage(10),
		};
		const getCallCount = useScriptedStreamFn(harness, [error]);
		vi.useFakeTimers();
		const failure = expect(harness.session.compact()).rejects.toThrow("terminated");
		await vi.advanceTimersByTimeAsync(2000);
		await failure;
		expect(getCallCount()).toBe(2);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(1);
	});

	it("stops after the compaction allowance rather than the ordinary maxRetries", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } });

		const error: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
			usage: createUsage(10),
		};
		const getCallCount = useScriptedStreamFn(harness, [error, error, error]);

		vi.useFakeTimers();
		const failure = expect(harness.session.compact()).rejects.toThrow("terminated");
		await vi.advanceTimersByTimeAsync(2000);
		await failure;
		expect(getCallCount()).toBe(2);
		const starts = harness.eventsOfType("summarization_retry_scheduled");
		const ends = harness.eventsOfType("summarization_retry_finished");
		expect(starts).toHaveLength(1);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ type: "summarization_retry_finished" });
	});

	it("shares its single retry between history and turn-prefix summaries", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "split turn", timestamp: Date.now() });
		harness.sessionManager.appendMessage(fauxAssistantMessage("retained assistant response"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const error = fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
		harness.setResponses([
			error,
			fauxAssistantMessage("history summary"),
			error,
			fauxAssistantMessage("must not retry prefix"),
		]);
		vi.useFakeTimers();
		const failure = expect(harness.session.compact()).rejects.toThrow("terminated");
		await vi.advanceTimersByTimeAsync(2000);
		await failure;
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(1);
	});

	it("leaves ordinary agent retries under settings.retry", async () => {
		const harness = await createHarness({
			settings: {
				compaction: { enabled: false },
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			},
		});
		harnesses.push(harness);
		const error = fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
		harness.setResponses([error, error, fauxAssistantMessage("ordinary retry succeeded")]);
		await harness.session.prompt("ordinary prompt");
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.getLastAssistantText()).toBe("ordinary retry succeeded");
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(2);
	});

	// A provider-aborted summary without user cancellation is a failure (#9777).
	it("does not persist a provider-aborted summary", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("incomplete summary", { stopReason: "aborted" })]);
		await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: false });
	});

	it("aborts an in-flight retry backoff via abortCompaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 5, baseDelayMs: 30_000 } });

		const error: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
			usage: createUsage(10),
		};
		useScriptedStreamFn(harness, [error, error, error]);

		const compactPromise = harness.session.compact();
		// Let the first error resolve and the retry backoff sleep start.
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		// The aborted retry backoff is normalized to an aborted assistant message,
		// which compaction classifies as aborted.
		await expect(compactPromise).rejects.toThrow();
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({ aborted: true });
	});
});
