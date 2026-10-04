import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import inputAuthor from "../examples/extensions/input-author.ts";
import type { ExtensionUIContext, InputSubmission } from "../src/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./suite/harness.ts";

type QueuedInput = { text: string; mode: "steer" | "followUp"; submissionPromise?: Promise<InputSubmission> };
type PendingInput = { text: string; submissionPromise?: Promise<InputSubmission> };
type CapturingStreamingInput = { text: string; mode: "steer" | "followUp"; cancelled: boolean };
type SubmissionUI = {
	session: Harness["session"];
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { getText: () => string; setText: (text: string) => void; addToHistory: (text: string) => void };
	pendingUserInputs: PendingInput[];
	compactionQueuedMessages: QueuedInput[];
	compactionQueueTransfers: number;
	inputSubmissionTransfers: number;
	capturingStreamingInputs: Set<CapturingStreamingInput>;
	clearAllQueues: () => { steering: string[]; followUp: string[] };
	restoreQueuedMessagesToEditor: (options?: { abort?: boolean; currentText?: string }) => number;
	captureEditorSubmission: (text: string, mode?: "steer" | "followUp") => Promise<InputSubmission> | undefined;
	submitStreamingInput: (text: string, mode: "steer" | "followUp") => Promise<void>;
	isExtensionCommand: (text: string) => boolean;
	flushPendingBashComponents: () => void;
	queueCompactionMessage: (
		text: string,
		mode: "steer" | "followUp",
		submissionPromise?: Promise<InputSubmission>,
	) => void;
	awaitInputSubmission: (
		text: string,
		submissionPromise?: Promise<InputSubmission>,
		capture?: CapturingStreamingInput,
	) => Promise<InputSubmission | undefined | null>;
	updatePendingMessagesDisplay: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
};

type SubmissionUIPrototype = {
	createExtensionUIContext(this: SubmissionUI): ExtensionUIContext;
	setupEditorSubmitHandler(this: SubmissionUI): void;
	captureEditorSubmission(
		this: SubmissionUI,
		text: string,
		mode?: "steer" | "followUp",
	): Promise<InputSubmission> | undefined;
	submitStreamingInput(this: SubmissionUI, text: string, mode: "steer" | "followUp"): Promise<void>;
	handleFollowUp(this: SubmissionUI): Promise<void>;
	handleDequeue(this: SubmissionUI): void;
	getAllQueuedMessages(this: SubmissionUI): { steering: string[]; followUp: string[] };
	clearAllQueues(this: SubmissionUI): { steering: string[]; followUp: string[] };
	restoreQueuedMessagesToEditor(this: SubmissionUI, options?: { abort?: boolean; currentText?: string }): number;
	queueCompactionMessage(
		this: SubmissionUI,
		text: string,
		mode: "steer" | "followUp",
		submissionPromise?: Promise<InputSubmission>,
	): void;
	flushCompactionQueue(this: SubmissionUI, options?: { willRetry?: boolean }): Promise<void>;
	awaitInputSubmission(
		this: SubmissionUI,
		text: string,
		submissionPromise?: Promise<InputSubmission>,
		capture?: CapturingStreamingInput,
	): Promise<InputSubmission | undefined | null>;
};
const prototype = InteractiveMode.prototype as unknown as SubmissionUIPrototype;

