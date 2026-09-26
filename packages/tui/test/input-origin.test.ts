import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import type { InputOrigin } from "../src/input-origin.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const start = (fields: string) => `\x1b_herdr-origin;${fields}\x1b\\`;
const end = (id: string) => `\x1b_herdr-origin;end;id=${id}\x1b\\`;
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

type Setup = {
	tui: TUI;
	editor: Editor;
	stdin: StdinBuffer;
	submits: { text: string; origin?: InputOrigin }[];
	send(data: string): void;
};

const setups: Setup[] = [];

// Mirrors ProcessTerminal: StdinBuffer splits stdin, then sequences and paste reach the TUI.
function setup(): Setup {
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const editor = new Editor(tui, defaultEditorTheme);
	const stdin = new StdinBuffer({ timeout: 5 });
	stdin.on("data", (sequence) => terminal.sendInput(sequence));
	stdin.on("paste", (content) => terminal.sendInput(paste(content)));
	const submits: Setup["submits"] = [];
	editor.onSubmit = (text, origin) => submits.push({ text, origin });
	tui.setFocus(editor);
	tui.start();
	const result = { tui, editor, stdin, submits, send: (data: string) => stdin.process(data) };
	setups.push(result);
	return result;
}

afterEach(() => {
	for (const s of setups.splice(0)) {
		s.stdin.destroy();
		s.tui.stop();
	}
});

const API = { kind: "herdr-api", sender: "lead", pane: "p1", session: "s1", id: "7" } as const;

