import assert from "node:assert/strict";
import { it } from "node:test";
import { Loader } from "../src/components/loader.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { Container, CURSOR_MARKER, type TUI } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Regression: smarty-dev#5181. Animation clocks must not traverse the transcript.
it("paints a nested loader locally, preserving transcript and hardware cursor", async () => {
	const terminal = new VirtualTerminal(40, 10);
	const ui = new TuiMainScreen(terminal, true);
	let renders = 0;
	const transcript = {
		render: () => {
			renders++;
			return Array.from({ length: 2000 }, (_, i) => `line ${i}`);
		},
		invalidate() {},
	};
	ui.addChild(transcript);
	const status = new Container();
	ui.addChild(status);
	const loader = new Loader(
		ui,
		(s) => s,
		(s) => s,
		"waiting",
		{ frames: ["a", "b"], intervalMs: 60_000 },
	);
	let loaderRenders = 0;
	const renderLoader = loader.render.bind(loader);
	loader.render = (width) => {
		loaderRenders++;
		return renderLoader(width);
	};
	status.addChild(loader);
	ui.addChild({ render: () => [`${CURSOR_MARKER}editor`], invalidate() {} });
	ui.start();
	await terminal.waitForRender();
	const before = terminal.getViewport();
	const cursor = terminal.getCursorPosition();
	const count = renders;
	const loaderCount = loaderRenders;
	try {
		loader.setText("b waiting");
		ui.requestAnimationRender(loader);
		ui.requestAnimationRender(loader);
		await terminal.waitForRender();
		assert.equal(renders, count);
		assert.equal(loaderRenders, loaderCount + 1);
		const after = terminal.getViewport();
		assert.ok(after.some((line) => line.includes("b waiting")));
		assert.deepEqual(
			after.filter((line) => !line.includes("waiting")),
			before.filter((line) => !line.includes("waiting")),
		);
		assert.deepEqual(terminal.getCursorPosition(), cursor);
		ui.requestRender();
		await terminal.waitForRender();
		assert.equal(renders, count + 1);
		assert.ok(terminal.getViewport().some((line) => line.includes("b waiting")));
	} finally {
		loader.stop();
		ui.stop();
	}
});

// Regression: smarty-dev#5181. Output and even consumed keypresses wake the spinner.
it("slows to one frame per second and wakes on output or terminal input", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	let activity: (() => void) | undefined;
	let frames = 0;
	const ui = {
		requestRender(_force?: boolean, animation?: boolean) {
			if (!animation) activity?.();
		},
		requestAnimationRender() {
			frames++;
		},
		onActivity(listener: () => void) {
			activity = listener;
			return () => {
				activity = undefined;
			};
		},
	} as unknown as TUI;
	const loader = new Loader(
		ui,
		(s) => s,
		(s) => s,
		"waiting",
	);
	try {
		for (let i = 0; i < 125; i++) t.mock.timers.tick(80);
		assert.equal(frames, 125);
		t.mock.timers.tick(999);
		assert.equal(frames, 125);
		t.mock.timers.tick(1);
		assert.equal(frames, 126);
		ui.requestRender(false, true); // Elapsed label does not count as new output.
		t.mock.timers.tick(1000);
		assert.equal(frames, 127);
		ui.requestRender();
		t.mock.timers.tick(80);
		assert.equal(frames, 128);
		for (let i = 0; i < 124; i++) t.mock.timers.tick(80);
		const idleFrames = frames;
		activity?.();
		t.mock.timers.tick(80);
		assert.equal(frames, idleFrames + 1);
		loader.stop();
		t.mock.timers.tick(5000);
		assert.equal(frames, idleFrames + 1);
		assert.equal(activity, undefined);
		loader.start();
		t.mock.timers.tick(80);
		assert.equal(frames, idleFrames + 2);
	} finally {
		loader.stop();
	}
});

