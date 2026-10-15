import { createHash } from "node:crypto";
import type { Component, EditorComponent } from "@earendil-works/pi-tui";
import { Container, getKeybindings, ProcessTerminal, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HerdrInputBootstrap } from "../src/core/herdr/bootstrap.ts";
import { EpochByteCounter, epochMarker } from "../src/core/herdr/epoch-bytes.ts";
import type { HerdrEpoch } from "../src/core/herdr/input-consumer.ts";
import type { CutAnswer, CutRequest } from "../src/core/herdr/server-auth.ts";
import { SubmitAttestor } from "../src/core/herdr/submit-attestor.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { getInputReceipt, type ReceivedInput } from "../src/core/received-input.ts";
import { receiptRecord, type TurnReceipt } from "../src/core/turn-receipts.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const clipboard = vi.hoisted(() => ({
	readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: vi.fn(),
	readClipboardFilePaths: clipboard.readClipboardFilePaths,
	readClipboardText: clipboard.readClipboardText,
}));
vi.mock("../src/utils/clipboard-image.ts", () => ({
	extensionForImageMimeType: () => "png",
	readClipboardImage: clipboard.readClipboardImage,
}));

interface TestMode {
	defaultEditor: CustomEditor;
	editor: EditorComponent;
	keybindings: KeybindingsManager;
	ui: TuiMainScreen;
	renderer: TuiMainScreen;
	options: { herdrInput: Pick<HerdrInputBootstrap, "attestor"> };
	runtimeHost: {
		inputsFenced: boolean;
		session: {
			isCompacting: boolean;
			isStreaming: boolean;
			isBashRunning: boolean;
			compact(customInstructions?: string): Promise<void>;
		};
	};
	terminalShutdownRequested: boolean;
	pendingUserInputs: ReceivedInput[];
	compactionQueuedMessages: { input: ReceivedInput; mode: "steer" | "followUp" }[];
	chatContainer: Container;
	pendingMessagesContainer: Container;
	editorRevision: number;
	isBashMode: boolean;
	ordinaryEditorSubmit: EditorComponent["onSubmit"];
	showError: ReturnType<typeof vi.fn>;
	updateEditorBorderColor: ReturnType<typeof vi.fn>;
	flushPendingBashComponents: ReturnType<typeof vi.fn>;
	showSettingsSelector: ReturnType<typeof vi.fn>;
	showModelsSelector(): void | Promise<void>;
	setupKeyHandlers(): void;
	setupEditorSubmitHandler(): void;
	handleRightClickPaste(): Promise<void>;
	handleClipboardPaste(): Promise<void>;
	captureHerdrSubmit(text: string): Promise<TurnReceipt> | undefined;
}

const NONCE = "0123456789abcdef";
const PAUL: CutAnswer = { result: "client", principal: { smartyId: "paul", displayName: "Paul" } };
const originalKeybindings = getKeybindings();
let terminal: ProcessTerminal | undefined;

beforeEach(() => {
	vi.resetAllMocks();
	clipboard.readClipboardFilePaths.mockResolvedValue(null);
	clipboard.readClipboardImage.mockResolvedValue(null);
	clipboard.readClipboardText.mockResolvedValue("clipboard text");
});
afterEach(() => {
	terminal?.stop();
	terminal = undefined;
	setKeybindings(originalKeybindings);
	vi.restoreAllMocks();
});

function setup(answer: (request: Omit<CutRequest, "epoch">) => Promise<CutAnswer> = async () => PAUL, waitMs = 50) {
	const counter = new EpochByteCounter();
	counter.hold();
	counter.arm(NONCE);
	const cut = vi.fn<HerdrEpoch["cut"]>(answer);
	const epoch: HerdrEpoch = { epoch: "paste-test", nonce: NONCE, cut, release: vi.fn() };
	const attestor = new SubmitAttestor(counter, epoch, waitMs);
	terminal = new ProcessTerminal();
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const ui = new TuiMainScreen(terminal);
	vi.spyOn(ui, "requestRender").mockImplementation(() => {});
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(ui, { borderColor: (s) => s, selectList: {} as never }, keybindings);
	const mode: TestMode = Object.assign(Object.create(InteractiveMode.prototype) as TestMode, {
		defaultEditor: editor,
		editor,
		keybindings,
		ui,
		renderer: ui,
		options: { herdrInput: { attestor } },
		runtimeHost: {
			inputsFenced: false,
			session: {
				isCompacting: false,
				isStreaming: false,
				isBashRunning: false,
				compact: vi.fn<() => Promise<void>>(),
				getSteeringMessages: () => [],
				getFollowUpMessages: () => [],
			},
		},
		terminalShutdownRequested: false,
		pendingUserInputs: [],
		compactionQueuedMessages: [],
		chatContainer: new Container(),
		pendingMessagesContainer: new Container(),
		clearStatusIndicator: vi.fn(),
		editorRevision: 0,
		isBashMode: false,
		showError: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		showSettingsSelector: vi.fn(),
	});
	mode.setupKeyHandlers();
	mode.setupEditorSubmitHandler();
	ui.setFocus(editor);
	terminal.setInputMeter({ push: (chunk) => counter.push(chunk), end: () => counter.end() }, () =>
		editor.markDraftTainted(),
	);
	terminal.start(
		(data) => ui.getFocusedComponent()?.handleInput?.(data),
		() => {},
	);
	const send = (data: string | Buffer) => process.stdin.emit("data", data);
	send(epochMarker(NONCE));
	return { mode, editor, ui, cut, send };
}