describe("Herdr input origin frames", () => {
	it("attributes an agent prompt (framed paste, then framed Enter) and never inserts the frame", () => {
		const s = setup();
		s.send(`${start("v=1;kind=api;id=7;sender=lead;pane=p1;session=s1")}${paste("hello")}${end("7")}`);
		assert.strictEqual(s.editor.getText(), "hello");
		assert.deepStrictEqual(s.tui.currentInputOrigin, { kind: "keyboard" });
		s.send(`${start("v=1;kind=api;id=7;sender=lead;pane=p1;session=s1")}\r${end("7")}`);
		assert.deepStrictEqual(s.submits, [{ text: "hello", origin: API }]);
		assert.strictEqual(s.editor.getText(), "");
	});

	it("reports keyboard for unframed typing", () => {
		const s = setup();
		s.send("h");
		s.send("i");
		s.send("\r");
		assert.deepStrictEqual(s.submits, [{ text: "hi", origin: { kind: "keyboard" } }]);
	});

	it("attributes mixed input to the API when a frame changed the content", () => {
		const s = setup();
		s.send("a");
		s.send(`${start("v=1;id=7;sender=lead;pane=p1;session=s1")}${paste("b")}${end("7")}`);
		s.send("\r");
		assert.deepStrictEqual(s.submits, [{ text: "ab", origin: API }]);
		// Reset after submit.
		s.send("c");
		s.send("\r");
		assert.deepStrictEqual(s.submits[1], { text: "c", origin: { kind: "keyboard" } });
	});

	it("does not let an open escape sequence or paste before a frame hide its origin", () => {
		// Astra review of herdr#82: keyboard input that leaves a control string, CSI or paste
		// open must not absorb the frame and turn API text into keyboard text.
		for (const open of ["\x1b_", "\x1bPq", "\x1b]0;t", "\x1b[1;", "\x1b[200~ab"]) {
			const s = setup();
			s.send(`${open}${start("v=1;id=7;sender=lead;pane=p1;session=s1")}${paste("hello")}${end("7")}`);
			s.send(`${start("v=1;id=7;sender=lead;pane=p1;session=s1")}\r${end("7")}`);
			assert.strictEqual(s.submits.length, 1, JSON.stringify(open));
			assert.deepStrictEqual(s.submits[0]!.origin, API, JSON.stringify(open));
			assert.ok(s.submits[0]!.text.endsWith("hello"), JSON.stringify(s.submits[0]));
			assert.ok(!s.submits[0]!.text.includes("herdr-origin"), JSON.stringify(s.submits[0]));
		}
	});

	it("does not let a payload that leaves a sequence open absorb the end frame", () => {
		for (const open of ["\x1b_", "\x1b[1;", "\x1b[200~ab"]) {
			const s = setup();
			s.send(`${start("v=1;id=7;sender=lead")}x${open}${end("7")}`);
			assert.deepStrictEqual(s.tui.currentInputOrigin, { kind: "keyboard" }, JSON.stringify(open));
		}
	});

	it("resets the origin when the editor is cleared", () => {
		const s = setup();
		s.send(`${start("v=1;id=7;sender=lead")}${paste("x")}${end("7")}`);
		s.editor.setText("");
		s.send("y");
		s.send("\r");
		assert.deepStrictEqual(s.submits, [{ text: "y", origin: { kind: "keyboard" } }]);
	});

	it("handles send-text with raw text and CR in one frame and percent-encoding", () => {
		const s = setup();
		s.send(`\x1b_herdr-origin;v=1;id=9;sender=a%20b%3Bc\x1b\\hi\r\x1b_herdr-origin;end;id=9\x1b\\`);
		assert.deepStrictEqual(s.submits, [{ text: "hi", origin: { kind: "herdr-api", sender: "a b;c", id: "9" } }]);
	});

	it("keeps a broken frame inside a bracketed paste as paste text", () => {
		// Herdr replaces the last prefix byte in all unframed input, so a pasted fake frame
		// arrives broken. (An intact prefix can only come from Herdr and is a sync point.)
		const s = setup();
		const frameText = "\x1b_herdr-origi?;v=1;id=1;sender=evil\x1b\\";
		let seen: InputOrigin | undefined;
		s.tui.addInputListener(() => {
			seen = s.tui.currentInputOrigin;
			return undefined;
		});
		s.send(paste(`before ${frameText} after`));
		assert.deepStrictEqual(seen, { kind: "keyboard" });
		assert.match(s.editor.getText(), /before .*herdr-origi\?;v=1;id=1;sender=evil.* after/);
		s.send("\r");
		assert.deepStrictEqual(s.submits[0]!.origin, { kind: "keyboard" });
	});

	it("keeps the outer origin for nested starts and closes on a mismatched end id", () => {
		const s = setup();
		s.send(`${start("v=1;id=1;sender=outer")}${start("v=1;id=2;sender=inner")}x${end("other")}`);
		assert.deepStrictEqual(s.tui.currentInputOrigin, { kind: "keyboard" });
		s.send("\r");
		assert.deepStrictEqual(s.submits, [{ text: "x", origin: { kind: "herdr-api", sender: "outer", id: "1" } }]);
	});

	it("tolerates unknown versions, missing sender and garbled values", () => {
		const s = setup();
		s.send(`${start("v=99;what=ever;=;novalue;pane=%E0%A4%A")}z${end("")}`);
		s.send("\r");
		assert.deepStrictEqual(s.submits, [
			{ text: "z", origin: { kind: "herdr-api", sender: "unknown", pane: "%E0%A4%A" } },
		]);
		// A terminated frame without fields is dropped and changes nothing.
		s.send("\x1b_herdr-origin\x1b\\q\r");
		assert.deepStrictEqual(s.submits[1], { text: "q", origin: { kind: "keyboard" } });
	});

	it("drops a flushed unterminated frame and keeps later keyboard input", async () => {
		const s = setup();
		const received: string[] = [];
		const probe: Component = { render: () => [], invalidate() {}, handleInput: (d) => received.push(d) };
		s.tui.setFocus(probe);
		s.send("\x1b_herdr-origin;v=1;id=3;sender=lead");
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepStrictEqual(received, []);
		assert.deepStrictEqual(s.tui.currentInputOrigin, { kind: "keyboard" });
		s.tui.setFocus(s.editor);
		s.send("k");
		s.send("\r");
		assert.deepStrictEqual(s.submits, [{ text: "k", origin: { kind: "keyboard" } }]);
	});

	it("drops a flushed fragment of the frame prefix", async () => {
		const s = setup();
		s.send("\x1b_herdr-or");
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.strictEqual(s.editor.getText(), "");
	});
});
