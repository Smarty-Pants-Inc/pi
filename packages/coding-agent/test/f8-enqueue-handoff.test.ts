import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import inputAuthor from "../examples/extensions/input-author.ts";
import { AgentSessionRuntime, type AgentSessionServices } from "../src/core/agent-session-runtime.ts";
import type { InputSubmission } from "../src/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./suite/harness.ts";

type Mode = "steer" | "followUp";
type Owner = { text: string; cancellation?: AbortController; submissionPromise?: Promise<InputSubmission> };
type Receiver = {
	bindCurrentSessionExtensions(): Promise<void>;
	setupEditorSubmitHandler(): void;
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { getText(): string; setText(text: string): void };
	handleFollowUp(): Promise<void>;
	handleDequeue(): void;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	capturingStreamingInputs: Set<Owner>;
	compactionQueuedMessages: Owner[];
	inFlightInput?: Owner;
	inputSubmissionTransfers: number;
	compactionQueueTransfers: number;
	userInputInFlight: boolean;
	stagingAudit?: (kind: string) => void;
};

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function createReceiver(harness: Harness) {
	initTheme("dark");
	const services: AgentSessionServices = {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	};
	const runtime = new AgentSessionRuntime(harness.session, services, async () => {
		throw new Error("F8 must not replace the session");
	});
	const ui = new InteractiveMode(runtime);
	const receiver = ui as unknown as Receiver;
	const showError = vi.spyOn(ui, "showError").mockImplementation(() => {});
	await receiver.bindCurrentSessionExtensions();
	receiver.setupEditorSubmitHandler();
	return { runtime, ui, receiver, showError };
}

