import { describe, expect, test, vi } from "vitest";
import { editInExternalEditor } from "../src/modes/interactive/external-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.ts";
import { readClipboardImage } from "../src/utils/clipboard-image.ts";

vi.mock("../src/modes/interactive/external-editor.ts", () => ({
	editInExternalEditor: vi.fn(async () => ({ status: "cancelled" })),
}));
vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: vi.fn(async () => {}),
	readClipboardText: vi.fn(async () => ""),
}));
vi.mock("../src/utils/clipboard-image.ts", () => ({
	readClipboardImage: vi.fn(async () => null),
	extensionForImageMimeType: vi.fn(),
}));

// Inert UI branch tests only. No owner/context/native authority is constructed.
describe("owned TUI refuses unsupported helpers before entry", () => {
	test.each(["handleOpenExternalEditor", "handleClipboardPaste", "handleRightClickPaste", "handleCopyCommand"])(
		"%s",
		async (name) => {
			vi.clearAllMocks();
			const mode = {
				stagingAudit: vi.fn(),
				showError: vi.fn(),
				showStatus: vi.fn(),
				settingsManager: { getExternalEditorCommand: () => "unadmitted-editor" },
				editor: { getText: () => "input" },
				renderer: { getFocusedComponent: () => ({ handleInput: vi.fn() }) },
				ui: { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() },
			};
			Object.defineProperty(mode, "session", { value: { getLastAssistantText: () => "assistant" } });
			const handler = Reflect.get(InteractiveMode.prototype, name) as (this: typeof mode) => Promise<void>;
			await handler.call(mode);
			expect(mode.showError).toHaveBeenCalledWith("OWNER_UI_EFFECT_REQUIRES_RECEIVING");
			for (const helper of [editInExternalEditor, copyToClipboard, readClipboardText, readClipboardImage])
				expect(helper).not.toHaveBeenCalled();
			expect(mode.ui.stop).not.toHaveBeenCalled();
		},
	);
});
