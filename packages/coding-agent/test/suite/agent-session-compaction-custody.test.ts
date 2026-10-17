import { readFileSync } from "node:fs";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type ImageContent,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

// smarty-dev#217, #2742: final generic persistence, queue-custody and whole-operation deadline regressions.
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

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
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
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("public compact preserves persisted history and continues on the same manager", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(harness.getPendingResponseCount()).toBe(0);
		const manager = harness.sessionManager;
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session");
		const header = structuredClone(manager.getHeader());
		const originalId = manager.getSessionId();
		const cwd = manager.getCwd();
		const labelTarget = manager.getEntries()[0]!.id;
		manager.appendLabelChange(labelTarget, "retained label");
		// Reference text only: this does not qualify artifact contents or custody.
		manager.appendCustomEntry("artifact-reference-fixture", { path: "kept-artifact.txt" });
		const prefix = structuredClone(manager.getEntries());
		const beforeBytes = readFileSync(file);
		// This fixture splits the second turn: one history and one turn-prefix summary.
		harness.setResponses([fauxAssistantMessage("history summary"), fauxAssistantMessage("turn prefix summary")]);

		const result = await harness.session.compact();

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(result.summary).toBe("history summary\n\n---\n\n**Turn Context (split turn):**\n\nturn prefix summary");
		expect(harness.session.sessionManager).toBe(manager);
		expect(manager.getSessionId()).toBe(originalId);
		expect(manager.getSessionFile()).toBe(file);
		expect(manager.getCwd()).toBe(cwd);
		expect(manager.getHeader()).toEqual(header);
		expect(manager.getEntries().slice(0, prefix.length)).toEqual(prefix);
		expect(manager.getEntries()).toHaveLength(prefix.length + 1);
		const compactedBytes = readFileSync(file);
		expect(compactedBytes.subarray(0, beforeBytes.length)).toEqual(beforeBytes);
		expect(
			compactedBytes
				.toString("utf8")
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual(JSON.parse(JSON.stringify([header, ...manager.getEntries()])));
		const compactions = manager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect(compactions[0]).toMatchObject({
			parentId: prefix.at(-1)?.id,
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			usage: result.usage,
		});
		expect(prefix.find((entry) => entry.id === result.firstKeptEntryId)).toMatchObject({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "second reply" }] },
		});
		expect(manager.getLeafId()).toBe(compactions[0]?.id);
		expect(manager.getLabel(labelTarget)).toBe("retained label");
		expect(harness.session.messages).toEqual(manager.buildSessionContext().messages);
		expect(harness.session.messages[0]?.role).toBe("system");
		expect(harness.session.messages[1]).toMatchObject({ role: "compactionSummary", summary: result.summary });
		expect(harness.session.getLastAssistantText()).toBe("second reply");
		const compacted = structuredClone(manager.getEntries());
		const controlId = manager.appendCustomEntry("control-fixture", { phase: "after-compaction" });
		expect(manager.getEntry(controlId)?.parentId).toBe(compactions[0]?.id);
		harness.setResponses([fauxAssistantMessage("continued")]);

		await harness.session.prompt("continue explicitly");

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.sessionManager).toBe(manager);
		expect(manager.getSessionId()).toBe(originalId);
		expect(manager.getSessionFile()).toBe(file);
		expect(manager.getCwd()).toBe(cwd);
		expect(manager.getHeader()).toEqual(header);
		expect(manager.getEntries().slice(0, compacted.length)).toEqual(compacted);
		expect(harness.session.getLastAssistantText()).toBe("continued");
		expect(manager.getEntries().slice(compacted.length + 1)).toMatchObject([
			{
				type: "message",
				parentId: controlId,
				message: { role: "user", content: [{ text: "continue explicitly" }] },
			},
			{ type: "message", message: { role: "assistant", content: [{ text: "continued" }] } },
		]);
		const bytes = readFileSync(file);
		const rows = bytes
			.toString("utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toEqual(JSON.parse(JSON.stringify([header, ...manager.getEntries()])));
		expect(bytes.subarray(0, compactedBytes.length)).toEqual(compactedBytes);
		expect(manager.getLeafId()).toBe(manager.getEntries().at(-1)?.id);
	});

	it("public compact can reject after persisting when a completion observer throws", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(harness.getPendingResponseCount()).toBe(0);
		const manager = harness.sessionManager;
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session");
		const header = structuredClone(manager.getHeader());
		const originalId = manager.getSessionId();
		const prefix = structuredClone(manager.getEntries());
		const beforeBytes = readFileSync(file);
		harness.setResponses([fauxAssistantMessage("history summary"), fauxAssistantMessage("turn prefix summary")]);
		let thrown = false;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "manual" && event.result && !thrown) {
				thrown = true;
				throw new Error("post-write observer failure");
			}
		});

		try {
			await expect(harness.session.compact()).rejects.toThrow("post-write observer failure");
		} finally {
			unsubscribe();
		}

		expect(thrown).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.sessionManager).toBe(manager);
		expect(manager.getSessionId()).toBe(originalId);
		expect(manager.getSessionFile()).toBe(file);
		expect(manager.getHeader()).toEqual(header);
		expect(manager.getEntries().slice(0, prefix.length)).toEqual(prefix);
		expect(manager.getEntries()).toHaveLength(prefix.length + 1);
		const compactions = manager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect(compactions[0]).toMatchObject({
			parentId: prefix.at(-1)?.id,
			summary: "history summary\n\n---\n\n**Turn Context (split turn):**\n\nturn prefix summary",
		});
		const bytes = readFileSync(file);
		expect(bytes.subarray(0, beforeBytes.length)).toEqual(beforeBytes);
		expect(
			bytes
				.toString("utf8")
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual(JSON.parse(JSON.stringify([header, ...manager.getEntries()])));
		expect(manager.getLeafId()).toBe(compactions[0]?.id);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(2);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Compaction failed: post-write observer failure",
		});
		expect(harness.session.isIdle).toBe(true);
		// Rejection is not proof of no effect; do not retry or replay the prompt.
	});

	it.each(["failed", "aborted"] as const)(
		"retains ordered image-bearing steering across %s between-turn compaction",
		async (outcome) => {
			const queuedTexts = [
				"queued image before compaction",
				"queued second before compaction",
				"queued during compaction",
			];
			const images: ImageContent[] = [{ type: "image", data: "synthetic-image", mimeType: "image/png" }];
			let queueOwnedAtPreparation = false;
			let recovering = false;
			let requestedAfterFailure = false;
			const largeTool: AgentTool = {
				name: "large_result",
				label: "Large result",
				description: "Returns enough content to cross the compaction threshold",
				parameters: Type.Object({}),
				execute: async () => {
					// The loop selects this batch after the tool turn, before preparation.
					await harness.session.steer(queuedTexts[0], images);
					await harness.session.steer(queuedTexts[1]);
					return {
						content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
						details: {},
					};
				},
			};
			const harness: Harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
				settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
				tools: [largeTool],
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							if (recovering) {
								return {
									compaction: {
										summary: "recovered history",
										firstKeptEntryId: event.preparation.firstKeptEntryId,
										tokensBefore: event.preparation.tokensBefore,
										details: {},
									},
								};
							}
							queueOwnedAtPreparation = harness.session.agent.hasQueuedMessages();
							await harness.session.steer(queuedTexts[2]);
							return outcome === "aborted" ? { cancel: true } : undefined;
						});
						// smarty-dev#217: settlement hooks must not restart failed compaction.
						pi.on("agent_before_settle", () => {
							if (!queueOwnedAtPreparation || recovering || requestedAfterFailure) return;
							requestedAfterFailure = true;
							return {
								entries: [
									{ type: "custom_message", customType: "unsafe-retry", content: "retry", display: false },
								],
								continue: true,
							};
						});
					},
				],
			});
			harnesses.push(harness);
			harness.session.setSteeringMode("all");
			const steer = vi.spyOn(harness.session.agent, "steer");
			harness.setResponses([
				fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
				fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
				fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
				...(outcome === "failed"
					? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" })]
					: []),
			]);
			await harness.session.prompt("seed old history");
			await harness.session.prompt("seed recent history");
			await harness.session.prompt("run the large tool");

			const callsBeforeRecovery = outcome === "failed" ? 4 : 3;
			const queuedMessages = steer.mock.calls.map(([message]) => message);
			expect(queuedMessages.map(getMessageText)).toEqual(queuedTexts);
			expect(queuedMessages[0]).toMatchObject({ content: [{ type: "text", text: queuedTexts[0] }, ...images] });
			expect(queueOwnedAtPreparation).toBe(true);
			expect(requestedAfterFailure).toBe(false);
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			expect(harness.session.getSteeringMessages()).toEqual(queuedTexts);
			expect(getUserTexts(harness).filter((text) => queuedTexts.includes(text))).toEqual([]);
			expect(
				harness.eventsOfType("message_start").filter((event) => queuedMessages.includes(event.message)),
			).toEqual([]);
			expect(harness.faux.state.callCount).toBe(callsBeforeRecovery);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				aborted: outcome === "aborted",
				result: undefined,
			});
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
			expect(harness.session.isIdle).toBe(true);

			// Supported recovery: compact successfully, then explicitly start a prompt.
			recovering = true;
			expect((await harness.session.compact()).summary).toBe("recovered history");
			expect(harness.faux.state.callCount).toBe(callsBeforeRecovery);
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			let recoveredRequest: TranscriptContext["messages"] = [];
			harness.appendResponses([
				(context) => {
					recoveredRequest = structuredClone(context.messages);
					return fauxAssistantMessage("recovered queued input");
				},
			]);
			await harness.session.prompt("resume retained input");

			expect(recoveredRequest.filter((message) => queuedTexts.includes(getMessageText(message)))).toEqual(
				queuedMessages,
			);
			const starts = harness.eventsOfType("message_start").filter((event) => queuedMessages.includes(event.message));
			expect(starts).toHaveLength(queuedMessages.length);
			for (const [index, event] of starts.entries()) {
				expect(event.message).toBe(queuedMessages[index]);
			}
			expect(getUserTexts(harness).filter((text) => queuedTexts.includes(text))).toEqual(queuedTexts);
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			expect(harness.session.steeringMode).toBe("all");
			expect(harness.faux.state.callCount).toBe(callsBeforeRecovery + 1);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.session.isIdle).toBe(true);
		},
	);

	it.each(["steer", "followUp"] as const)(
		"invalidates cleared %s reservations during successful preparation and assistant-tail continuation",
		async (queue) => {
			const clearedTexts = ["clear image", "clear second", "clear preparation arrival"];
			const laterTexts = ["keep later first", "keep later second"];
			// Valid PNG: explicit resubmission now runs v0.87 image normalization.
			const images: ImageContent[] = [
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
					mimeType: "image/png",
				},
			];
			let markPreparationStarted = () => {};
			const preparationStarted = new Promise<void>((resolve) => {
				markPreparationStarted = resolve;
			});
			let releasePreparation = () => {};
			const preparationReleased = new Promise<void>((resolve) => {
				releasePreparation = resolve;
			});
			let pauseNextPreparation = false;
			const harness = await createHarness({
				// #2742: trigger threshold compaction without requiring an over-window request.
				models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 100 }],
				settings: { compaction: { enabled: true, reserveTokens: 8_000, keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							if (pauseNextPreparation) {
								pauseNextPreparation = false;
								markPreparationStarted();
								await preparationReleased;
							}
							return {
								compaction: {
									summary: "successful delayed compaction",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
									details: {},
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			harness.session.setSteeringMode("all");
			harness.session.setFollowUpMode("all");
			const enqueue = vi.spyOn(harness.session.agent, queue);
			let resumedRequest: TranscriptContext["messages"] = [];
			harness.setResponses([
				fauxAssistantMessage("seed response"),
				async () => {
					await harness.session[queue](clearedTexts[0], images);
					await harness.session[queue](clearedTexts[1]);
					// Seed/pre-prompt compaction must finish without waiting for this
					// test's release. Arm the pause only after the target input is queued.
					pauseNextPreparation = true;
					// A completed assistant turn selects either queue before preparation.
					return fauxAssistantMessage(`large-response:${"x".repeat(10_000)}`);
				},
				(context) => {
					resumedRequest = structuredClone(context.messages);
					return fauxAssistantMessage("finished with later input");
				},
			]);
			await harness.session.prompt("seed history");
			const prompt = harness.session.prompt("start the large response");
			let restoredEditorText = "";
			let clearedMessages: AgentMessage[] = [];
			try {
				await preparationStarted;
				expect(harness.faux.state.callCount).toBe(2);
				expect(enqueue).toHaveBeenCalledTimes(2);
				expect(harness.session.agent.hasQueuedMessages()).toBe(true);
				await harness.session[queue](clearedTexts[2]);
				clearedMessages = enqueue.mock.calls.map(([message]) => message);
				const restored = harness.session.clearQueue();
				expect(restored).toEqual({
					steering: queue === "steer" ? clearedTexts : [],
					followUp: queue === "followUp" ? clearedTexts : [],
				});
				// This is the editor text returned by the real dequeue/restore path.
				restoredEditorText = [...restored.steering, ...restored.followUp].join("\n\n");
				expect(harness.session.agent.hasQueuedMessages()).toBe(false);
				await harness.session[queue](laterTexts[0]);
				await harness.session[queue](laterTexts[1]);
			} finally {
				releasePreparation();
				await prompt;
			}

			expect(harness.eventsOfType("compaction_end")).toContainEqual(
				expect.objectContaining({
					aborted: false,
					result: expect.objectContaining({ summary: "successful delayed compaction" }),
				}),
			);
			expect(
				harness.eventsOfType("message_start").filter((event) => clearedMessages.includes(event.message)),
			).toEqual([]);
			const journalMessages = harness.sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
			expect(journalMessages.filter((message) => clearedTexts.includes(getMessageText(message)))).toEqual([]);
			expect(resumedRequest.filter((message) => clearedTexts.includes(getMessageText(message)))).toEqual([]);
			expect(JSON.stringify(resumedRequest)).not.toContain(images[0].data);
			expect(resumedRequest.map(getMessageText).filter((text) => laterTexts.includes(text))).toEqual(laterTexts);
			expect(journalMessages.map(getMessageText).filter((text) => laterTexts.includes(text))).toEqual(laterTexts);
			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			expect(harness.session.pendingMessageCount).toBe(0);

			// Only an explicit submission now delivers the restored editor input.
			harness.appendResponses([
				(context) => {
					resumedRequest = structuredClone(context.messages);
					return fauxAssistantMessage("handled restored input");
				},
			]);
			await harness.session.prompt(restoredEditorText, { images });
			expect(resumedRequest.filter((message) => getMessageText(message) === restoredEditorText)).toHaveLength(1);
			expect(harness.faux.state.callCount).toBe(4);

			// continue() selects its initial prompts before awaited agent_start listeners.
			const continueText = "clear assistant-tail continuation";
			await harness.session[queue](continueText, images);
			let markContinueStarted = () => {};
			const continueStarted = new Promise<void>((resolve) => {
				markContinueStarted = resolve;
			});
			let releaseContinue = () => {};
			const continueReleased = new Promise<void>((resolve) => {
				releaseContinue = resolve;
			});
			const unsubscribe = harness.session.agent.subscribe(async (event) => {
				if (event.type === "agent_start") {
					markContinueStarted();
					await continueReleased;
				}
			});
			const continuation = harness.session.agent.continue();
			try {
				await continueStarted;
				const restored = harness.session.clearQueue();
				expect([...restored.steering, ...restored.followUp]).toEqual([continueText]);
			} finally {
				releaseContinue();
				await continuation;
				unsubscribe();
			}
			expect(
				harness.eventsOfType("message_start").some((event) => getMessageText(event.message) === continueText),
			).toBe(false);
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "message" && getMessageText(entry.message) === continueText),
			).toBe(false);
			expect(harness.faux.state.callCount).toBe(4);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			expect(harness.session.isIdle).toBe(true);
		},
	);

	it.each(["manual", "pre-prompt"] as const)("shares the %s deadline across all stages", async (mode) => {
		for (const phase of ["history", "prefix", "retry", "backoff"] as const) {
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
				settings: {
					compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 100 },
					retry: { enabled: true, maxRetries: 5, baseDelayMs: 30_000 },
				},
			});
			harnesses.push(harness);
			seedCompactableSession(harness);
			harness.sessionManager.appendMessage({ role: "user", content: "split turn", timestamp: Date.now() - 200 });
			harness.sessionManager.appendMessage({
				...createAssistant(harness, { totalTokens: 1001, timestamp: Date.now() - 100 }),
				content: [{ type: "text", text: "retained assistant response" }],
			});
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const before = structuredClone(harness.sessionManager.getEntries());
			const signals: (AbortSignal | undefined)[] = [];
			let releaseLate = (_message: AssistantMessage) => {};
			const late = new Promise<AssistantMessage>((resolve) => {
				releaseLate = resolve;
			});
			let releaseFirst = () => {};
			let firstTimer: ReturnType<typeof setTimeout> | undefined;
			const step = (_context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
				signals.push(options?.signal);
				if (signals.length === 1 && phase !== "history") {
					const response =
						phase === "prefix"
							? fauxAssistantMessage("history summary")
							: fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
					const delay = phase === "prefix" ? 600_000 : phase === "backoff" ? 1_199_000 : 0;
					if (delay === 0) return response;
					return new Promise<AssistantMessage>((resolve) => {
						releaseFirst = () => resolve(response);
						firstTimer = setTimeout(releaseFirst, delay);
					});
				}
				// Intentionally ignores abort until released: timeout must stop core
				// waits without accepting this late result or starting another summary.
				return late;
			};
			harness.setResponses([step, step]);
			vi.useFakeTimers();
			const operation =
				mode === "manual" ? harness.session.compact() : harness.session.prompt("pending after timeout");
			const outcome = operation.then(
				() => undefined,
				(error: unknown) => error,
			);
			try {
				await vi.advanceTimersByTimeAsync(1_199_999);
				const calls = phase === "prefix" || phase === "retry" ? 2 : 1;
				expect(harness.faux.state.callCount).toBe(calls);
				expect(signals[0]?.aborted).toBe(false);
				expect(signals.every((signal) => signal === signals[0])).toBe(true);
				expect(harness.session.isCompacting).toBe(true);
				await vi.advanceTimersByTimeAsync(1);
				expect(await outcome).toBeInstanceOf(Error);
				expect(signals[0]?.aborted).toBe(true);
				expect(signals[0]?.reason).toMatchObject({ name: "TimeoutError" });
				expect(harness.session.isIdle).toBe(true);
				expect(harness.sessionManager.getEntries()).toEqual(before);
				expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
				expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
					result: undefined,
					aborted: false,
					errorMessage: expect.stringContaining("20-minute deadline"),
				});
				if (mode === "pre-prompt") {
					expect(harness.session.getSteeringMessages()).toEqual(["pending after timeout"]);
				}
				releaseLate(fauxAssistantMessage("late summary must not be persisted"));
				await vi.advanceTimersByTimeAsync(60_000);
				expect(harness.faux.state.callCount).toBe(calls);
				expect(harness.sessionManager.getEntries()).toEqual(before);
				expect(harness.eventsOfType("summarization_retry_finished")).toHaveLength(
					phase === "retry" || phase === "backoff" ? 1 : 0,
				);
			} finally {
				harness.session.abortCompaction();
				clearTimeout(firstTimer);
				releaseFirst();
				releaseLate(fauxAssistantMessage("fixture cleanup"));
				await outcome;
				await vi.advanceTimersByTimeAsync(0);
				vi.useRealTimers();
			}
		}
	});
});