// F8 regression for Smarty-Pants-Inc/smarty-dev#4078: native queue_update is synchronous,
// earlier than Session's queue_update. These tests withdraw at that exact receiver boundary.
describe("F8 native enqueue ownership handoff", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()!.cleanup();
	});

	it.each((["steer", "followUp"] as const).flatMap((mode) => [false, true].map((throws) => ({ mode, throws }))))(
		"returns direct SDK $mode input once at native enqueue (throw=$throws)",
		async ({ mode, throws }) => {
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", (event) => {
							if (event.source === "interactive")
								return { metadata: { author: { name: "Alice", source: "herdr-client", verified: false } } };
						});
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			let withdrawn: ReturnType<Harness["session"]["clearQueue"]> | undefined;
			let once = true;
			let transfers = 0;
			harness.session.agent.observeLifecycle((event) => {
				if (!once || event.type !== "queue_update" || event.steering + event.followUp !== 1) return;
				once = false;
				withdrawn = harness.session.clearQueue();
				if (throws) throw new Error("F8 enqueue observer failed");
			});
			const submitted = harness.session[mode]("same", undefined, { onInputTransferred: () => transfers++ });
			if (throws) await expect(submitted).rejects.toThrow("F8 enqueue observer failed");
			else await submitted;
			expect.soft(withdrawn).toEqual({
				steering: mode === "steer" ? ["same"] : [],
				followUp: mode === "followUp" ? ["same"] : [],
			});
			expect.soft(transfers).toBe(1);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			harness.setResponses([fauxAssistantMessage("fresh response")]);
			await harness.session.prompt("fresh RPC", { source: "rpc" });
			expect(getUserTexts(harness)).toEqual(["fresh RPC"]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	it.each(
		(["steer", "followUp"] as const).flatMap((mode) =>
			(["streaming", "compaction"] as const).flatMap((stage) =>
				(["dequeue", "abort"] as const).flatMap((cancel) =>
					["same", "newer draft"].flatMap((draft) =>
						[false, true].map((throws) => ({ mode, stage, cancel, draft, throws })),
					),
				),
			),
		),
	)(
		"restores $stage $mode once during native $cancel (draft=$draft, throw=$throws)",
		async ({ mode, stage, cancel, draft, throws }) => {
			const responseStarted = gate();
			const responseRelease = gate();
			const compactStarted = gate();
			const compactRelease = gate();
			let boundAbort!: () => void;
			const captures: string[] = [];
			const harness = await createHarness({
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", (event, ctx) => {
							if (event.source !== "interactive") return;
							captures.push(event.text);
							boundAbort = () => ctx.abort();
							return { metadata: { author: { name: "Alice", source: "herdr-client", verified: false } } };
						});
						pi.on("session_before_compact", async (event) => {
							compactStarted.release();
							await compactRelease.promise;
							return {
								compaction: {
									summary: "F8 compacted history",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			const { ui, runtime, receiver, showError } = await createReceiver(harness);
			let running: Promise<unknown> | undefined;
			let submitted: Promise<void> | undefined;
			let compacting: Promise<unknown> | undefined;
			let observations = 0;
			let ownedAtObservation = -1;
			let restored = "";
			let armed = false;
			harness.session.agent.observeLifecycle((event) => {
				if (!armed || event.type !== "queue_update" || event.steering + event.followUp !== 1) return;
				armed = false;
				observations++;
				ownedAtObservation = receiver.capturingStreamingInputs.size + receiver.compactionQueuedMessages.length;
				receiver.editor.setText(draft);
				if (cancel === "abort") boundAbort();
				else receiver.handleDequeue();
				restored = receiver.editor.getText();
				if (throws) throw new Error("F8 enqueue observer failed");
			});
			try {
				if (stage === "streaming") {
					harness.setResponses([
						async () => {
							responseStarted.release();
							await responseRelease.promise;
							return fauxAssistantMessage("initial response");
						},
					]);
					running = harness.session.prompt("initial RPC", { source: "rpc" });
					await responseStarted.promise;
				} else {
					harness.sessionManager.appendMessage({ role: "user", content: "old question", timestamp: 1 });
					harness.sessionManager.appendMessage(fauxAssistantMessage("old response"));
					harness.session.refreshContext();
					compacting = harness.session.compact();
					await compactStarted.promise;
				}
				receiver.editor.setText("same");
				armed = stage === "streaming";
				submitted = mode === "steer" ? receiver.defaultEditor.onSubmit!("same") : receiver.handleFollowUp();
				if (stage === "compaction") {
					await submitted;
					expect(receiver.compactionQueuedMessages).toHaveLength(1);
					await receiver.compactionQueuedMessages[0].submissionPromise;
					compactRelease.release();
					await compacting;
					armed = true;
					submitted = receiver.flushCompactionQueue({ willRetry: true });
				}
				if (throws && stage === "streaming") await expect(submitted).rejects.toThrow("F8 enqueue observer failed");
				else await submitted;
				expect.soft(observations).toBe(1);
				expect.soft(ownedAtObservation).toBe(0);
				expect.soft(restored).toBe(`same\n\n${draft}`);
				expect.soft(receiver.editor.getText()).toBe(`same\n\n${draft}`);
				expect(harness.session.pendingMessageCount).toBe(0);
				expect(harness.session.agent.hasQueuedMessages()).toBe(false);
				expect(receiver.capturingStreamingInputs.size).toBe(0);
				expect(receiver.compactionQueuedMessages).toEqual([]);
				expect(receiver.inputSubmissionTransfers).toBe(0);
				expect(receiver.compactionQueueTransfers).toBe(0);
				receiver.handleDequeue();
				expect(receiver.editor.getText()).toBe(`same\n\n${draft}`);
				receiver.editor.setText("later draft");
				responseRelease.release();
				await running;
				await receiver.flushCompactionQueue({ willRetry: true });
				const usersBeforeFresh = getUserTexts(harness);
				expect(usersBeforeFresh).not.toContain("same");
				harness.setResponses([fauxAssistantMessage("fresh response"), fauxAssistantMessage("Bob response")]);
				await harness.session.prompt("fresh RPC", { source: "rpc" });
				// Later metadata capture must not resurrect withdrawn input or its author on fresh RPC.
				await harness.session.captureInputSubmission("later capture");
				expect(getUserTexts(harness)).toEqual([...usersBeforeFresh, "fresh RPC"]);
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
				expect(receiver.editor.getText()).toBe("later draft");
				expect(captures).toEqual(["same", "later capture"]);
				if (throws && stage === "compaction")
					expect(showError).toHaveBeenCalledExactlyOnceWith(
						"Failed to send queued message: F8 enqueue observer failed",
					);
				else expect(showError).not.toHaveBeenCalled();
			} finally {
				compactRelease.release();
				responseRelease.release();
				await Promise.allSettled([submitted, running, compacting]);
				ui.stop();
				await runtime.dispose();
			}
		},
	);

	// A separate accepted capture is cancelled, not confused with the just-transferred identical native input.
	it.each(
		(["steer", "followUp"] as const).flatMap((mode) =>
			(["dequeue", "abort"] as const).flatMap((cancel) => [false, true].map((reject) => ({ mode, cancel, reject }))),
		),
	)("cancels a separate held $mode capture at enqueue ($cancel, reject=$reject)", async ({ mode, cancel, reject }) => {
		const responseStarted = gate();
		const responseRelease = gate();
		const captureStarted = gate();
		const captureRelease = gate();
		let captures = 0;
		let boundAbort!: () => void;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input_submission", async (event, ctx) => {
						if (event.source !== "interactive") return;
						captures++;
						boundAbort = () => ctx.abort();
						if (captures === 1) {
							captureStarted.release();
							await captureRelease.promise;
						}
						return { metadata: { author: { name: "Alice", source: "herdr-client", verified: false } } };
					});
				},
				inputAuthor,
			],
		});
		harnesses.push(harness);
		if (reject) {
			const capture = harness.session.captureInputSubmission.bind(harness.session);
			let calls = 0;
			vi.spyOn(harness.session, "captureInputSubmission").mockImplementation(async (text, options) => {
				const fail = options?.source !== "rpc" && ++calls === 1;
				const submission = await capture(text, options);
				if (fail) throw new Error("late host capture rejection");
				return submission;
			});
		}
		const { runtime, ui, receiver, showError } = await createReceiver(harness);
		let once = true;
		let owner!: Owner;
		let restored = "";
		harness.session.agent.observeLifecycle((event) => {
			if (!once || event.type !== "queue_update" || event.steering + event.followUp !== 1) return;
			once = false;
			expect.soft(receiver.capturingStreamingInputs.size).toBe(1);
			receiver.editor.setText("same");
			if (cancel === "abort") boundAbort();
			else receiver.handleDequeue();
			restored = receiver.editor.getText();
		});
		harness.setResponses([
			async () => {
				responseStarted.release();
				await responseRelease.promise;
				return fauxAssistantMessage("initial response");
			},
		]);
		const running = harness.session.prompt("initial RPC", { source: "rpc" });
		await responseStarted.promise;
		receiver.editor.setText("same");
		const held = mode === "steer" ? receiver.defaultEditor.onSubmit!("same") : receiver.handleFollowUp();
		await captureStarted.promise;
		owner = [...receiver.capturingStreamingInputs][0];
		try {
			receiver.editor.setText("same");
			await (mode === "steer" ? receiver.defaultEditor.onSubmit!("same") : receiver.handleFollowUp());
			expect.soft(restored).toBe("same\n\nsame\n\nsame");
			expect(owner.cancellation?.signal.aborted).toBe(true);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			receiver.editor.setText("later draft");
			captureRelease.release();
			await held;
			expect(receiver.editor.getText()).toBe("later draft");
			expect(receiver.inputSubmissionTransfers).toBe(0);
			expect(harness.session.pendingMessageCount).toBe(0);
			responseRelease.release();
			await running;
			harness.setResponses([fauxAssistantMessage("fresh response")]);
			await harness.session.prompt("fresh RPC", { source: "rpc" });
			await harness.session.captureInputSubmission("later capture");
			expect(getUserTexts(harness)).toEqual(["initial RPC", "fresh RPC"]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
			expect(harness.faux.state.callCount).toBe(2);
			expect(showError).not.toHaveBeenCalled();
		} finally {
			captureRelease.release();
			responseRelease.release();
			await Promise.allSettled([held, running]);
			ui.stop();
			await runtime.dispose();
		}
	});

	// The actual idle run receiver owns inFlightInput while failed pre-prompt compaction retains input in steer.
	// Idle Alt+Enter uses the same Enter receiver; it does not create a native followUp owner.
	it.each(["dequeue", "abort"] as const)("hands off real inFlight receiver before native %s", async (cancel) => {
		let boundAbort!: () => void;
		let cancelCompaction = true;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("input_submission", (event, ctx) => {
						if (event.source !== "interactive") return;
						boundAbort = () => ctx.abort();
						return { metadata: { author: { name: "Alice", source: "herdr-client", verified: false } } };
					});
					pi.on("session_before_compact", () => {
						if (cancelCompaction) return { cancel: true };
					});
				},
				inputAuthor,
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "old question", timestamp: 1 });
		const old = fauxAssistantMessage("old response");
		old.model = harness.getModel().id;
		old.provider = harness.getModel().provider;
		old.usage = {
			...old.usage,
			input: harness.getModel().contextWindow,
			totalTokens: harness.getModel().contextWindow,
		};
		harness.sessionManager.appendMessage(old);
		harness.session.refreshContext();
		const { runtime, ui, receiver } = await createReceiver(harness);
		vi.spyOn(ui, "init").mockResolvedValue();
		receiver.stagingAudit = () => {};
		const exit = new Error("F8 idle loop complete");
		const getInput = ui.getUserInput.bind(ui);
		vi.spyOn(ui, "getUserInput").mockImplementationOnce(getInput).mockRejectedValue(exit);
		let once = true;
		let observed = false;
		let restored = "";
		harness.session.agent.observeLifecycle((event) => {
			if (!once || event.type !== "queue_update" || event.steering !== 1) return;
			once = false;
			observed = true;
			expect.soft(receiver.inFlightInput).toBeUndefined();
			expect.soft(receiver.userInputInFlight).toBe(false);
			receiver.editor.setText("same");
			if (cancel === "abort") boundAbort();
			else receiver.handleDequeue();
			restored = receiver.editor.getText();
		});
		await receiver.defaultEditor.onSubmit!("same");
		const run = ui.run().catch((error: unknown) => expect(error).toBe(exit));
		try {
			await run;
			expect(observed).toBe(true);
			expect.soft(restored).toBe("same\n\nsame");
			expect.soft(receiver.editor.getText()).toBe("same\n\nsame");
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(getUserTexts(harness)).not.toContain("same");
			cancelCompaction = false;
			harness.session.setAutoCompactionEnabled(false);
			harness.setResponses([fauxAssistantMessage("fresh response")]);
			await harness.session.prompt("fresh RPC", { source: "rpc" });
			expect(getUserTexts(harness)).not.toContain("same");
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
		} finally {
			await run;
			ui.stop();
			await runtime.dispose();
		}
	});

	it.each((["steer", "followUp"] as const).flatMap((mode) => [false, true].map((throws) => ({ mode, throws }))))(
		"preserves nonwithdrawn $mode insertion and attribution (throw=$throws)",
		async ({ mode, throws }: { mode: Mode; throws: boolean }) => {
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", (event) => {
							if (event.source === "interactive")
								return { metadata: { author: { name: "Alice", source: "herdr-client", verified: false } } };
						});
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			let transferred = false;
			let once = true;
			harness.session.agent.observeLifecycle((event) => {
				if (!once || event.type !== "queue_update" || event.steering + event.followUp !== 1) return;
				once = false;
				expect.soft(transferred).toBe(true);
				expect.soft(harness.session.pendingMessageCount).toBe(1);
				expect(harness.session.agent.peekQueuedMessages().map(getMessageText)).toEqual(["same"]);
				if (throws) throw new Error("nonwithdrawn enqueue observation failed");
			});
			const queued = harness.session[mode]("same", undefined, {
				onInputTransferred: () => {
					transferred = true;
				},
			});
			if (throws) await expect(queued).rejects.toThrow("nonwithdrawn enqueue observation failed");
			else await queued;
			harness.setResponses([fauxAssistantMessage("RPC response"), fauxAssistantMessage("Alice response")]);
			await harness.session.prompt("fresh RPC", { source: "rpc" });
			expect(getUserTexts(harness)).toEqual(["fresh RPC", "same"]);
			const entries = harness.sessionManager.getEntries();
			const author = entries.find((entry) => entry.type === "custom" && entry.customType === "input-author");
			const user = entries.find((entry) => entry.type === "message" && getMessageText(entry.message) === "same");
			expect(author).toMatchObject({ beforeMessageId: user?.id, data: { author: { name: "Alice" } } });
		},
	);
});