async function submitted(mode: TestMode, count = 1): Promise<ReceivedInput> {
	await vi.waitFor(() => expect(mode.pendingUserInputs).toHaveLength(count));
	return mode.pendingUserInputs[count - 1]!;
}

// Regression for #160: origin/main moved Astra's synthetic paste site to handleRightClickPaste.
test("right-click clipboard paste plus Enter is terminal, not keyboard", async () => {
	const { mode, editor, cut, send } = setup();
	send("typed ");
	await mode.handleRightClickPaste();
	expect(editor.getText()).toBe("typed clipboard text");
	expect(mode.pendingUserInputs).toEqual([]);
	expect(cut).not.toHaveBeenCalled();
	send("\r");
	const input = await submitted(mode);
	expect(input.text).toBe("typed clipboard text");
	expect(input.images).toBeUndefined();
	expect(editor.getText()).toBe("");
	expect(receiptRecord(getInputReceipt(input)).channel).toBe("terminal");
	expect(receiptRecord(getInputReceipt(input))).not.toHaveProperty("principal");
	expect(cut).toHaveBeenCalledOnce();
	// Taint belongs to this draft only; the next genuine typed submission is still keyboard.
	send("next typed\r");
	expect(receiptRecord(getInputReceipt(await submitted(mode, 2))).channel).toBe("keyboard");
});

// Regression for #160: Ctrl+V uses the existing programmatic-insertion taint path.
test("Ctrl+V clipboard text plus Enter is terminal without changing paste behavior", async () => {
	const { mode, editor, cut, send } = setup();
	send("typed \x16");
	await vi.waitFor(() => expect(editor.getText()).toBe("typed clipboard text"));
	expect(clipboard.readClipboardFilePaths).toHaveBeenCalledOnce();
	expect(clipboard.readClipboardImage).toHaveBeenCalledOnce();
	expect(mode.pendingUserInputs).toEqual([]);
	send("\r");
	const input = await submitted(mode);
	expect(input.text).toBe("typed clipboard text");
	expect(input.images).toBeUndefined();
	expect(receiptRecord(getInputReceipt(input)).channel).toBe("terminal");
	expect(cut).toHaveBeenCalledOnce();
});

test("genuine typed input still receives a keyboard receipt", async () => {
	const { mode, send } = setup();
	send("typed\r");
	const input = await submitted(mode);
	expect(receiptRecord(getInputReceipt(input))).toMatchObject({ channel: "keyboard", principal: { id: "paul" } });
	expect(clipboard.readClipboardText).not.toHaveBeenCalled();
});

test("genuine terminal bracketed paste still receives a keyboard receipt", async () => {
	const { mode, send } = setup();
	send("\x1b[200~terminal paste\x1b[201~\r");
	const input = await submitted(mode);
	expect(input.text).toBe("terminal paste");
	expect(receiptRecord(getInputReceipt(input)).channel).toBe("keyboard");
});

test("right-click clipboard paste follows focus without tainting an untouched main editor", async () => {
	const { mode, editor, ui, send } = setup();
	send("typed");
	const handleInput = vi.fn();
	const dialog = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
	ui.setFocus(dialog);
	await mode.handleRightClickPaste();
	expect(handleInput).toHaveBeenCalledExactlyOnceWith("\x1b[200~clipboard text\x1b[201~");
	expect(editor.getText()).toBe("typed");
	ui.setFocus(editor);
	send("\r");
	expect(receiptRecord(getInputReceipt(await submitted(mode))).channel).toBe("keyboard");
});

test("right-click paste abandoned after a focus change neither inserts nor taints", async () => {
	const { mode, editor, ui, send } = setup();
	let resolveClipboard!: (value: string) => void;
	clipboard.readClipboardText.mockReturnValue(
		new Promise((resolve) => {
			resolveClipboard = resolve;
		}),
	);
	send("typed");
	const paste = mode.handleRightClickPaste();
	ui.setFocus(null);
	resolveClipboard("clipboard text");
	await paste;
	expect(editor.getText()).toBe("typed");
	ui.setFocus(editor);
	send("\r");
	expect(receiptRecord(getInputReceipt(await submitted(mode))).channel).toBe("keyboard");
});