// Regression: smarty-dev#5181. Geometry changes must use the normal renderer.
it("falls back on resize, wrapping, overlays, and pending ordinary renders", async () => {
	const terminal = new VirtualTerminal(30, 10);
	const ui = new TuiMainScreen(terminal);
	let renders = 0;
	ui.addChild({
		render: () => {
			renders++;
			return ["transcript"];
		},
		invalidate() {},
	});
	const loader = new Loader(
		ui,
		(s) => s,
		(s) => s,
		"waiting",
		{ frames: ["a", "b"], intervalMs: 60_000 },
	);
	ui.addChild(loader);
	ui.start();
	await terminal.waitForRender();
	try {
		let count = renders;
		loader.setText("long ".repeat(20));
		ui.requestAnimationRender(loader);
		await terminal.waitForRender();
		assert.equal(renders, count + 1);
		count = renders;
		terminal.resize(40, 10);
		ui.requestAnimationRender(loader);
		await terminal.waitForRender();
		assert.equal(renders, count + 1);
		count = renders;
		const overlay = ui.showOverlay(new Text("overlay"));
		await terminal.waitForRender();
		assert.equal(renders, count + 1);
		count = renders;
		loader.setText("b waiting");
		ui.requestAnimationRender(loader);
		await terminal.waitForRender();
		assert.equal(renders, count + 1);
		overlay.hide();
		await terminal.waitForRender();
		count = renders;
		ui.requestAnimationRender(loader);
		ui.requestRender();
		await terminal.waitForRender();
		assert.equal(renders, count + 1);
	} finally {
		loader.stop();
		ui.stop();
	}
});

// Regression: smarty-dev#5181. Fullscreen status animations must not rebuild scroll content.
it("paints fullscreen status loaders locally and preserves the editor cursor", async () => {
	const terminal = new VirtualTerminal(40, 10);
	const ui = new TuiAltScreen(terminal, true);
	let renders = 0;
	const transcript = {
		render: () => {
			renders++;
			return Array.from({ length: 2000 }, (_, i) => `line ${i}`);
		},
		invalidate() {},
	};
	const status = new Container();
	const loader = new Loader(
		ui,
		(s) => s,
		(s) => s,
		"waiting",
		{ frames: ["a", "b"], intervalMs: 60_000 },
	);
	status.addChild(loader);
	ui.setLayoutRoot(
		new VStack([
			{ component: new ScrollView(transcript, { follow: "end", primary: true }), grow: 1, shrink: 1 },
			{ component: status, shrink: 0 },
			{ component: { render: () => [`${CURSOR_MARKER}editor`], invalidate() {} }, shrink: 0 },
		]),
	);
	ui.start();
	await terminal.waitForRender();
	try {
		const count = renders;
		const cursor = terminal.getCursorPosition();
		const before = terminal.getViewport();
		loader.setText("b waiting");
		ui.requestAnimationRender(loader);
		await terminal.waitForRender();
		assert.equal(renders, count);
		assert.ok(terminal.getViewport().some((line) => line.includes("b waiting")));
		assert.deepEqual(terminal.getCursorPosition(), cursor);
		assert.deepEqual(
			terminal.getViewport().filter((line) => !line.includes("waiting")),
			before.filter((line) => !line.includes("waiting")),
		);
	} finally {
		loader.stop();
		ui.stop();
	}
});

// Regression: smarty-dev#5181. Interactive renderer switches retain the terminal and live loaders.
it("retains wake-up subscriptions across renderer replacement", () => {
	const terminal = new VirtualTerminal();
	const previous = new TuiMainScreen(terminal);
	let activity = 0;
	const unsubscribe = previous.onActivity(() => activity++);
	const next = new TuiAltScreen(terminal);
	next.requestRender();
	assert.equal(activity, 1);
	unsubscribe();
	next.requestRender();
	assert.equal(activity, 1);
	previous.stop();
	next.stop();
});

// Regression: smarty-dev#5181. Key listeners may consume input before focus dispatch.
it("wakes on consumed keypresses without counting animation ticks as activity", async () => {
	const terminal = new VirtualTerminal();
	const ui = new TuiMainScreen(terminal);
	let activity = 0;
	const unsubscribe = ui.onActivity(() => activity++);
	ui.addInputListener(() => ({ consume: true }));
	ui.start();
	await terminal.waitForRender();
	try {
		const before = activity;
		terminal.sendInput("x");
		assert.equal(activity, before + 1);
		ui.requestRender(false, true);
		await terminal.waitForRender();
		assert.equal(activity, before + 1);
		ui.requestRender();
		assert.equal(activity, before + 2);
	} finally {
		unsubscribe();
		ui.stop();
	}
});
