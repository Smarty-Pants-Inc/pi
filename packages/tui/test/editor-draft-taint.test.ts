// smarty-dev#2636: only a draft that was typed or pasted through the terminal can be attributed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function submitAfter(setup: (editor: Editor) => void): { text: string; tainted: boolean } {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
	let submitted: { text: string; tainted: boolean } | undefined;
	editor.onSubmit = (text) => {
		submitted = { text, tainted: editor.lastSubmitTainted };
	};
	setup(editor);
	editor.handleInput("\r");
	assert.ok(submitted, "submitted");
	return submitted;
}

function type(editor: Editor, text: string): void {
	for (const char of text) editor.handleInput(char);
}

describe("Editor draft taint", () => {
	it("leaves a typed draft and a terminal paste untainted", () => {
		assert.deepEqual(
			submitAfter((e) => type(e, "hi")),
			{ text: "hi", tainted: false },
		);
		assert.equal(submitAfter((e) => e.handleInput("\x1b[200~pasted\x1b[201~")).tainted, false);
	});

	it("taints history recall, programmatic text, insertion, yank and undo", () => {
		const recalled = submitAfter((e) => {
			e.addToHistory("old prompt");
			e.handleInput("\x1b[A");
		});
		assert.deepEqual(recalled, { text: "old prompt", tainted: true });
		assert.equal(submitAfter((e) => e.setText("set by code")).tainted, true);
		assert.equal(submitAfter((e) => e.insertTextAtCursor("inserted")).tainted, true);
		const yanked = submitAfter((e) => {
			type(e, "word");
			e.handleInput("\x17"); // Ctrl+W kills the word
			e.handleInput("\x19"); // Ctrl+Y yanks it back
		});
		assert.deepEqual(yanked, { text: "word", tainted: true });
		const undone = submitAfter((e) => {
			type(e, "ab");
			e.handleInput("\x1f"); // Ctrl+- undo
		});
		assert.equal(undone.tainted, true);
		const marked = submitAfter((e) => {
			type(e, "x");
			e.markDraftTainted();
		});
		assert.equal(marked.tainted, true);
	});

	it("starts each draft clean after a submit", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		const taints: boolean[] = [];
		editor.onSubmit = () => taints.push(editor.lastSubmitTainted);
		editor.setText("first");
		editor.handleInput("\r");
		type(editor, "second");
		editor.handleInput("\r");
		assert.deepEqual(taints, [true, false]);
	});
});
