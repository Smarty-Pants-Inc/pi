import { describe, expect, it, vi } from "vitest";
import { type ReceivedInput, receiveInput } from "../src/core/received-input.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	runtimeHost: { inputsFenced: boolean };
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
	};
	dispatchEditorInput(this: SubmitContext, input: ReceivedInput): Promise<void>;
	submitEditorInput(this: SubmitContext, input: ReceivedInput): void;
	flushPendingBashComponents: () => void;
	/** No Herdr enrollment in these tests (smarty-dev#2636). */
	captureHerdrSubmit: () => undefined;
	onInputCallback?: (input: ReceivedInput) => void;
	pendingUserInputs: ReceivedInput[];
};

type InputContext = {
	onInputCallback?: (input: ReceivedInput) => void;
	pendingUserInputs: ReceivedInput[];
	getReceivedUserInput(this: InputContext): Promise<ReceivedInput>;
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	dispatchEditorInput(this: SubmitContext, input: ReceivedInput): Promise<void>;
	submitEditorInput(this: SubmitContext, input: ReceivedInput): void;
	getReceivedUserInput(this: InputContext): Promise<ReceivedInput>;
	getUserInput(this: InputContext): Promise<string>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		// smarty-dev#3048, PR #110 R2-7: match the native runtime admission contract.
		runtimeHost: { inputsFenced: false },
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
		},
		dispatchEditorInput: interactiveModePrototype.dispatchEditorInput,
		submitEditorInput: interactiveModePrototype.submitEditorInput,
		flushPendingBashComponents: vi.fn(),
		captureHerdrSubmit: () => undefined,
		pendingUserInputs: [],
	};
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

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs.map((input) => input.text)).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: [receiveInput("queued prompt")],
			getReceivedUserInput: interactiveModePrototype.getReceivedUserInput,
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});
});