function gate(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function createSubmissionUI(harness: Harness) {
	let draft = "";
	const context: SubmissionUI = {
		session: harness.session,
		defaultEditor: {},
		editor: {
			getText: () => draft,
			setText: vi.fn((text: string) => {
				draft = text;
			}),
			addToHistory: vi.fn(),
		},
		pendingUserInputs: [],
		compactionQueuedMessages: [],
		compactionQueueTransfers: 0,
		inputSubmissionTransfers: 0,
		capturingStreamingInputs: new Set(),
		clearAllQueues: () => prototype.clearAllQueues.call(context),
		restoreQueuedMessagesToEditor: (options) => prototype.restoreQueuedMessagesToEditor.call(context, options),
		captureEditorSubmission: (text, mode) => prototype.captureEditorSubmission.call(context, text, mode),
		submitStreamingInput: (text, mode) => prototype.submitStreamingInput.call(context, text, mode),
		isExtensionCommand: (text) =>
			!!harness.session.extensionRunner.getCommand(text.split(" ")[0].slice(1)) && text.startsWith("/"),
		flushPendingBashComponents: vi.fn(),
		queueCompactionMessage: (text, mode, submissionPromise) =>
			prototype.queueCompactionMessage.call(context, text, mode, submissionPromise),
		awaitInputSubmission: (text, submissionPromise, capture) =>
			prototype.awaitInputSubmission.call(context, text, submissionPromise, capture),
		updatePendingMessagesDisplay: vi.fn(() => prototype.getAllQueuedMessages.call(context)),
		showStatus: vi.fn(),
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	prototype.setupEditorSubmitHandler.call(context);
	return context;
}

// Regression coverage for Smarty-Pants-Inc/smarty-dev#4078, using the real UI staging/transfer methods.
describe("interactive submission metadata", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()!.cleanup();
	});

	it.each([false, true])(
		"captures compaction-held follow-up and steer before real UI replay (retry: %s)",
		async (willRetry) => {
			const compactStarted = gate();
			const compactRelease = gate();
			let currentAuthor = "Alice";
			const captures: Array<{ name: string; mode?: string }> = [];
			const inputs: string[] = [];
			const contexts: string[] = [];
			const harness = await createHarness({
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", (event) => {
							if (event.source !== "interactive") return;
							const name = currentAuthor;
							captures.push({ name, mode: event.streamingBehavior });
							return { metadata: { author: { name, source: "herdr-client", verified: false } } };
						});
						pi.on("input", (event) => {
							inputs.push(event.text);
						});
						pi.on("session_before_compact", async (event) => {
							compactStarted.release();
							await compactRelease.promise;
							return {
								compaction: {
									summary: "compacted history",
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
			harness.sessionManager.appendMessage({ role: "user", content: "old question", timestamp: 1 });
			harness.sessionManager.appendMessage(fauxAssistantMessage("old response"));
			harness.session.refreshContext();
			const context = createSubmissionUI(harness);
			const compacting = harness.session.compact();
			await compactStarted.promise;
			try {
				context.editor.setText("same");
				await prototype.handleFollowUp.call(context);
				currentAuthor = "Bob";
				await context.defaultEditor.onSubmit?.("same");
				currentAuthor = "Later typist";
				await Promise.all(context.compactionQueuedMessages.map((message) => message.submissionPromise));
				expect(captures).toEqual([
					{ name: "Alice", mode: "followUp" },
					{ name: "Bob", mode: "steer" },
				]);
				expect(inputs).toEqual([]);
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
			} finally {
				compactRelease.release();
				await compacting;
			}
			harness.setResponses(
				Array.from({ length: 3 }, () => (providerContext) => {
					contexts.push(JSON.stringify(providerContext));
					return fauxAssistantMessage("response");
				}),
			);
			await prototype.flushCompactionQueue.call(context, { willRetry });
			if (willRetry) await harness.session.prompt("resume retry", { source: "rpc" });
			await harness.session.waitForIdle();
			await vi.waitFor(() => expect(context.compactionQueueTransfers).toBe(0));
			expect(context.compactionQueuedMessages).toEqual([]);
			expect(context.showError).not.toHaveBeenCalled();
			expect(captures).toHaveLength(2);
			const entries = harness.sessionManager.getEntries();
			const authors = entries.flatMap((entry, index) => {
				if (entry.type !== "message" || entry.message.role !== "user" || getMessageText(entry.message) !== "same")
					return [];
				const preceding = entries[index - 1];
				expect(preceding).toMatchObject({ type: "custom", customType: "input-author", beforeMessageId: entry.id });
				return preceding?.type === "custom" ? [(preceding.data as { author: { name: string } }).author.name] : [];
			});
			expect(authors).toEqual(willRetry ? ["Bob", "Alice"] : ["Alice", "Bob"]);
			for (const providerContext of contexts)
				expect(providerContext).not.toMatch(/Alice|Bob|Later typist|herdr-client|input-author|metadata|verified/);
		},
	);

	it("restores exact compaction-staged text and capture promise on delayed metadata rejection", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const context = createSubmissionUI(harness);
		let rejectCapture!: (error: Error) => void;
		const submissionPromise = new Promise<InputSubmission>((_, reject) => {
			rejectCapture = reject;
		});
		// The UI owns immediate observation when acceptance precedes eventual replay.
		void submissionPromise.catch(() => {});
		prototype.queueCompactionMessage.call(context, " original input ", "followUp", submissionPromise);
		const staged = context.compactionQueuedMessages[0];
		const promptSpy = vi.spyOn(harness.session, "prompt");
		const flush = prototype.flushCompactionQueue.call(context);
		context.compactionQueuedMessages.push({ text: "later input", mode: "steer" });
		rejectCapture(new Error("capture failed"));
		await flush;
		expect(promptSpy).not.toHaveBeenCalled();
		expect(context.compactionQueuedMessages).toEqual([staged, { text: "later input", mode: "steer" }]);
		expect(context.compactionQueuedMessages[0].submissionPromise).toBe(submissionPromise);
		expect(context.compactionQueueTransfers).toBe(0);
		expect(context.showError).toHaveBeenCalledWith("Failed to send queued message: capture failed");
		expect(harness.sessionManager.getEntries()).toEqual([]);
	});

	it.each(["steer", "followUp"] as const)(
		"restores %s text ahead of a newer draft when delayed capture rejects",
		async (mode) => {
			const responseStarted = gate();
			const responseRelease = gate();
			let rejectCapture!: (error: Error) => void;
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					responseStarted.release();
					await responseRelease.promise;
					return fauxAssistantMessage("done");
				},
			]);
			const running = harness.session.prompt("start", { source: "rpc" });
			await responseStarted.promise;
			const context = createSubmissionUI(harness);
			vi.spyOn(harness.session, "captureInputSubmission").mockImplementation(
				() =>
					new Promise((_, reject) => {
						rejectCapture = reject;
					}),
			);
			const promptSpy = vi.spyOn(harness.session, "prompt");
			let submit: Promise<void> | undefined;
			try {
				context.editor.setText("rejected input");
				submit =
					mode === "steer"
						? context.defaultEditor.onSubmit?.("rejected input")
						: prototype.handleFollowUp.call(context);
				expect(context.inputSubmissionTransfers).toBe(1);
				context.editor.setText("new draft");
				rejectCapture(new Error("capture failed"));
				await submit;
				expect(context.editor.getText()).toBe("rejected input\n\nnew draft");
				expect(context.showError).toHaveBeenCalledWith("Failed to capture input submission: capture failed");
				expect(context.inputSubmissionTransfers).toBe(0);
				expect(promptSpy).not.toHaveBeenCalled();
				expect(harness.session.pendingMessageCount).toBe(0);
			} finally {
				responseRelease.release();
				await running;
			}
		},
	);

	// R2 regression for Smarty-Pants-Inc/smarty-dev#4078: capture synchronously invokes the native bound abort.
	it.each(
		(["followUp", "steer"] as const).flatMap((mode) =>
			["", "Bob draft", "same"].map((newerDraft) => ({ mode, newerDraft })),
		),
	)(
		"restores $mode once during synchronous capture abort (newer draft: '$newerDraft')",
		async ({ mode, newerDraft }) => {
			const responseStarted = gate();
			const responseRelease = gate();
			let context!: SubmissionUI;
			const observations: Array<{
				text: string;
				source: string;
				mode?: string;
				draft: string;
				history: string[];
				transfers: number;
				capturing: number;
				restored: string;
				cancelled: boolean;
			}> = [];
			const inputs: string[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", (event, ctx) => {
							if (event.source !== "interactive") return;
							const capture = [...context.capturingStreamingInputs][0];
							const before = {
								text: event.text,
								source: event.source,
								mode: event.streamingBehavior,
								draft: ctx.ui.getEditorText(),
								history: vi.mocked(context.editor.addToHistory).mock.calls.map(([text]) => text),
								transfers: context.inputSubmissionTransfers,
								capturing: context.capturingStreamingInputs.size,
							};
							if (newerDraft) ctx.ui.setEditorText(newerDraft);
							ctx.abort();
							observations.push({ ...before, restored: ctx.ui.getEditorText(), cancelled: capture.cancelled });
							return { metadata: { author: { name: "Alice", source: "herdr-client", verified: false } } };
						});
						pi.on("input", (event) => {
							inputs.push(event.text);
						});
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			context = createSubmissionUI(harness);
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: prototype.createExtensionUIContext.call(context),
				abortHandler: () => {
					context.restoreQueuedMessagesToEditor({ abort: true });
				},
			});
			harness.setResponses([
				async () => {
					responseStarted.release();
					await responseRelease.promise;
					return fauxAssistantMessage("RPC response");
				},
			]);
			const running = harness.session.prompt("initial RPC", { source: "rpc" });
			await responseStarted.promise;
			const abortSpy = vi.spyOn(harness.session, "abort");
			const promptSpy = vi.spyOn(harness.session, "prompt");
			let submitted: Promise<void> | undefined;
			try {
				context.editor.setText("same");
				submitted =
					mode === "followUp" ? prototype.handleFollowUp.call(context) : context.defaultEditor.onSubmit!("same");
				// Observe in the accepting call, before the capture promise can settle or enter native queues.
				expect.soft(context.editor.getText()).toBe(newerDraft ? `same\n\n${newerDraft}` : "same");
				expect(context.inputSubmissionTransfers).toBe(1);
				expect(context.capturingStreamingInputs.size).toBe(0);
				expect(harness.session.pendingMessageCount).toBe(0);
				await submitted;
				expect.soft(observations).toEqual([
					{
						text: "same",
						source: "interactive",
						mode,
						draft: "",
						history: ["same"],
						transfers: 1,
						capturing: 1,
						restored: newerDraft ? `same\n\n${newerDraft}` : "same",
						cancelled: true,
					},
				]);
				expect.soft(context.editor.getText()).toBe(newerDraft ? `same\n\n${newerDraft}` : "same");
				expect(context.inputSubmissionTransfers).toBe(0);
				expect(abortSpy).toHaveBeenCalledTimes(1);
				expect(promptSpy).not.toHaveBeenCalled();
				expect(context.showError).not.toHaveBeenCalled();
			} finally {
				responseRelease.release();
				await submitted;
				await running;
				await harness.session.waitForIdle();
			}
			expect(getUserTexts(harness)).toEqual(["initial RPC"]);
			expect(inputs).toEqual(["initial RPC"]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	// R2 control for Smarty-Pants-Inc/smarty-dev#4078: equal text is not equal editor ownership.
	it.each(["followUp", "steer"] as const)(
		"restores a native queued %s and a genuinely separate identical draft as two copies",
		async (mode) => {
			const responseStarted = gate();
			const responseRelease = gate();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", (event) => {
							if (event.source !== "interactive") return;
							return { metadata: { author: { name: "Alice", source: "herdr-client", verified: false } } };
						});
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					responseStarted.release();
					await responseRelease.promise;
					return fauxAssistantMessage("RPC response");
				},
			]);
			const running = harness.session.prompt("initial RPC", { source: "rpc" });
			await responseStarted.promise;
			const context = createSubmissionUI(harness);
			try {
				context.editor.setText("same");
				await (mode === "followUp"
					? prototype.handleFollowUp.call(context)
					: context.defaultEditor.onSubmit!("same"));
				expect(context.editor.getText()).toBe("");
				expect(harness.session.pendingMessageCount).toBe(1);
				context.editor.setText("same");
				expect(context.restoreQueuedMessagesToEditor({ abort: true })).toBe(1);
				expect(context.editor.getText()).toBe("same\n\nsame");
				prototype.handleDequeue.call(context);
				expect(context.editor.getText()).toBe("same\n\nsame");
				expect(harness.session.pendingMessageCount).toBe(0);
				expect(context.inputSubmissionTransfers).toBe(0);
				expect(context.capturingStreamingInputs.size).toBe(0);
			} finally {
				responseRelease.release();
				await running;
				await harness.session.waitForIdle();
			}
			expect(getUserTexts(harness)).toEqual(["initial RPC"]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	// F2 regression for Smarty-Pants-Inc/smarty-dev#4078: actual dequeue cancels capture before native transfer.
	it.each(["followUp", "steer"] as const)(
		"does not resurrect a dequeued %s capture after Bob submits edited text",
		async (mode) => {
			const responseStarted = gate();
			const responseRelease = gate();
			const captureStarted = gate();
			const captureRelease = gate();
			let currentAuthor = "Alice";
			const captures: string[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", async (event) => {
							if (event.source !== "interactive") return;
							const name = currentAuthor;
							captures.push(name);
							if (name === "Alice") {
								captureStarted.release();
								await captureRelease.promise;
							}
							return { metadata: { author: { name, source: "herdr-client", verified: false } } };
						});
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					responseStarted.release();
					await responseRelease.promise;
					return fauxAssistantMessage("RPC response");
				},
				fauxAssistantMessage("Bob response"),
				fauxAssistantMessage("unexpected resurrected response"),
			]);
			const running = harness.session.prompt("initial RPC", { source: "rpc" });
			await responseStarted.promise;
			const context = createSubmissionUI(harness);
			context.editor.setText("same");
			const alice =
				mode === "followUp" ? prototype.handleFollowUp.call(context) : context.defaultEditor.onSubmit!("same");
			await captureStarted.promise;
			try {
				expect(context.inputSubmissionTransfers).toBe(1);
				expect(context.editor.getText()).toBe("");
				const capturing = {
					steering: mode === "steer" ? ["same"] : [],
					followUp: mode === "followUp" ? ["same"] : [],
				};
				expect.soft(prototype.getAllQueuedMessages.call(context)).toEqual(capturing);
				expect.soft(context.updatePendingMessagesDisplay).toHaveLastReturnedWith(capturing);
				prototype.handleDequeue.call(context);
				expect.soft(context.editor.getText(), "dequeue must restore a capture-stage submission").toBe("same");
				expect.soft(context.showStatus).toHaveBeenCalledWith("Restored 1 queued message to editor");
				expect(context.inputSubmissionTransfers).toBe(1);
				prototype.handleDequeue.call(context);
				expect.soft(context.editor.getText(), "repeated dequeue must not restore twice").toBe("same");
				expect(context.inputSubmissionTransfers).toBe(1);
				expect(context.showStatus).toHaveBeenLastCalledWith("No queued messages to restore");
				expect(harness.session.pendingMessageCount).toBe(0);
				currentAuthor = "Bob";
				context.editor.setText("replacement");
				await context.defaultEditor.onSubmit!("replacement");
				expect(harness.session.pendingMessageCount).toBe(1);
				expect(context.inputSubmissionTransfers).toBe(1);
				expect
					.soft(context.updatePendingMessagesDisplay)
					.toHaveLastReturnedWith({ steering: ["replacement"], followUp: [] });
				captureRelease.release();
				await alice;
				expect.soft(harness.session.pendingMessageCount, "old capture must not reenter native queues").toBe(1);
				expect.soft(prototype.getAllQueuedMessages.call(context)).toEqual({
					steering: ["replacement"],
					followUp: [],
				});
				expect(context.editor.getText()).toBe("");
			} finally {
				captureRelease.release();
				await alice;
				responseRelease.release();
				await running;
			}
			expect.soft(getUserTexts(harness)).toEqual(["initial RPC", "replacement"]);
			expect
				.soft(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom"))
				.toMatchObject([{ customType: "input-author", data: { author: { name: "Bob" } } }]);
			expect(captures).toEqual(["Alice", "Bob"]);
			expect(context.inputSubmissionTransfers).toBe(0);
			expect(context.showError).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(2);
		},
	);

	// F2 late-rejection regression for Smarty-Pants-Inc/smarty-dev#4078.
	it.each(["followUp", "steer"] as const)(
		"does not restore a cancelled %s original over Bob's draft when the old capture rejects",
		async (mode) => {
			const responseStarted = gate();
			const responseRelease = gate();
			let rejectCapture!: (error: Error) => void;
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					responseStarted.release();
					await responseRelease.promise;
					return fauxAssistantMessage("done");
				},
			]);
			const running = harness.session.prompt("initial RPC", { source: "rpc" });
			await responseStarted.promise;
			const context = createSubmissionUI(harness);
			vi.spyOn(harness.session, "captureInputSubmission").mockImplementation(
				() =>
					new Promise((_, reject) => {
						rejectCapture = reject;
					}),
			);
			context.editor.setText("same");
			const alice =
				mode === "followUp" ? prototype.handleFollowUp.call(context) : context.defaultEditor.onSubmit!("same");
			try {
				prototype.handleDequeue.call(context);
				expect.soft(context.editor.getText()).toBe("same");
				expect(context.inputSubmissionTransfers).toBe(1);
				prototype.handleDequeue.call(context);
				expect.soft(context.editor.getText()).toBe("same");
				expect(context.inputSubmissionTransfers).toBe(1);
				context.editor.setText("Bob draft");
				rejectCapture(new Error("late capture failure"));
				await alice;
				expect(context.editor.getText()).toBe("Bob draft");
				expect(context.showError).not.toHaveBeenCalled();
				expect(harness.session.pendingMessageCount).toBe(0);
				expect(context.inputSubmissionTransfers).toBe(0);
			} finally {
				rejectCapture(new Error("late capture failure"));
				await alice;
				responseRelease.release();
				await running;
			}
			expect(getUserTexts(harness)).toEqual(["initial RPC"]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	// F2 control for Smarty-Pants-Inc/smarty-dev#4078: asynchronous capture without clear still transfers.
	it.each(["followUp", "steer"] as const)(
		"delivers an uncleared asynchronous %s capture with Alice once",
		async (mode) => {
			const responseStarted = gate();
			const responseRelease = gate();
			const captureStarted = gate();
			const captureRelease = gate();
			let captures = 0;
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", async (event) => {
							if (event.source !== "interactive") return;
							captures++;
							captureStarted.release();
							await captureRelease.promise;
							return { metadata: { author: { name: "Alice", source: "herdr-client", verified: false } } };
						});
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					responseStarted.release();
					await responseRelease.promise;
					return fauxAssistantMessage("RPC response");
				},
				fauxAssistantMessage("Alice response"),
			]);
			const running = harness.session.prompt("initial RPC", { source: "rpc" });
			await responseStarted.promise;
			const context = createSubmissionUI(harness);
			context.editor.setText("same");
			const alice =
				mode === "followUp" ? prototype.handleFollowUp.call(context) : context.defaultEditor.onSubmit!("same");
			await captureStarted.promise;
			try {
				expect(harness.session.pendingMessageCount).toBe(0);
				context.editor.setText("Bob draft");
				captureRelease.release();
				await alice;
				expect(harness.session.pendingMessageCount).toBe(1);
				expect(context.editor.getText()).toBe("Bob draft");
			} finally {
				captureRelease.release();
				await alice;
				responseRelease.release();
				await running;
			}
			expect(getUserTexts(harness)).toEqual(["initial RPC", "same"]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toMatchObject([
				{ customType: "input-author", data: { author: { name: "Alice" } } },
			]);
			expect(context.inputSubmissionTransfers).toBe(0);
			expect(context.showError).not.toHaveBeenCalled();
			expect(captures).toBe(1);
			expect(harness.faux.state.callCount).toBe(2);
		},
	);

	it("does not capture an extension command routed through the editor", async () => {
		let captureCalls = 0;
		let commandCalls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input_submission", () => {
						captureCalls++;
					});
					pi.registerCommand("local", {
						handler: async () => {
							commandCalls++;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const context = createSubmissionUI(harness);
		await context.defaultEditor.onSubmit?.("/local");
		expect(context.pendingUserInputs).toEqual([{ text: "/local", submissionPromise: undefined }]);
		await harness.session.prompt(context.pendingUserInputs[0].text);
		expect(commandCalls).toBe(1);
		expect(captureCalls).toBe(0);
		expect(harness.sessionManager.getEntries()).toEqual([]);
	});
});
