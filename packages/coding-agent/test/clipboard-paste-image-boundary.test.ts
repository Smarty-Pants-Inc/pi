import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const mocks = vi.hoisted(() => ({
	readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
}));
vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: vi.fn(),
	readClipboardText: vi.fn(),
	readClipboardFilePaths: mocks.readClipboardFilePaths,
}));
vi.mock("../src/utils/clipboard-image.ts", () => ({
	extensionForImageMimeType: () => "png",
	readClipboardImage: mocks.readClipboardImage,
}));
let temp: string;
beforeEach(() => {
	vi.resetAllMocks();
	temp = mkdtempSync(path.join(os.tmpdir(), "pi image '$(unsafe) "));
	vi.stubEnv("TMPDIR", temp);
	vi.stubEnv("TMP", temp);
	vi.stubEnv("TEMP", temp);
	mocks.readClipboardFilePaths.mockResolvedValue(null);
	mocks.readClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/png" });
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(temp, { recursive: true, force: true });
});

async function paste(text: string, col = text.length, isBashMode = true) {
	const context = {
		editor: { getCursor: () => ({ line: 0, col }), getText: () => text, insertTextAtCursor: vi.fn() },
		isBashMode,
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};
	await prototype.handleClipboardPaste.call(context);
	return context;
}
// pi#137 / smarty-dev#3535, A17.
test.each(['!cat "prefix ', "!cat 'prefix ", "!cat escaped\\ ", "!cat partial", "!cat $(echo "])(
	"refuses image fallback outside an unquoted Bash boundary: %s",
	async (text) => {
		const context = await paste(text);
		expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(context.showError).toHaveBeenCalledWith(
			"Failed to paste from clipboard: Paste file paths at an unquoted shell argument boundary",
		);
		expect(readdirSync(temp)).toEqual([]);
	},
);
test("quotes the generated image path and separates the following Bash argument", async () => {
	const context = await paste("!cat DEST", 5);
	const [file] = readdirSync(temp);
	expect(file).toMatch(/^pi-clipboard-.*\.png$/);
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith(
		`'${path.join(temp, file).replaceAll("'", "'\\''")}' `,
	);
	expect(context.showError).not.toHaveBeenCalled();
});
test("separates image paths from preceding prompt text", async () => {
	const context = await paste("Review:", 7, false);
	const [file] = readdirSync(temp);
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith(` ${path.join(temp, file)}`);
});
