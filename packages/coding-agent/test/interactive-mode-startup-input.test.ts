import { describe, expect, it, vi } from "vitest";
import type { InputSubmission } from "../src/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type PendingUserInput = {
	text: string;
	submissionPromise?: Promise<InputSubmission>;
	cancellation?: AbortController;
};

type SubmitContext = {
	inFlightInput?: PendingUserInput;
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
		captureInputSubmission: (
			text: string,
			options?: { streamingBehavior?: "steer" | "followUp" },
		) => Promise<InputSubmission>;
	};
	isExtensionCommand: (text: string) => boolean;
	flushPendingBashComponents: () => void;
	onInputCallback?: (text: string, submissionPromise?: Promise<InputSubmission>) => void;
	pendingUserInputs: PendingUserInput[];
	currentInputSubmission?: Promise<InputSubmission>;
	captureEditorSubmission: (
		text: string,
		streamingBehavior?: "steer" | "followUp",
	) => Promise<InputSubmission> | undefined;
};

type InputContext = {
	inFlightInput?: PendingUserInput;
	onInputCallback?: (text: string, submissionPromise?: Promise<InputSubmission>) => void;
	pendingUserInputs: PendingUserInput[];
	currentInputSubmission?: Promise<InputSubmission>;
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
	captureEditorSubmission(
		this: SubmitContext,
		text: string,
		streamingBehavior?: "steer" | "followUp",
	): Promise<InputSubmission> | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	const context: SubmitContext = {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
			captureInputSubmission: vi.fn(async () => ({ source: "interactive" as const })),
		},
		isExtensionCommand: vi.fn(() => false),
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [],
		captureEditorSubmission: (text, streamingBehavior) =>
			interactiveModePrototype.captureEditorSubmission.call(context, text, streamingBehavior),
	};
	return context;
}

describe("InteractiveMode startup input", () => {
	it("restores a prompt submitted while managed-tool setup is running", () => {
		const context: StartupSubmitContext = {
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
		};

		interactiveModePrototype.handleStartupSubmit.call(context, "early prompt");

		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		expect(context.showStatus).toHaveBeenCalledWith("Startup is still in progress");
	});

	// Regression coverage for Smarty-Pants-Inc/smarty-dev#4078 (Astra F6).
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual([
			{ text: "early prompt", submissionPromise: expect.any(Promise), cancellation: expect.any(AbortController) },
		]);
		const queuedInput = context.pendingUserInputs[0];
		expect(queuedInput.cancellation?.signal.aborted).toBe(false);
		expect(context.session.captureInputSubmission).toHaveBeenCalledWith("early prompt", {
			streamingBehavior: undefined,
		});
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("early prompt");
		expect(context.inFlightInput).toBe(queuedInput);
		expect(context.inFlightInput?.cancellation).toBe(queuedInput.cancellation);
		queuedInput.cancellation?.abort();
		expect(context.inFlightInput?.cancellation?.signal.aborted).toBe(true);
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const submissionPromise = Promise.resolve<InputSubmission>({
			source: "interactive",
			metadata: { author: "Alice" },
		});
		const context: InputContext = {
			pendingUserInputs: [{ text: "queued prompt", submissionPromise }],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.currentInputSubmission).toBe(submissionPromise);
	});

	// Regression coverage for Smarty-Pants-Inc/smarty-dev#4078.
	it("captures attribution before startup input is dequeued by a later typist", async () => {
		let currentAuthor = "Alice";
		const context = createSubmitContext();
		context.session.captureInputSubmission = vi.fn(
			async (): Promise<InputSubmission> => ({ source: "interactive", metadata: { author: currentAuthor } }),
		);
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("same");
		currentAuthor = "Bob";
		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("same");
		await expect(context.currentInputSubmission).resolves.toEqual({
			source: "interactive",
			metadata: { author: "Alice" },
		});
		expect(context.session.captureInputSubmission).toHaveBeenCalledOnce();
	});

	// Regression coverage for Smarty-Pants-Inc/smarty-dev#4078.
	it("keeps public getUserInput string delivery while forwarding a pending submission promise", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		const input = interactiveModePrototype.getUserInput.call(context);
		let resolveSubmission!: (submission: InputSubmission) => void;
		const submissionPromise = new Promise<InputSubmission>((resolve) => {
			resolveSubmission = resolve;
		});
		context.session.captureInputSubmission = vi.fn(() => submissionPromise);
		await context.defaultEditor.onSubmit?.("same");
		await expect(input).resolves.toBe("same");
		expect(context.currentInputSubmission).toBe(submissionPromise);
		expect(context.onInputCallback).toBeUndefined();
		resolveSubmission({ source: "interactive", metadata: { author: "Alice" } });
		await expect(context.currentInputSubmission).resolves.toEqual({
			source: "interactive",
			metadata: { author: "Alice" },
		});
	});

	// Regression coverage for Smarty-Pants-Inc/smarty-dev#4078.
	it("observes delayed capture rejection without losing the queued original text", async () => {
		const context = createSubmitContext();
		let rejectSubmission!: (error: Error) => void;
		const submissionPromise = new Promise<InputSubmission>((_, reject) => {
			rejectSubmission = reject;
		});
		context.session.captureInputSubmission = vi.fn(() => submissionPromise);
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("same");
		const rejected = expect(submissionPromise).rejects.toThrow("capture failed");
		rejectSubmission(new Error("capture failed"));
		await rejected;
		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("same");
		expect(context.currentInputSubmission).toBe(submissionPromise);
	});
});
