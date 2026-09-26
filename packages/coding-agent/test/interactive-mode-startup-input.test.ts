import { type InputOrigin, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type UserInput = { text: string; origin?: InputOrigin };

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string, origin?: InputOrigin) => void };
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
	flushPendingBashComponents: () => void;
	queueCompactionMessage: (text: string, mode: "steer" | "followUp", origin?: InputOrigin) => void;
	isExtensionCommand: (text: string) => boolean;
	updatePendingMessagesDisplay: () => void;
	ui: { requestRender: () => void };
	onInputCallback?: (input: UserInput) => void;
	pendingUserInputs: UserInput[];
};

type InputContext = {
	onInputCallback?: (input: UserInput) => void;
	pendingUserInputs: UserInput[];
};

type FollowUpContext = {
	editor: {
		getText: () => string;
		getInputOrigin?: () => InputOrigin;
		setText: (text: string) => void;
		addToHistory?: (text: string) => void;
		onSubmit?: (text: string, origin?: InputOrigin) => void;
	};
	session: { isCompacting: boolean; isStreaming: boolean; prompt: (text: string, options?: unknown) => Promise<void> };
	updatePendingMessagesDisplay: () => void;
	ui: { requestRender: () => void };
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<UserInput>;
	handleFollowUp(this: FollowUpContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
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
		flushPendingBashComponents: vi.fn(),
		queueCompactionMessage: vi.fn(),
		isExtensionCommand: () => false,
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
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

		expect(context.pendingUserInputs).toEqual([{ text: "early prompt", origin: undefined }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: [{ text: "queued prompt" }],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({ text: "queued prompt" });
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});
});

describe("InteractiveMode input origin", () => {
	const API: InputOrigin = { kind: "herdr-api", sender: "lead", pane: "p1", session: "s1", id: "7" };

	it("hands the editor origin to the main loop with the submitted text", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("framed", API);
		await context.defaultEditor.onSubmit?.("typed", { kind: "keyboard" });

		const inputContext: InputContext = { pendingUserInputs: context.pendingUserInputs };
		await expect(interactiveModePrototype.getUserInput.call(inputContext)).resolves.toEqual({
			text: "framed",
			origin: API,
		});
		await expect(interactiveModePrototype.getUserInput.call(inputContext)).resolves.toEqual({
			text: "typed",
			origin: { kind: "keyboard" },
		});
	});

	it("records herdr-api for typed text plus a framed paste submitted from the keyboard", async () => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		const terminal = new VirtualTerminal();
		const tui = new TuiMainScreen(terminal);
		const editor = new CustomEditor(tui, defaultEditorTheme, keybindings);
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call({ ...context, defaultEditor: editor });
		tui.setFocus(editor);
		tui.start();
		try {
			terminal.sendInput("a");
			terminal.sendInput("\uFDD0herdr-origin;v=1;kind=api;id=7;sender=lead;pane=p1;session=s1\uFDD1");
			terminal.sendInput("\x1b[200~b\x1b[201~");
			terminal.sendInput("\uFDD0herdr-origin;end;id=7\uFDD1");
			terminal.sendInput("\r");
			await vi.waitFor(() => expect(context.pendingUserInputs).toEqual([{ text: "ab", origin: API }]));

			terminal.sendInput("c");
			terminal.sendInput("\r");
			await vi.waitFor(() =>
				expect(context.pendingUserInputs[1]).toEqual({ text: "c", origin: { kind: "keyboard" } }),
			);
		} finally {
			tui.stop();
			setKeybindings(new KeybindingsManager());
		}
	});

	it("passes origin to steering and compaction queues", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		context.session.isStreaming = true;
		await context.defaultEditor.onSubmit?.("steer", API);
		expect(context.session.prompt).toHaveBeenCalledWith("steer", { streamingBehavior: "steer", origin: API });

		context.session.isCompacting = true;
		await context.defaultEditor.onSubmit?.("queued", API);
		expect(context.queueCompactionMessage).toHaveBeenCalledWith("queued", "steer", API);
	});

	it("reads the editor origin before clearing it for follow-up", async () => {
		let origin: InputOrigin = API;
		const context: FollowUpContext = {
			editor: {
				getText: () => "later",
				getInputOrigin: () => origin,
				setText: vi.fn(() => {
					origin = { kind: "keyboard" };
				}),
				addToHistory: vi.fn(),
				onSubmit: vi.fn(),
			},
			session: { isCompacting: false, isStreaming: true, prompt: vi.fn(async () => {}) },
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await interactiveModePrototype.handleFollowUp.call(context);
		expect(context.session.prompt).toHaveBeenCalledWith("later", { streamingBehavior: "followUp", origin: API });

		origin = API;
		context.session.isStreaming = false;
		await interactiveModePrototype.handleFollowUp.call(context);
		expect(context.editor.onSubmit).toHaveBeenCalledWith("later", API);
	});
});
