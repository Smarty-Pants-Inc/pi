// #3155: ordinary TUI handoffs must not silently lose Herdr input attribution.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	Container,
	getKeybindings,
	ProcessTerminal,
	setKeybindings,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { EpochByteCounter, epochMarker } from "../../coding-agent/src/core/herdr/epoch-bytes.ts";
import type { HerdrEpoch } from "../../coding-agent/src/core/herdr/input-consumer.ts";
import type { CutRequest } from "../../coding-agent/src/core/herdr/server-auth.ts";
import { SubmitAttestor } from "../../coding-agent/src/core/herdr/submit-attestor.ts";
import { KeybindingsManager } from "../../coding-agent/src/core/keybindings.ts";
import { getInputReceipt, type ReceivedInput } from "../../coding-agent/src/core/received-input.ts";
import { receiptRecord } from "../../coding-agent/src/core/turn-receipts.ts";
import { CustomEditor } from "../../coding-agent/src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../coding-agent/src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../../coding-agent/src/modes/interactive/theme/theme.ts";
import { createInteractiveTuiReference } from "../../coding-agent/src/modes/interactive/tui-renderer.ts";

interface SubmitContext {
	renderer: TuiMainScreen | TuiAltScreen;
	ui: TUI;
	defaultEditor: CustomEditor;
	editor: CustomEditor;
	chatContainer: Container;
	pendingUserInputs: ReceivedInput[];
	setupEditorSubmitHandler(): void;
	handleCtrlZ(): void;
}

const NONCE = "0123456789abcdef";
const NOTICE =
	/Herdr input attestation (?:unavailable|ended)[\s\S]*typed\s+turns?\s+(?:is|are)\s+recorded\s+as\s+terminal/i;

function setup(t: TestContext, enrolled: boolean) {
	const writes: string[] = [];
	const oldLogPath = process.env.PI_TUI_WRITE_LOG;
	process.env.PI_TUI_WRITE_LOG = "";
	t.after(() => {
		if (oldLogPath === undefined) delete process.env.PI_TUI_WRITE_LOG;
		else process.env.PI_TUI_WRITE_LOG = oldLogPath;
	});
	// Only OS I/O is replaced: terminal, parser, editor, submit receiver and receipts stay real.
	t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
		writes.push(String(chunk));
		return true;
	});
	t.mock.method(process.stdin, "resume", () => process.stdin);
	t.mock.method(process.stdin, "pause", () => process.stdin);
	if (typeof process.stdin.setRawMode === "function") {
		t.mock.method(process.stdin, "setRawMode", () => process.stdin);
	}
	t.mock.method(process, "kill", () => true);

	initTheme("dark");
	const oldKeybindings = getKeybindings();
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	t.after(() => setKeybindings(oldKeybindings));
	const terminal = new ProcessTerminal();
	const renderer = new TuiMainScreen(terminal);
	const mode = Object.create(InteractiveMode.prototype) as SubmitContext;
	const ui = createInteractiveTuiReference(() => mode.renderer);
	const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
	const chat = new Container();
	// State for the real ordinary submit path, stopping at its existing pending-input queue.
	Object.assign(mode, {
		renderer,
		ui,
		defaultEditor: editor,
		editor,
		chatContainer: chat,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingUserInputs: [],
		runtimeHost: { inputsFenced: false, session: { isCompacting: false, isStreaming: false } },
		terminalShutdownRequested: false,
	});

	const counter = new EpochByteCounter();
	const cuts: Omit<CutRequest, "epoch">[] = [];
	let releases = 0;
	// Fake Herdr boundary only; no forged TurnReceipt or replacement attribution implementation.
	const epoch: HerdrEpoch = {
		epoch: "0".repeat(32),
		nonce: NONCE,
		async cut(request) {
			cuts.push(request);
			return { result: "client", principal: { smartyId: "restart-test", displayName: "Restart Test" } };
		},
		release() {
			releases++;
		},
	};
	if (enrolled) {
		counter.hold();
		counter.arm(NONCE);
	}
	const meter = {
		push: (chunk: Buffer) => counter.push(chunk),
		end: () => {
			counter.end();
			if (enrolled) epoch.release();
		},
	};
	Object.assign(mode, {
		options: { herdrInput: { meter, ...(enrolled ? { attestor: new SubmitAttestor(counter, epoch) } : {}) } },
	});
	terminal.setInputMeter(meter, () => editor.markDraftTainted());
	mode.setupEditorSubmitHandler();
	const completions: Promise<void>[] = [];
	const onSubmit = editor.onSubmit;
	assert.ok(onSubmit);
	editor.onSubmit = (text) => {
		const completion = Promise.resolve(onSubmit(text));
		completions.push(completion);
		return completion;
	};
	renderer.addChild(chat);
	renderer.addChild(editor);
	renderer.setFocus(editor);
	renderer.start();
	t.after(() => mode.ui.stop());
	if (enrolled) process.stdin.emit("data", epochMarker(NONCE));

	return {
		mode,
		terminal,
		cuts,
		writes,
		released: () => releases,
		async submit(text: string) {
			const count = completions.length;
			process.stdin.emit("data", Buffer.from(`${text}\r`));
			assert.equal(completions.length, count + 1, "real editor must handle Enter synchronously");
			await completions[count];
			const input = mode.pendingUserInputs[count];
			assert.ok(input, "real receiver must queue the submitted envelope");
			assert.equal(input.text, text);
			mode.ui.renderNow(true);
			return receiptRecord(getInputReceipt(input));
		},
		handoff() {
			mode.ui.stop({ preserveScreen: true });
			const next = new TuiAltScreen(terminal, false, undefined, { mouse: false });
			for (const child of mode.renderer.children) next.addChild(child);
			mode.renderer.clear();
			mode.renderer = next;
			next.setFocus(editor);
			next.start();
			mode.ui.requestRender(true);
		},
	};
}

