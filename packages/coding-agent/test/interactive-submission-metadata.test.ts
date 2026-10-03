import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import inputAuthor from "../examples/extensions/input-author.ts";
import type { InputSubmission } from "../src/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

type QueuedInput = { text: string; mode: "steer" | "followUp"; submissionPromise?: Promise<InputSubmission> };
type PendingInput = { text: string; submissionPromise?: Promise<InputSubmission> };
type SubmissionUI = {
	session: Harness["session"];
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { getText: () => string; setText: (text: string) => void; addToHistory: (text: string) => void };
	pendingUserInputs: PendingInput[];
	compactionQueuedMessages: QueuedInput[];
	compactionQueueTransfers: number;
	inputSubmissionTransfers: number;
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
	) => Promise<InputSubmission | undefined | null>;
	updatePendingMessagesDisplay: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
};

type SubmissionUIPrototype = {
	setupEditorSubmitHandler(this: SubmissionUI): void;
	captureEditorSubmission(
		this: SubmissionUI,
		text: string,
		mode?: "steer" | "followUp",
	): Promise<InputSubmission> | undefined;
	submitStreamingInput(this: SubmissionUI, text: string, mode: "steer" | "followUp"): Promise<void>;
	handleFollowUp(this: SubmissionUI): Promise<void>;
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
		captureEditorSubmission: (text, mode) => prototype.captureEditorSubmission.call(context, text, mode),
		submitStreamingInput: (text, mode) => prototype.submitStreamingInput.call(context, text, mode),
		isExtensionCommand: (text) =>
			!!harness.session.extensionRunner.getCommand(text.split(" ")[0].slice(1)) && text.startsWith("/"),
		flushPendingBashComponents: vi.fn(),
		queueCompactionMessage: (text, mode, submissionPromise) =>
			prototype.queueCompactionMessage.call(context, text, mode, submissionPromise),
		awaitInputSubmission: (text, submissionPromise) =>
			prototype.awaitInputSubmission.call(context, text, submissionPromise),
		updatePendingMessagesDisplay: vi.fn(),
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
