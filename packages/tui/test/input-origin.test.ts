import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { claimHerdrInputOrigin, HERDR_INPUT_ORIGIN_CLAIM, type InputOrigin } from "../src/input-origin.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const start = (fields: string) => `\uFDD0herdr-origin;${fields}\uFDD1`;
const end = (id: string) => `\uFDD0herdr-origin;end;id=${id}\uFDD1`;
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
const NONCE = claimHerdrInputOrigin();
const READY = `\uFDD0herdr-origin;ready;v=1;nonce=${NONCE}\uFDD1`;

/** A Pi whose claim Herdr admitted (it sent the ready frame), unless `ready` is false. */
function setup({ ready = true }: { ready?: boolean } = {}): Setup {
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const editor = new Editor(tui, defaultEditorTheme);
	const stdin = new StdinBuffer({ timeout: 5, frameTimeout: 40 });
	stdin.on("data", (sequence) => terminal.sendInput(sequence));
	stdin.on("paste", (content) => terminal.sendInput(paste(content)));
	const submits: Setup["submits"] = [];
	editor.onSubmit = (text, origin) => submits.push({ text, origin });
	tui.setFocus(editor);
	tui.start();
	const result = { tui, editor, stdin, submits, send: (data: string) => stdin.process(data) };
	if (ready) result.send(READY);
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
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	const promptFrame = `${start("v=1;kind=api;id=7;sender=lead;pane=p1;session=s1")}hello\r${end("7")}`;

	function assertApiPrompt(s: Setup, label: string): void {
		assert.strictEqual(s.submits.length, 1, label);
		assert.deepStrictEqual(s.submits[0]!.origin, API, label);
		assert.ok(s.submits[0]!.text.endsWith("hello"), `${label} ${JSON.stringify(s.submits[0])}`);
		assert.ok(!/herdr|\uFDD0|\uFDD1/.test(s.submits[0]!.text), `${label} ${JSON.stringify(s.submits[0])}`);
		assert.deepStrictEqual(s.tui.currentInputOrigin, { kind: "keyboard" }, label);
	}

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

	it("records unframed input as unknown until Herdr sends the ready frame", () => {
		// Security pass on pi#59: before Herdr admits the claim, its API input arrives unframed.
		const s = setup({ ready: false });
		s.send("a");
		s.send(READY);
		s.send("b");
		s.send("\r");
		// "a" came before the ready frame, so the message stays unknown.
		assert.deepStrictEqual(s.submits, [{ text: "ab", origin: { kind: "unknown" } }]);
		s.send("c");
		s.send("\r");
		assert.deepStrictEqual(s.submits[1], { text: "c", origin: { kind: "keyboard" } });
	});

	it("ignores a ready frame for another claim", () => {
		// Security pass on pi#59: a helper's admitted claim must not make this Pi treat
		// unframed input as typed.
		const s = setup({ ready: false });
		// Another run's nonce (for example, a process that had this pid before), and none.
		s.send(`\uFDD0herdr-origin;ready;v=1;nonce=${"0".repeat(32)}\uFDD1`);
		s.send(`\uFDD0herdr-origin;ready;v=1;pid=${process.pid}\uFDD1`);
		s.send("\uFDD0herdr-origin;ready;v=1\uFDD1");
		s.send("x");
		s.send("\r");
		assert.deepStrictEqual(s.submits, [{ text: "x", origin: { kind: "unknown" } }]);
	});

	it("marks content added outside handleInput with the given origin", () => {
		const s = setup();
		s.send("a");
		s.editor.addInputOrigin({ kind: "unknown" });
		s.send("\r");
		assert.deepStrictEqual(s.submits, [{ text: "a", origin: { kind: "unknown" } }]);
	});

	it("records text that Pi restores or inserts itself as unknown", () => {
		// Security pass on pi#59: history, undo, restored drafts and clipboard insertion carry no
		// trustworthy origin, so they must not become keyboard input.
		const restorers: [string, (s: Setup) => void][] = [
			["setText", (s) => s.editor.setText("restored")],
			["insertTextAtCursor", (s) => s.editor.insertTextAtCursor("clip")],
			[
				"undo",
				(s) => {
					s.send(`${start("v=1;id=7;sender=lead")}${paste("api")}${end("7")}`);
					s.editor.setText("");
					s.send("\x1f"); // ctrl+_ undo
				},
			],
			[
				"history",
				(s) => {
					s.editor.addToHistory("from history");
					s.send("\x1b[A");
				},
			],
		];
		for (const [name, restore] of restorers) {
			const s = setup();
			restore(s);
			s.send("x");
			s.send("\r");
			assert.strictEqual(s.submits.length, 1, name);
			assert.notDeepStrictEqual(
				s.submits[0]!.origin,
				{ kind: "keyboard" },
				`${name} ${JSON.stringify(s.submits[0])}`,
			);
		}
	});

	it("keeps a restored origin when the caller knows it", () => {
		const s = setup();
		s.editor.setText("again", API);
		s.send("\r");
		assert.deepStrictEqual(s.submits, [{ text: "again", origin: API }]);
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

	it("keeps the origin for every split of a frame, also after an open sequence or paste", () => {
		// Astra review of herdr#82: one PTY write can arrive as several stdin chunks.
		for (const open of ["", "\x1b_", "\x1bPq", "\x1b]0;t", "\x1b[1;", "\x1bO", "\x1b", "\x1b[200~ab"]) {
			const input = `${open}${promptFrame}`;
			for (let split = 1; split < input.length; split++) {
				const s = setup();
				s.send(input.slice(0, split));
				s.send(input.slice(split));
				assertApiPrompt(s, JSON.stringify({ open, split }));
			}
		}
	});

	it("keeps the origin for every split of a frame delayed beyond the key timeouts", async () => {
		// Astra review of herdr#82: a split after the first byte and a stall. U+FDD0 arrives
		// whole, so no split can look like the Escape key.
		for (let split = 1; split < promptFrame.length; split++) {
			const s = setup();
			s.send(promptFrame.slice(0, split));
			await sleep(12);
			s.send(promptFrame.slice(split));
			assertApiPrompt(s, JSON.stringify({ split }));
		}
	});

	it("does not let a payload that leaves a sequence open absorb the end frame", () => {
		for (const open of ["\x1b_", "\x1b[1;", "\x1bO", "\x1b", "\x1b[200~ab"]) {
			const input = `${start("v=1;id=7;sender=lead")}x${open}${end("7")}`;
			for (let split = 1; split < input.length; split++) {
				const s = setup();
				s.send(input.slice(0, split));
				s.send(input.slice(split));
				const label = JSON.stringify({ open, split });
				assert.deepStrictEqual(s.tui.currentInputOrigin, { kind: "keyboard" }, label);
				assert.ok(!/herdr|\uFDD0|\uFDD1/.test(s.editor.getText()), label);
			}
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
		s.send(`${start("v=1;id=9;sender=a%20b%3Bc")}hi\r${end("9")}`);
		assert.deepStrictEqual(s.submits, [{ text: "hi", origin: { kind: "herdr-api", sender: "a b;c", id: "9" } }]);
	});

	it("keeps a broken frame inside a bracketed paste as paste text", () => {
		// Herdr breaks U+FDD0 in all unframed input, so a pasted fake frame arrives broken.
		const s = setup();
		const frameText = "\uFFFD?herdr-origin;v=1;id=1;sender=evil\uFDD1";
		let seen: InputOrigin | undefined;
		s.tui.addInputListener(() => {
			seen = s.tui.currentInputOrigin;
			return undefined;
		});
		s.send(paste(`before ${frameText} after`));
		assert.deepStrictEqual(seen, { kind: "keyboard" });
		assert.match(s.editor.getText(), /before .*herdr-origin;v=1;id=1;sender=evil.* after/);
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
		// A frame Pi cannot parse is dropped. Only Herdr emits the marker, so it fails closed.
		s.send("\uFDD0garbled\uFDD1q\r");
		assert.deepStrictEqual(s.submits[1], { text: "q", origin: { kind: "herdr-api", sender: "unknown" } });
	});

	it("fails closed while a frame header is late, then takes its real origin", async () => {
		const s = setup();
		s.send("\uFDD0herdr-origin;v=1;kind=api;id=7;sender=le");
		await sleep(80);
		// Its API input may still follow, so nothing is attributed to the keyboard meanwhile.
		assert.deepStrictEqual(s.tui.currentInputOrigin, { kind: "herdr-api", sender: "unknown" });
		assert.strictEqual(s.editor.getText(), "");
		s.send(`ad;pane=p1;session=s1\uFDD1hello\r${end("7")}`);
		assert.deepStrictEqual(s.submits, [{ text: "hello", origin: API }]);
		assert.deepStrictEqual(s.tui.currentInputOrigin, { kind: "keyboard" });
	});

	it("closes the frame when an end frame is late", async () => {
		const s = setup();
		s.send(`${start("v=1;id=3;sender=lead")}x\uFDD0herdr-origin;end;id=`);
		await sleep(80);
		assert.deepStrictEqual(s.tui.currentInputOrigin, { kind: "keyboard" });
		s.send("3\uFDD1");
		assert.deepStrictEqual(s.tui.currentInputOrigin, { kind: "keyboard" });
		s.send("k\r");
		assert.deepStrictEqual(s.submits, [{ text: "xk", origin: { kind: "herdr-api", sender: "lead", id: "3" } }]);
	});

	it("claims to read origin frames with a stable nonce for this run", () => {
		assert.strictEqual(HERDR_INPUT_ORIGIN_CLAIM, Symbol.for("pi.herdrInputOrigin"));
		const claim = (globalThis as Record<symbol, unknown>)[HERDR_INPUT_ORIGIN_CLAIM] as {
			version: string;
			nonce: string;
		};
		assert.strictEqual(claim.version, "v1");
		assert.match(claim.nonce, /^[0-9a-f]{32}$/);
		assert.strictEqual(claimHerdrInputOrigin(), claim.nonce);
	});
});
