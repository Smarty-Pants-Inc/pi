import { expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const files = vi.hoisted(() => vi.fn<() => Promise<string[] | null>>());
vi.mock("../src/utils/clipboard.ts", () => ({
	readClipboardFilePaths: files,
	readClipboardText: vi.fn(),
	copyToClipboard: vi.fn(),
}));
vi.mock("../src/utils/clipboard-image.ts", () => ({ readClipboardImage: vi.fn(), extensionForImageMimeType: vi.fn() }));

// PR #141 cut #9: an older harmless command must not change current filename-paste admission.
it.each(["!cat ", '!cat "DEST"'])(
	"keeps current %s shell context after old command completion",
	async (currentText) => {
		let text = "!sleep 2";
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const insert = vi.fn();
		const editor = {
			getText: () => text,
			getCursor: () => ({ line: 0, col: currentText.includes("DEST") ? currentText.indexOf("DEST") : text.length }),
			insertTextAtCursor: insert,
			addToHistory: vi.fn(),
			setText: (value: string) => {
				text = value;
			},
			onSubmit: undefined as ((value: string) => Promise<void>) | undefined,
		};
		const native = vi.fn(async () => {
			await held;
		});
		const mode = Object.create(InteractiveMode.prototype) as {
			setupEditorSubmitHandler(): void;
			handleClipboardPaste(): Promise<void>;
			isBashMode: boolean;
		};
		Object.assign(mode, {
			editor,
			defaultEditor: editor,
			isBashMode: true,
			runtimeHost: { session: { isBashRunning: false } },
			handleBashCommand: native,
			showWarning: vi.fn(),
			showError: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		mode.setupEditorSubmitHandler();
		const command = editor.onSubmit!("!sleep 2");
		text = currentText;
		release();
		await command;
		files.mockResolvedValue(["/synthetic/literal$(punctuation).txt"]);
		await mode.handleClipboardPaste();
		expect(mode.isBashMode).toBe(true);
		if (currentText.includes("DEST")) expect(insert).not.toHaveBeenCalled();
		else expect(insert).toHaveBeenCalledExactlyOnceWith("'/synthetic/literal$(punctuation).txt'");
		expect(native).toHaveBeenCalledExactlyOnceWith("sleep 2", false);
	},
);

it("uses current shell syntax for filename paste even when cached mode is stale", async () => {
	const insert = vi.fn();
	const mode = Object.create(InteractiveMode.prototype) as { handleClipboardPaste(): Promise<void> };
	Object.assign(mode, {
		editor: { getText: () => "!cat ", getCursor: () => ({ line: 0, col: 5 }), insertTextAtCursor: insert },
		isBashMode: false,
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	});
	files.mockResolvedValue(["/synthetic/literal$(punctuation).txt"]);
	await mode.handleClipboardPaste();
	expect(insert).toHaveBeenCalledExactlyOnceWith("'/synthetic/literal$(punctuation).txt'");
});