describe("Herdr restart notice (#3155)", { concurrency: false }, () => {
	for (const restart of ["suspend/resume", "renderer handoff"] as const) {
		// #3155: previously metered Enter, ordinary stop/restart, then a terminal-only submit.
		it(
			`warns on the real submit path after ${restart}`,
			{ skip: restart === "suspend/resume" && process.platform === "win32", timeout: 5000 },
			async (t) => {
				const h = setup(t, true);
				const before = await h.submit("before restart");
				assert.equal(before.channel, "keyboard");
				assert.ok("principal" in before);
				assert.deepEqual(before.principal, { id: "restart-test", binding: "herdr-client" });
				assert.doesNotMatch(stripVTControlCharacters(h.writes.join("")), NOTICE);
				h.writes.length = 0;
				if (restart === "suspend/resume") {
					try {
						h.mode.handleCtrlZ();
					} finally {
						process.emit("SIGCONT");
					}
				} else h.handoff();
				assert.equal(h.released(), 1);
				assert.equal(h.terminal.inputOffset, undefined);
				const after = await h.submit("after restart");
				assert.equal(after.channel, "terminal");
				assert.equal("principal" in after, false, "ended epoch must never fabricate a principal");
				assert.equal(h.cuts.length, 1, "no post-restart cut may reuse the ended epoch");
				assert.match(stripVTControlCharacters(h.writes.join("")), NOTICE);
				assert.match(stripVTControlCharacters(h.mode.chatContainer.render(120).join("\n")), NOTICE);

				// #3155: each later turn needs its own notice; an old warning is not restored attestation.
				h.writes.length = 0;
				const later = await h.submit("later terminal turn");
				assert.equal(later.channel, "terminal");
				assert.equal("principal" in later, false);
				assert.equal(h.cuts.length, 1, "later submits must not reuse the ended epoch either");
				assert.match(stripVTControlCharacters(h.writes.join("")), NOTICE);
				const transcript = stripVTControlCharacters(h.mode.chatContainer.render(120).join("\n"));
				assert.equal(transcript.match(/Herdr input attestation unavailable:/g)?.length, 2);
			},
		);
	}

	// #3155 counterexample: the first enrolled submit still has a valid byte cut and no downgrade.
	it("keeps first-start enrolled input attested without a restart-loss notice", async (t) => {
		const h = setup(t, true);
		const record = await h.submit("first enrolled submit");
		assert.equal(record.channel, "keyboard");
		assert.ok("principal" in record);
		assert.deepEqual(record.principal, { id: "restart-test", binding: "herdr-client" });
		assert.equal(h.cuts.length, 1);
		assert.equal(h.released(), 0);
		assert.doesNotMatch(stripVTControlCharacters(h.writes.join("")), NOTICE);
	});

	// #3155 counterexample: an absent principal at startup is not a lost enrolled epoch.
	it("keeps first-start and no-principal submissions usable without a restart-loss notice", async (t) => {
		const h = setup(t, false);
		for (const text of ["first ordinary submit", "ordinary submit after restart"]) {
			if (h.mode.pendingUserInputs.length > 0) h.handoff();
			const record = await h.submit(text);
			assert.equal(record.channel, "terminal");
			assert.equal("principal" in record, false);
		}
		assert.equal(h.cuts.length, 0);
		assert.equal(h.released(), 0);
		assert.doesNotMatch(stripVTControlCharacters(h.writes.join("")), NOTICE);
		assert.doesNotMatch(stripVTControlCharacters(h.mode.chatContainer.render(120).join("\n")), NOTICE);
	});
});