test.each(["inputsFenced", "terminalShutdownRequested"] as const)(
	"%s rejects submit, restores text, and makes no attestation cut",
	async (fence) => {
		const { mode, editor, cut, send } = setup();
		if (fence === "inputsFenced") mode.runtimeHost.inputsFenced = true;
		else mode.terminalShutdownRequested = true;
		const capture = vi.spyOn(mode, "captureHerdrSubmit");
		send("typed\r");
		expect(editor.getText()).toBe("typed");
		expect(mode.pendingUserInputs).toEqual([]);
		expect(capture).not.toHaveBeenCalled();
		expect(cut).not.toHaveBeenCalled();
		expect(mode.showError).toHaveBeenCalledExactlyOnceWith(
			"INPUT_ADMISSION_FENCED: input was not accepted; retry after replacement",
		);
		mode.runtimeHost.inputsFenced = false;
		mode.terminalShutdownRequested = false;
		send("\r");
		expect((await submitted(mode)).text).toBe("typed");
		expect(receiptRecord(getInputReceipt(mode.pendingUserInputs[0]!)).channel).toBe("terminal");
	},
);

// pi#160 R9 P1: a command continuation must not clear bytes typed after its Enter in the same read.
test("/settings followed by a draft in one stdin read preserves the later draft", async () => {
	const { mode, editor, cut, send } = setup();
	send("/settings\rnext");
	expect(editor.getText()).toBe("next");
	expect(cut).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cut: 10, kind: "discard" }));
	await vi.waitFor(() => expect(mode.showSettingsSelector).toHaveBeenCalledOnce());
	expect(editor.getText()).toBe("next");
	expect(mode.pendingUserInputs).toEqual([]);
});

// pi#160 R9 P1: admission order belongs to the keypresses, not the attestation response order.
test("two quick submits dispatch in keypress order when cuts resolve in reverse", async () => {
	const answers: Array<(answer: CutAnswer) => void> = [];
	const { mode, editor, cut, send } = setup(() => new Promise((resolve) => answers.push(resolve)), 1000);
	send("first\rsecond\rnext");
	expect(cut.mock.calls.map(([request]) => ({ seq: request.seq, cut: request.cut }))).toEqual([
		{ seq: 1, cut: 6 },
		{ seq: 2, cut: 13 },
	]);
	expect(editor.getText()).toBe("next");
	answers[1]!(PAUL);
	// Let the second cut settle without resolving the first or relying on a wall-clock delay.
	await new Promise<void>((resolve) => setImmediate(resolve));
	answers[0]!(PAUL);
	await submitted(mode, 2);
	expect(mode.pendingUserInputs.map((input) => input.text)).toEqual(["first", "second"]);
	expect(mode.pendingUserInputs.map((input) => receiptRecord(getInputReceipt(input)).channel)).toEqual([
		"keyboard",
		"keyboard",
	]);
	expect(editor.getText()).toBe("next");
});

// pi#160 R9b: a selector continuation that never settles must not hold later Enter submissions.
test("an unsettled /scoped-models dispatch does not block later Enter", async () => {
	const { mode, editor, send } = setup();
	const selector = vi.spyOn(mode, "showModelsSelector").mockImplementation(() => new Promise<void>(() => {}));
	send("/scoped-models\r");
	await vi.waitFor(() => expect(selector).toHaveBeenCalledOnce());
	send("hello\rnext");
	const input = await submitted(mode);
	expect(input.text).toBe("hello");
	expect(receiptRecord(getInputReceipt(input)).channel).toBe("keyboard");
	expect(editor.getText()).toBe("next");
});

// pi#160 R9b: a pending /compact must leave the existing visible compaction queue reachable.
test("Enter during pending /compact reaches the compaction queue", async () => {
	initTheme("dark");
	const { mode, editor, send } = setup();
	vi.spyOn(mode.runtimeHost.session, "compact").mockImplementation(() => {
		mode.runtimeHost.session.isCompacting = true;
		return new Promise<void>(() => {});
	});
	send("/compact\r");
	await vi.waitFor(() => expect(mode.runtimeHost.session.isCompacting).toBe(true));
	send("hello\rnext");
	await vi.waitFor(() => expect(mode.compactionQueuedMessages).toHaveLength(1));

	const queued = mode.compactionQueuedMessages[0]!;
	expect(queued.mode).toBe("steer");
	expect(queued.input.text).toBe("hello");
	expect(receiptRecord(getInputReceipt(queued.input)).channel).toBe("keyboard");
	expect(mode.pendingUserInputs).toEqual([]);
	expect(stripAnsi(mode.chatContainer.render(120).join("\n"))).toContain("Queued message for after compaction");
	expect(stripAnsi(mode.pendingMessagesContainer.render(120).join("\n"))).toContain("Steering: hello");
	expect(editor.getText()).toBe("next");
});

test("accepted submit cuts synchronously at Enter before later bytes or attestation await", async () => {
	let resolveCut!: (answer: CutAnswer) => void;
	const { mode, editor, cut, send } = setup(
		() =>
			new Promise((resolve) => {
				resolveCut = resolve;
			}),
	);
	send("first\rnext");
	expect(cut).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			cut: 6,
			digest: createHash("sha256").update("first\r").digest("hex"),
			kind: "submit",
		}),
	);
	expect(mode.pendingUserInputs).toEqual([]);
	expect(editor.getText()).toBe("next");
	resolveCut(PAUL);
	const input = await submitted(mode);
	expect(input.text).toBe("first");
	expect(receiptRecord(getInputReceipt(input)).channel).toBe("keyboard");
	expect(editor.getText()).toBe("next");
});
