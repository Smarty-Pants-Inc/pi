import { Container, ScrollView, type TUI, TuiAltScreen, TuiMainScreen, VStack } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createShellRenderers } from "../src/core/tools/renderers/bash.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

// Regression: smarty-dev#5181. The real working spinner is normally embedded in the editor border.
it("redirects embedded spinner ticks to the editor and releases the target on detach", () => {
	const requestAnimationRender = vi.fn();
	const ui = { requestAnimationRender, requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
	const editor = new CustomEditor(ui, getEditorTheme(), KeybindingsManager.create(), { embedWorkingStatus: true });
	const indicator = new WorkingStatusIndicator(ui, "Working");
	try {
		editor.setWorkingStatusIndicator(indicator);
		vi.advanceTimersByTime(80);
		expect(requestAnimationRender).toHaveBeenCalledExactlyOnceWith(editor);
		requestAnimationRender.mockClear();
		editor.setWorkingStatusIndicator(undefined);
		vi.advanceTimersByTime(80);
		expect(requestAnimationRender).toHaveBeenCalledExactlyOnceWith(indicator);
	} finally {
		indicator.dispose();
	}
});

// Regression: smarty-dev#5181. Exercise both renderers with the actual editor and a 2000-line transcript.
it.each(["regular", "fullscreen"] as const)("locally redraws an embedded working spinner in %s mode", async (mode) => {
	vi.useRealTimers();
	const terminal = new VirtualTerminal(80, 16);
	const ui = mode === "regular" ? new TuiMainScreen(terminal, true) : new TuiAltScreen(terminal, true);
	let renders = 0;
	const transcript = {
		render: () => {
			renders++;
			return Array.from({ length: 2000 }, (_, i) => `line ${i}`);
		},
		invalidate() {},
	};
	const editor = new CustomEditor(ui, getEditorTheme(), KeybindingsManager.create(), { embedWorkingStatus: true });
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const indicator = new WorkingStatusIndicator(ui, "Working", { frames: ["a", "b"], intervalMs: 60_000 });
	editor.setWorkingStatusIndicator(indicator);
	if (ui instanceof TuiAltScreen)
		ui.setLayoutRoot(
			new VStack([
				{ component: new ScrollView(transcript, { follow: "end", primary: true }), grow: 1 },
				{ component: editorContainer, shrink: 0 },
			]),
		);
	else {
		ui.addChild(transcript);
		ui.addChild(editorContainer);
	}
	ui.setFocus(editor);
	ui.start();
	await terminal.waitForRender();
	try {
		const count = renders;
		const cursor = terminal.getCursorPosition();
		const before = terminal.getViewport();
		indicator.setText("b Working");
		ui.requestAnimationRender(editor);
		await terminal.waitForRender();
		expect(renders).toBe(count);
		expect(terminal.getViewport().some((line) => line.includes("b Working"))).toBe(true);
		expect(terminal.getCursorPosition()).toEqual(cursor);
		expect(terminal.getViewport().filter((line) => !line.includes("Working"))).toEqual(
			before.filter((line) => !line.includes("Working")),
		);
	} finally {
		indicator.dispose();
		ui.stop();
	}
});

beforeEach(() => {
	vi.useFakeTimers();
	initTheme(undefined, false);
});
afterEach(() => vi.useRealTimers());

// Regression: smarty-dev#5181. The shell elapsed clock must not keep the working spinner active.
it("marks elapsed-label invalidations as animation and stops the clock on completion", () => {
	const requestRender = vi.fn();
	const requestAnimationRender = vi.fn();
	const ui = { requestRender, requestAnimationRender } as unknown as TUI;
	const component = new ToolExecutionComponent(
		"bash",
		"shell-5181",
		{ command: "sleep 240" },
		{},
		createShellRenderers("$"),
		ui,
		"/tmp",
	);
	component.markExecutionStarted();
	component.updateResult({ content: [], isError: false }, true);
	requestRender.mockClear();
	vi.advanceTimersByTime(1000);
	expect(requestAnimationRender).toHaveBeenCalledExactlyOnceWith(component);
	expect(requestRender).not.toHaveBeenCalled();
	expect(component.render(80).join("\n")).toContain("Elapsed 1.0s");
	component.updateResult({ content: [], isError: false }, false);
	expect(component.render(80).join("\n")).toContain("Took 1.0s");
	requestRender.mockClear();
	requestAnimationRender.mockClear();
	vi.advanceTimersByTime(5000);
	expect(requestRender).not.toHaveBeenCalled();
	expect(requestAnimationRender).not.toHaveBeenCalled();
});
