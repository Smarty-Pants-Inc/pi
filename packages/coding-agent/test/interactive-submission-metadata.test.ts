import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import inputAuthor from "../examples/extensions/input-author.ts";
import type { AgentSessionEvent, ExtensionBindings } from "../src/core/agent-session.ts";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
} from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext, InputSubmission } from "../src/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./suite/harness.ts";

type QueuedInput = { text: string; mode: "steer" | "followUp"; submissionPromise?: Promise<InputSubmission> };
type PendingInput = { text: string; submissionPromise?: Promise<InputSubmission> };
type CapturingStreamingInput = { text: string; mode: "steer" | "followUp"; cancelled: boolean };
type SubmissionUI = {
	session: Harness["session"];
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: {
		getText: () => string;
		setText: (text: string) => void;
		addToHistory: (text: string) => void;
		onSubmit?: (text: string) => Promise<void>;
	};
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
	getUserInput(this: SubmissionUI): Promise<string>;
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
	context.editor.onSubmit = context.defaultEditor.onSubmit;
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

	// R1 F1: Smarty-Pants-Inc/smarty-dev#4078. Actual compaction ends with capture still pending.
	it.each(
		(["steer", "followUp"] as const).flatMap((mode) =>
			[false, true].flatMap((willRetry) =>
				(["dequeue", "abort", "none"] as const).flatMap((cancel) =>
					(cancel === "none" ? [false] : [false, true]).map((reject) => ({ mode, willRetry, cancel, reject })),
				),
			),
		),
	)(
		"settles real compaction replay: $mode retry=$willRetry cancel=$cancel reject=$reject",
		async ({ mode, willRetry, cancel, reject }) => {
			const compactStarted = gate();
			const compactRelease = gate();
			const captureStarted = gate();
			const captureRelease = gate();
			const harness = await createHarness({
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", async (event) => {
							if (event.source !== "interactive") return;
							captureStarted.release();
							await captureRelease.promise;
							return { metadata: { author: { name: "Alice", source: "herdr-client", verified: false } } };
						});
						pi.on("session_before_compact", async (event) => {
							compactStarted.release();
							await compactRelease.promise;
							return {
								compaction: {
									summary: "compacted",
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
			if (reject) {
				// Runner reports extension-hook errors and continues; reject the host capture promise itself.
				const capture = harness.session.captureInputSubmission.bind(harness.session);
				vi.spyOn(harness.session, "captureInputSubmission").mockImplementation(async (text, options) => {
					await capture(text, options);
					throw new Error("late capture failure");
				});
			}
			harness.sessionManager.appendMessage({ role: "user", content: "old question", timestamp: 1 });
			harness.sessionManager.appendMessage(fauxAssistantMessage("old response"));
			harness.session.refreshContext();
			const context = createSubmissionUI(harness);
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: prototype.createExtensionUIContext.call(context),
				abortHandler: () => {
					context.restoreQueuedMessagesToEditor({ abort: true });
				},
			});
			const compacting = harness.session.compact();
			await compactStarted.promise;
			context.editor.setText("Alice input");
			await (mode === "steer"
				? context.defaultEditor.onSubmit!("Alice input")
				: prototype.handleFollowUp.call(context));
			await captureStarted.promise;
			compactRelease.release();
			await compacting;
			expect(harness.session.isCompacting).toBe(false);
			const compactedUsers = getUserTexts(harness);
			harness.setResponses([fauxAssistantMessage("Alice response"), fauxAssistantMessage("queued response")]);
			const prompt = vi.spyOn(harness.session, "prompt");
			const replay = prototype.flushCompactionQueue.call(context, { willRetry });
			expect
				.soft(prototype.getAllQueuedMessages.call(context)[mode === "steer" ? "steering" : "followUp"])
				.toEqual(["Alice input"]);
			if (cancel === "dequeue") prototype.handleDequeue.call(context);
			else if (cancel === "abort") harness.session.extensionRunner.createCommandContext().abort();
			if (cancel !== "none") {
				expect.soft(context.editor.getText()).toBe("Alice input");
				context.editor.setText("Bob draft");
			}
			captureRelease.release();
			await replay;
			if (cancel === "none" && willRetry) await harness.session.prompt("resume retry", { source: "rpc" });
			await harness.session.waitForIdle();
			await vi.waitFor(() => expect(context.compactionQueueTransfers).toBe(0));
			if (cancel === "none") {
				expect(getUserTexts(harness)).toContain("Alice input");
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toMatchObject([
					{ customType: "input-author", data: { author: { name: "Alice" } } },
				]);
			} else {
				expect(prompt).not.toHaveBeenCalled();
				expect(harness.session.pendingMessageCount).toBe(0);
				expect(getUserTexts(harness)).toEqual(compactedUsers);
				expect(harness.faux.state.callCount).toBe(0);
				expect(context.editor.getText()).toBe("Bob draft");
				expect(context.compactionQueuedMessages).toEqual([]);
			}
			expect(context.showError).not.toHaveBeenCalled();
		},
	);

	// R1 F1 native awaits: Smarty-Pants-Inc/smarty-dev#4078. Handoff is not entry into preflight.
	it.each(["prompt", "steer", "followUp"] as const)(
		"cancels replay during native %s input preflight",
		async (route) => {
			const inputStarted = gate();
			const inputRelease = gate();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", async () => {
							inputStarted.release();
							await inputRelease.promise;
						});
					},
				],
			});
			harnesses.push(harness);
			const context = createSubmissionUI(harness);
			prototype.queueCompactionMessage.call(context, "Alice input", route === "followUp" ? "followUp" : "steer");
			harness.setResponses([fauxAssistantMessage("unexpected")]);
			const replay = prototype.flushCompactionQueue.call(context, { willRetry: route !== "prompt" });
			await inputStarted.promise;
			expect
				.soft(prototype.getAllQueuedMessages.call(context)[route === "followUp" ? "followUp" : "steering"])
				.toEqual(["Alice input"]);
			prototype.handleDequeue.call(context);
			expect.soft(context.editor.getText()).toBe("Alice input");
			context.editor.setText("Bob draft");
			inputRelease.release();
			await replay;
			await harness.session.waitForIdle();
			await vi.waitFor(() => expect(context.compactionQueueTransfers).toBe(0));
			expect(context.compactionQueuedMessages).toEqual([]);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.faux.state.callCount).toBe(0);
			expect(context.editor.getText()).toBe("Bob draft");
			expect(context.showError).not.toHaveBeenCalled();
		},
	);

	// Class ownership: Smarty-Pants-Inc/smarty-dev#4078. Direct queue callers have no TUI capture object.
	it.each(["steer", "followUp"] as const)("owns direct %s before its capture hook aborts", async (route) => {
		let context!: SubmissionUI;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input_submission", (_event, ctx) => {
						ctx.ui.setEditorText("same");
						ctx.abort();
					});
				},
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
		const submitted = harness.session[route]("same");
		expect.soft(context.editor.getText()).toBe("same\n\nsame");
		await expect(submitted).rejects.toThrow();
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	// Class control: Smarty-Pants-Inc/smarty-dev#4078. Ordinary abort alone retains direct accepted input.
	it.each(["steer", "followUp"] as const)("retains direct %s capture across abort without clear", async (route) => {
		const captureStarted = gate();
		const captureRelease = gate();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input_submission", async (event) => {
						if (event.source !== "interactive") return;
						captureStarted.release();
						await captureRelease.promise;
						return { metadata: { author: { name: "Alice", source: "herdr-client", verified: false } } };
					});
				},
				inputAuthor,
			],
		});
		harnesses.push(harness);
		const submitted = harness.session[route]("accepted input");
		await captureStarted.promise;
		expect.soft(harness.session.pendingMessageCount).toBe(1);
		await harness.session.abort();
		captureRelease.release();
		await submitted;
		expect(harness.session.pendingMessageCount).toBe(1);
		harness.setResponses([fauxAssistantMessage("RPC response"), fauxAssistantMessage("Alice response")]);
		await harness.session.prompt("continue", { source: "rpc" });
		expect(getUserTexts(harness)).toEqual(["continue", "accepted input"]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toMatchObject([
			{ customType: "input-author", data: { author: { name: "Alice" } } },
		]);
	});

	// R1 F2 and class check: Smarty-Pants-Inc/smarty-dev#4078. Equal drafts remain distinct.
	it.each(
		[
			"compaction Enter",
			"compaction followUp",
			"idle Enter",
			"idle followUp",
			"waiting Enter",
			"waiting followUp",
		].flatMap((path) => ["", "Bob draft", "same"].map((draft) => ({ path, draft }))),
	)("owns input before synchronous abort in $path (draft='$draft')", async ({ path, draft }) => {
		let context!: SubmissionUI;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input_submission", (_event, ctx) => {
						ctx.ui.setEditorText(draft);
						ctx.abort();
					});
				},
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
		vi.spyOn(harness.session, "isCompacting", "get").mockReturnValue(path.startsWith("compaction"));
		if (path.startsWith("waiting")) void prototype.getUserInput.call(context);
		context.editor.setText("same");
		await (path.endsWith("followUp")
			? prototype.handleFollowUp.call(context)
			: context.defaultEditor.onSubmit!("same"));
		expect(context.editor.getText()).toBe(draft ? `same\n\n${draft}` : "same");
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(context.pendingUserInputs).toEqual([]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	// R1 F3: Smarty-Pants-Inc/smarty-dev#4078. Inspect retained live children, never a rebuild.
	it.each(["before", "after", "none"])(
		"keeps live author publication atomic (throwing observer: %s)",
		async (order) => {
			initTheme("dark");
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", () => ({
							metadata: { author: { name: "Alice", source: "herdr-client", verified: false } },
						}));
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			const chatContainer = new Container();
			const live = Object.assign(Object.create(InteractiveMode.prototype), {
				runtimeHost: { session: harness.session },
				chatContainer,
				isInitialized: true,
				footer: { invalidate: () => {} },
				pendingTools: new Map(),
				toolOutputExpanded: false,
				outputPad: 1,
				ui: { requestRender: () => {}, terminal: { setProgress: () => {} } },
				entriesRenderedByBoundaryCompaction: new Set(),
				userPublicationComponents: new Map(),
				stagedUserComponents: new Map(),
				getMarkdownTransformers: () => [],
				updatePendingMessagesDisplay: () => {},
				clearStatusIndicator: () => {},
				checkShutdownRequested: async () => {},
			}) as {
				handleEvent: (event: AgentSessionEvent) => Promise<void>;
				addMessageToChat: (message: AgentMessage) => void;
			};
			const throwing = (event: AgentSessionEvent) => {
				if (event.type === "message_start" && event.message.role === "user") throw new Error("publication failed");
				if (event.type === "user_message_publication_failed") throw new Error("rollback observer failed");
			};
			if (order === "before") harness.session.subscribe(throwing);
			harness.session.subscribe((event) => {
				void live.handleEvent(event);
			});
			if (order === "after") harness.session.subscribe(throwing);
			harness.setResponses([fauxAssistantMessage("Alice response")]);
			await harness.session.prompt("Alice input");
			const users = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "user");
			expect(users).toHaveLength(order === "none" ? 1 : 0);
			live.addMessageToChat({ role: "user", content: "later input", timestamp: 2 });
			const output = stripAnsi(chatContainer.render(100).join("\n"));
			expect(output).toContain("later input");
			if (order === "none") {
				expect(output.indexOf("Alice:")).toBeLessThan(output.indexOf("Alice input"));
				expect(output).toContain("Alice response");
			} else {
				expect(output).not.toContain("Alice:");
				expect(harness.session.state.errorMessage).toBe("publication failed");
			}
		},
	);

	// Review P2, Smarty-Pants-Inc/smarty-dev#4078: exercise the real idle loop and runtime replacement.
	it.each(["deliver", "dequeue", "command"] as const)(
		"fences idle input preflight until %s settlement",
		async (action) => {
			initTheme("dark");
			const inputStarted = gate();
			const inputRelease = gate();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", async () => {
							inputStarted.release();
							await inputRelease.promise;
						});
						pi.registerCommand("idle-command", {
							handler: async () => {
								inputStarted.release();
								await inputRelease.promise;
							},
						});
					},
				],
			});
			harnesses.push(harness);
			const services: AgentSessionServices = {
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			};
			const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => ({
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: harness.getModel(),
					noTools: "all",
				})),
				services,
				diagnostics: [],
			});
			const runtime = new AgentSessionRuntime(harness.session, services, factory);
			const mode = new InteractiveMode(runtime);
			const internal = mode as unknown as {
				bindCurrentSessionExtensions(): Promise<void>;
				setupEditorSubmitHandler(): void;
				defaultEditor: { onSubmit?: (text: string) => Promise<void> };
				editor: { getText(): string; setText(text: string): void };
				userInputInFlight: boolean;
				stagingAudit?: (kind: string) => void;
			};
			let bindings: ExtensionBindings | undefined;
			const bind = harness.session.bindExtensions.bind(harness.session);
			vi.spyOn(harness.session, "bindExtensions").mockImplementation(async (options) => {
				bindings = options;
				await bind(options);
			});
			await internal.bindCurrentSessionExtensions();
			internal.setupEditorSubmitHandler();
			vi.spyOn(mode, "init").mockResolvedValue();
			// Suppress only optional startup background work, not native input/replacement code.
			internal.stagingAudit = () => {};
			const settled = gate();
			const exit = new Error("test loop complete");
			const getInput = mode.getUserInput.bind(mode);
			vi.spyOn(mode, "getUserInput")
				.mockImplementationOnce(getInput)
				.mockImplementation(async () => {
					settled.release();
					throw exit;
				});
			harness.setResponses([fauxAssistantMessage("Alice response")]);
			const run = mode.run().catch((error: unknown) => {
				expect(error).toBe(exit);
			});
			await internal.defaultEditor.onSubmit!(action === "command" ? "/idle-command" : "Alice input");
			await inputStarted.promise;
			try {
				expect.soft(internal.userInputInFlight).toBe(action !== "command");
				expect.soft(bindings?.hasPendingInput?.()).toBe(action !== "command");
				if (action === "command") {
					// Command ownership has transferred, even though its handler has not settled.
					await expect(runtime.newSession()).resolves.toEqual({ cancelled: false });
					expect(runtime.session).not.toBe(harness.session);
				} else {
					await expect(runtime.newSession()).rejects.toThrow("OWNER_TUI_TRANSFER_PENDING");
					expect(runtime.session).toBe(harness.session);
				}
				if (action === "dequeue") {
					prototype.handleDequeue.call(mode as unknown as SubmissionUI);
					expect(internal.editor.getText()).toBe("Alice input");
					await expect(runtime.newSession()).rejects.toThrow("OWNER_TUI_TRANSFER_PENDING");
				}
			} finally {
				inputRelease.release();
				await settled.promise;
				await run;
			}
			expect(getUserTexts(harness)).toEqual(action === "deliver" ? ["Alice input"] : []);
			expect(internal.userInputInFlight).toBe(false);
			if (action !== "command") expect(bindings?.hasPendingInput?.()).toBe(false);
			await expect(runtime.newSession()).resolves.toEqual({ cancelled: false });
			expect(runtime.session).not.toBe(harness.session);
			mode.stop();
			await runtime.dispose();
		},
	);

	// Review P1, Smarty-Pants-Inc/smarty-dev#4078: dispatched commands cannot be withdrawn.
	it.each(["dequeue", "abort", "none"] as const)(
		"transfers an asynchronous replay command before dispatch (%s)",
		async (cancel) => {
			const started = gate();
			const release = gate();
			let calls = 0;
			let effects = 0;
			let transfersAtEntry = -1;
			let context!: SubmissionUI;
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.registerCommand("slow", {
							handler: async () => {
								calls++;
								transfersAtEntry = context.compactionQueuedMessages.length;
								started.release();
								await release.promise;
								effects++;
								pi.sendMessage(
									{ customType: "command-effect", content: "triggered once", display: false },
									{ triggerTurn: true },
								);
							},
						});
					},
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
			harness.setResponses([fauxAssistantMessage("command response")]);
			// Normal editor commands bypass compaction staging. Explicit host staging exercises replay.
			prototype.queueCompactionMessage.call(context, "/slow", "steer");
			const replay = prototype.flushCompactionQueue.call(context);
			await started.promise;
			try {
				expect.soft(transfersAtEntry).toBe(0);
				context.editor.setText("Bob draft");
				if (cancel === "dequeue") prototype.handleDequeue.call(context);
				else if (cancel === "abort") harness.session.extensionRunner.createCommandContext().abort();
				expect.soft(context.editor.getText()).toBe("Bob draft");
				expect.soft(context.compactionQueuedMessages).toEqual([]);
			} finally {
				release.release();
				await replay;
				await harness.session.waitForIdle();
			}
			await prototype.flushCompactionQueue.call(context);
			expect(calls).toBe(1);
			expect(effects).toBe(1);
			expect(harness.faux.state.callCount).toBe(1);
			expect(context.editor.getText()).toBe("Bob draft");
			expect(context.showError).not.toHaveBeenCalled();
		},
	);

	it("never dispatches a replay command cancelled while constructing command context", async () => {
		let calls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("cancelled", {
						handler: async () => {
							calls++;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const context = createSubmissionUI(harness);
		const createContext = harness.session.extensionRunner.createCommandContext.bind(harness.session.extensionRunner);
		vi.spyOn(harness.session.extensionRunner, "createCommandContext").mockImplementation(() => {
			prototype.handleDequeue.call(context);
			return createContext();
		});
		prototype.queueCompactionMessage.call(context, "/cancelled", "steer");
		await prototype.flushCompactionQueue.call(context);
		expect(calls).toBe(0);
		expect(context.editor.getText()).toBe("/cancelled");
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(context.showError).not.toHaveBeenCalled();
	});

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
		expect(context.pendingUserInputs).toMatchObject([{ text: "/local", submissionPromise: undefined }]);
		await harness.session.prompt(context.pendingUserInputs[0].text);
		expect(commandCalls).toBe(1);
		expect(captureCalls).toBe(0);
		expect(harness.sessionManager.getEntries()).toEqual([]);
	});
});
