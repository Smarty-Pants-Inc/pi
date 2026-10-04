import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import inputAuthor from "../../examples/extensions/input-author.ts";
import type { InputSubmission } from "../../src/index.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

function gate(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const alice = { name: "Alice", source: "herdr-client", verified: false } as const;

type PendingInput = { text: string; cancellation: AbortController };
type QueueView = { steering: string[]; followUp: string[] };
type OwnershipView = {
	runtimeHost: { session: Harness["session"] };
	inFlightInput?: PendingInput;
	pendingUserInputs: PendingInput[];
	compactionQueuedMessages: [];
	capturingStreamingInputs: Set<never>;
	editor: { getText(): string; setText(text: string): void };
	updatePendingMessagesDisplay(): void;
};
const tuiPrototype = InteractiveMode.prototype as unknown as {
	getAllQueuedMessages(this: OwnershipView): QueueView;
	restoreQueuedMessagesToEditor(this: OwnershipView): number;
};

describe("submission preflight ownership", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()!.cleanup();
	});

	// PR #135 F4 / smarty-dev#4078: native retention must hand off before synchronous enqueue observers.
	it.each(
		(["failed", "aborted"] as const).flatMap((outcome) =>
			(["steer", "followUp"] as const).flatMap((mode) =>
				(["throw", "dequeue-and-throw"] as const).map((observer) => ({ outcome, mode, observer })),
			),
		),
	)(
		"has one owner and one delivery after $outcome $mode retention with $observer",
		async ({ outcome, mode, observer }) => {
			let captures = 0;
			const starts: InputSubmission[] = [];
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 100 }],
				settings: {
					compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
					retry: { enabled: false },
				},
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", (event) => {
							if (event.source !== "interactive") return;
							captures++;
							return { metadata: { author: alice } };
						});
						pi.on("message_start", (event) => {
							if (event.message.role === "user" && getMessageText(event.message) === "same" && event.input)
								starts.push(event.input);
						});
						if (outcome === "aborted") pi.on("session_before_compact", () => ({ cancel: true }));
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			const model = harness.getModel();
			harness.sessionManager.appendMessage({
				role: "user",
				content: "previous prompt",
				timestamp: Date.now() - 1000,
			});
			const previous = fauxAssistantMessage("previous response", { timestamp: Date.now() - 500 });
			harness.sessionManager.appendMessage({
				...previous,
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { ...previous.usage, input: 10_001, totalTokens: 10_001 },
			});
			harness.session.refreshContext();
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" })]);

			const cancellation = new AbortController();
			let editorText = "";
			const view: OwnershipView = Object.assign(Object.create(InteractiveMode.prototype) as OwnershipView, {
				runtimeHost: { session: harness.session },
				inFlightInput: { text: "same", cancellation },
				pendingUserInputs: [],
				compactionQueuedMessages: [],
				capturingStreamingInputs: new Set<never>(),
				editor: {
					getText: () => editorText,
					setText: (text: string) => {
						editorText = text;
					},
				},
				updatePendingMessagesDisplay: () => {},
			});
			let transfers = 0;
			let observed = false;
			let ownersAtEnqueue: QueueView | undefined;
			let restored: number | undefined;
			const observerError = new Error("retention enqueue observer failed");
			harness.session.subscribe((event) => {
				if (event.type !== "queue_update" || harness.session.pendingMessageCount === 0 || observed) return;
				observed = true;
				ownersAtEnqueue = tuiPrototype.getAllQueuedMessages.call(view);
				if (observer === "dequeue-and-throw") restored = tuiPrototype.restoreQueuedMessagesToEditor.call(view);
				throw observerError;
			});
			const result = await harness.session
				.prompt("same", {
					source: "interactive",
					streamingBehavior: mode,
					inputCancellation: cancellation.signal,
					onInputTransferred: () => {
						transfers++;
						view.inFlightInput = undefined;
					},
				})
				.catch((error: unknown) => error);

			expect(result).toBe(observerError);
			expect(observed).toBe(true);
			expect.soft(transfers).toBe(1);
			expect
				.soft(ownersAtEnqueue)
				.toEqual({ steering: mode === "steer" ? ["same"] : [], followUp: mode === "followUp" ? ["same"] : [] });
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				result: undefined,
				aborted: outcome === "aborted",
			});
			expect(harness.faux.state.callCount).toBe(outcome === "failed" ? 1 : 0);
			expect(getUserTexts(harness)).toEqual(["previous prompt"]);
			expect(captures).toBe(1);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
			harness.session.setAutoCompactionEnabled(false);
			harness.setResponses([fauxAssistantMessage("recovered"), fauxAssistantMessage("retained response")]);
			if (observer === "dequeue-and-throw") {
				expect.soft(restored).toBe(1);
				expect.soft(editorText).toBe("same");
				expect.soft(cancellation.signal.aborted).toBe(false);
				expect(harness.session.agent.hasQueuedMessages()).toBe(false);
				await harness.session.prompt(editorText, { source: "interactive" });
				expect.soft(getUserTexts(harness)).toEqual(["previous prompt", "same"]);
				expect(captures).toBe(2);
			} else {
				expect(harness.session.pendingMessageCount).toBe(1);
				// The host has no input left to retry; native recovery alone delivers Alice's retained object.
				await harness.session.prompt("recovery", { source: "rpc" });
				expect(getUserTexts(harness)).toEqual(["previous prompt", "recovery", "same"]);
				expect(captures).toBe(1);
			}
			await harness.session.waitForIdle();
			expect.soft(starts).toEqual([{ source: "interactive", metadata: { author: alice } }]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toMatchObject([
				{ customType: "input-author", data: { author: alice } },
			]);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.session.isIdle).toBe(true);
		},
	);

	// PR #135 F5 / smarty-dev#4078: a temporary settlement-capture token must not strand accepted B.
	it.each(
		(["cancel", "capture-error", "success"] as const).flatMap((outcome) =>
			(["steer", "followUp"] as const).map((deliverAs) => ({ outcome, deliverAs })),
		),
	)(
		"delivers B once when settlement finishes before A capture: $outcome / $deliverAs",
		async ({ outcome, deliverAs }) => {
			const settled = gate();
			const settlementRelease = gate();
			const captureStarted = gate();
			const captureRelease = gate();
			let firstSettlement = true;
			let captures = 0;
			let errorObservations = 0;
			let transferred = 0;
			const observerError = new Error("capture error observer failed");
			const starts: string[] = [];
			const contexts: string[] = [];
			const harness = await createHarness({
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("agent_settled", async () => {
							if (!firstSettlement) return;
							firstSettlement = false;
							settled.release();
							await settlementRelease.promise;
						});
						pi.on("input_submission", async (event) => {
							if (event.text !== "A") return;
							captures++;
							captureStarted.release();
							await captureRelease.promise;
							if (outcome === "capture-error") throw new Error("capture failed");
							return { metadata: { author: alice } };
						});
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({
				onError: (error) => {
					if (error.event !== "input_submission") return;
					errorObservations++;
					throw observerError;
				},
			});
			harness.session.subscribe((event) => {
				if (event.type === "message_start" && (event.message.role === "user" || event.message.role === "custom"))
					starts.push(getMessageText(event.message));
			});
			const deliveryCalls = outcome === "success" && deliverAs === "followUp" ? 2 : 1;
			const responses: FauxResponseStep[] = [fauxAssistantMessage("initial response")];
			for (let i = 0; i < deliveryCalls; i++) {
				responses.push((context) => {
					contexts.push(JSON.stringify(context));
					return fauxAssistantMessage("delivered");
				});
			}
			harness.setResponses(responses);
			const initial = harness.session.prompt("initial", { source: "rpc" });
			await settled.promise;
			const cancellation = new AbortController();
			const promptA = harness.session
				.prompt("A", {
					source: "interactive",
					inputCancellation: cancellation.signal,
					onInputTransferred: () => {
						transferred++;
					},
				})
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			let idleResolved = false;
			let idle: Promise<void> | undefined;
			try {
				await captureStarted.promise;
				settlementRelease.release();
				await initial;
				expect(harness.session.isSettling).toBe(false);
				expect(harness.session.isPromptPending).toBe(true);
				await harness.session.sendCustomMessage(
					{ customType: "trigger-B", content: "B", display: false },
					{ triggerTurn: true, deliverAs },
				);
				expect(harness.session.isIdle).toBe(false);
				expect(harness.faux.state.callCount).toBe(1);
				idle = harness.session.waitForIdle().then(() => {
					idleResolved = true;
				});
				if (outcome === "cancel") cancellation.abort();
				captureRelease.release();
				const result = await promptA;
				if (outcome === "cancel") expect(result).toMatchObject({ name: "AbortError" });
				else if (outcome === "capture-error") expect(result).toBe(observerError);
				else expect(result).toBeUndefined();
				// A bounded event-loop barrier exposes a stranded trigger without leaving a hanging test waiter.
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect.soft(starts).toEqual(outcome === "success" ? ["initial", "A", "B"] : ["initial", "B"]);
				expect.soft(idleResolved).toBe(true);
				expect.soft(harness.session.isIdle).toBe(true);
				expect(harness.session.isPromptPending).toBe(false);
				expect.soft(harness.faux.state.callCount).toBe(1 + deliveryCalls);
				expect(transferred).toBe(outcome === "success" ? 1 : 0);
				expect(captures).toBe(1);
				expect(errorObservations).toBe(outcome === "capture-error" ? 1 : 0);
				expect.soft(contexts.length).toBe(deliveryCalls);
				for (const context of contexts)
					expect(context).not.toMatch(/Alice|herdr-client|input-author|metadata|verified/);
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(
					outcome === "success" ? 1 : 0,
				);
				expect
					.soft(
						harness.sessionManager
							.getEntries()
							.filter((entry) => entry.type === "custom_message" && entry.customType === "trigger-B"),
					)
					.toHaveLength(1);
			} finally {
				settlementRelease.release();
				captureRelease.release();
				await Promise.all([initial, promptA]);
				if (!harness.session.isIdle) harness.session.clearQueue();
				await idle;
			}
		},
	);
});
