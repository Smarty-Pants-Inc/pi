import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, it, type TestContext } from "node:test";
import { Loader } from "../src/components/loader.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import type { Terminal } from "../src/terminal.ts";
import { getCellDimensions, setCellDimensions } from "../src/terminal-image.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class InputTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	writes: string[] = [];
	input?: (data: string) => void;
	resize?: () => void;
	start(input: (data: string) => void, resize: () => void): void {
		this.input = input;
		this.resize = resize;
	}
	stop(): void {
		this.input = undefined;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

class CountingComponent implements Component {
	renders = 0;
	inputs: string[] = [];
	text = "initial";
	lastRendered = "";
	render(): string[] {
		this.renders++;
		this.lastRendered = this.text;
		return [this.text];
	}
	handleInput(data: string): void {
		this.inputs.push(data);
		this.text = data;
	}
	invalidate(): void {}
}

const nextTick = () => new Promise<void>((resolve) => process.nextTick(resolve));

function trackTimers(t: TestContext): Set<NodeJS.Timeout> {
	const active = new Set<NodeJS.Timeout>();
	const timeout = globalThis.setTimeout;
	const interval = globalThis.setInterval;
	const clearTimeout = globalThis.clearTimeout;
	const clearInterval = globalThis.clearInterval;
	t.mock.method(globalThis, "setTimeout", (callback: () => void, ms?: number) => {
		const handle = timeout(() => {
			active.delete(handle);
			callback();
		}, ms);
		active.add(handle);
		return handle;
	});
	t.mock.method(globalThis, "setInterval", (callback: () => void, ms?: number) => {
		const handle = interval(callback, ms);
		active.add(handle);
		return handle;
	});
	t.mock.method(globalThis, "clearTimeout", (handle: NodeJS.Timeout) => {
		active.delete(handle);
		clearTimeout(handle);
	});
	t.mock.method(globalThis, "clearInterval", (handle: NodeJS.Timeout) => {
		active.delete(handle);
		clearInterval(handle);
	});
	return active;
}

// smarty-dev#7403 / #7222: count component work and timers, not only terminal writes.
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	describe(`${Renderer.name} event-driven visibility and 10 fps cap`, () => {
		for (const focus of ["default", "focused"] as const) {
			it(`coalesces a visible 2 second 100 Hz stream (${focus})`, async (t) => {
				let now = 0;
				t.mock.method(performance, "now", () => now);
				t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
				const timers = trackTimers(t);
				const terminal = new InputTerminal();
				const tui = new Renderer(terminal);
				const component = new CountingComponent();
				tui.addChild(component);
				tui.start();
				if (focus === "focused") terminal.input?.("\x1b[I");
				tui.renderNow();
				await nextTick();
				try {
					for (let token = 0; token < 200; token++) {
						component.text = `token ${token}`;
						tui.requestRender();
						await nextTick();
						now += 10;
						t.mock.timers.tick(10);
						await nextTick();
					}
					assert.ok(component.renders <= 21, `${component.renders} renders exceeds 21`);
					assert.ok(component.renders >= 20);
					assert.equal(component.lastRendered, "token 199");
					assert.equal(timers.size, 0, "visible idle must have no frame timer");
					const renders = component.renders;
					now += 2000;
					t.mock.timers.tick(2000);
					await nextTick();
					assert.equal(component.renders, renders, "no idle redraws");
					t.diagnostic(`visible-stream ${Renderer.name} ${focus}: ${renders} renders/2000ms including initial`);
				} finally {
					tui.stop();
				}
			});
		}

		it("hidden 2 seconds at 100 Hz: zero frames/timers; focus-in draws latest state once", async (t) => {
			let now = 0;
			t.mock.method(performance, "now", () => now);
			t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const timers = trackTimers(t);
			const terminal = new InputTerminal();
			const tui = new Renderer(terminal);
			const component = new CountingComponent();
			const loader = new Loader(
				tui,
				(s) => s,
				(s) => s,
				"Working",
				{ frames: ["-", "+"], intervalMs: 10 },
			);
			const listenerInputs: string[] = [];
			tui.addChild(component);
			tui.addChild(loader);
			tui.setFocus(component);
			tui.addInputListener((data) => {
				listenerInputs.push(data);
				return undefined;
			});
			tui.start();
			tui.renderNow();
			await nextTick();
			try {
				assert.ok(terminal.writes.includes("\x1b[?1004h"));
				component.text = "pending";
				tui.requestRender();
				await nextTick();
				assert.equal(timers.size, 2, "pending frame plus visible spinner");
				terminal.input?.("\x1b[O");
				assert.equal(timers.size, 0, "focus-out must cancel frame and spinner timers synchronously");
				const renders = component.renders;
				const writes = terminal.writes.length;
				const resets = t.mock.method(tui as unknown as { resetRenderState(): void }, "resetRenderState");
				for (let token = 0; token < 200; token++) {
					component.text = `token ${token}`;
					loader.setMessage(component.text);
					tui.requestRender();
					// Forced and direct renders alone must not override hidden visibility.
					if (token % 25 === 0) {
						tui.requestRender(true);
						tui.renderNow(true);
					}
					await nextTick();
					now += 10;
					t.mock.timers.tick(10);
					await nextTick();
					assert.equal(timers.size, 0);
				}
				assert.equal(component.renders, renders);
				assert.equal(terminal.writes.length, writes);
				assert.equal(resets.mock.calls.length, 0, "hidden forced requests only mark dirty; no cache reset work");
				terminal.input?.("\x1b[I");
				await nextTick();
				assert.equal(component.renders, renders + 1);
				assert.equal(component.lastRendered, "token 199");
				assert.ok(terminal.writes.at(-1)?.includes("token 199"));
				assert.equal(timers.size, 1, "only the resumed spinner interval");
				assert.deepEqual(listenerInputs, []);
				assert.deepEqual(component.inputs, []);
				terminal.input?.("\x1b[I");
				await nextTick();
				assert.equal(component.renders, renders + 1, "duplicate focus-in is not a state change");
				loader.stop();
				assert.equal(timers.size, 0);
				now += 2000;
				t.mock.timers.tick(2000);
				await nextTick();
				assert.equal(component.renders, renders + 1);
				t.diagnostic(
					`hidden-stream ${Renderer.name}: 0 renders, 0 active timers/2000ms; resume: 1 full render, token 199`,
				);
			} finally {
				loader.stop();
				tui.stop();
			}
			assert.ok(terminal.writes.includes("\x1b[?1004l"));
		});

		for (const hidden of [false, true]) {
			it(`keyboard and forced renders are immediate (initially hidden=${hidden})`, async (t) => {
				let now = 0;
				t.mock.method(performance, "now", () => now);
				t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
				const terminal = new InputTerminal();
				const tui = new Renderer(terminal);
				const component = new CountingComponent();
				tui.addChild(component);
				tui.setFocus(component);
				tui.start();
				tui.renderNow();
				await nextTick();
				try {
					if (hidden) terminal.input?.("\x1b[O");
					tui.requestRender();
					await nextTick();
					terminal.input?.("k");
					await nextTick();
					assert.equal(component.renders, 2);
					assert.equal(now, 0, "keyboard must render before any timer frame");
					assert.equal(component.lastRendered, "k");
					tui.requestRender();
					await nextTick();
					tui.requestRender(true);
					await nextTick();
					assert.equal(component.renders, 3);
					now = 2000;
					t.mock.timers.tick(2000);
					await nextTick();
					assert.equal(component.renders, 3);
				} finally {
					tui.stop();
				}
			});
		}

		it("renders listener-consumed shortcuts immediately, but caps mouse requests", async (t) => {
			let now = 0;
			t.mock.method(performance, "now", () => now);
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const terminal = new InputTerminal();
			const tui = new Renderer(terminal);
			const component = new CountingComponent();
			tui.addChild(component);
			tui.addInputListener((data) => {
				component.text = data;
				tui.requestRender();
				return { consume: true };
			});
			tui.start();
			tui.renderNow();
			await nextTick();
			try {
				terminal.input?.("\x1b[O");
				terminal.input?.("x");
				await nextTick();
				assert.equal(component.renders, 2);
				assert.deepEqual(component.inputs, []);
				terminal.input?.("\x1b[<35;1;1M");
				await nextTick();
				assert.equal(component.renders, 2);
				now = 100;
				t.mock.timers.tick(100);
				await nextTick();
				assert.ok(component.renders <= 3);
			} finally {
				tui.stop();
			}
		});

		it("stop/restart pauses animations and renders dirty current state once", async (t) => {
			let now = 0;
			t.mock.method(performance, "now", () => now);
			t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const timers = trackTimers(t);
			const terminal = new InputTerminal();
			const tui = new Renderer(terminal);
			const component = new CountingComponent();
			const loader = new Loader(
				tui,
				(s) => s,
				(s) => s,
			);
			tui.addChild(component);
			tui.addChild(loader);
			tui.start();
			tui.renderNow();
			await nextTick();
			terminal.input?.("\x1b[O");
			component.text = "stopped update";
			tui.requestRender();
			tui.stop();
			assert.equal(timers.size, 0);
			const renders = component.renders;
			now = 2000;
			t.mock.timers.tick(2000);
			await nextTick();
			assert.equal(component.renders, renders);
			tui.start();
			await nextTick();
			assert.equal(component.renders, renders, "restart preserves known hidden focus state");
			assert.equal(timers.size, 0);
			terminal.input?.("\x1b[I");
			await nextTick();
			assert.equal(component.renders, renders + 1);
			assert.equal(component.lastRendered, "stopped update");
			assert.equal(timers.size, 1);
			loader.stop();
			terminal.input?.("\x1b[O");
			terminal.input?.("\x1b[I");
			await nextTick();
			assert.equal(timers.size, 0, "stopped loaders must not resurrect on focus");
			tui.stop();
		});

		it("clamps fast spinners to 10 fps and pauses loaders created while hidden", async (t) => {
			let now = 0;
			t.mock.method(performance, "now", () => now);
			t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const timers = trackTimers(t);
			const terminal = new InputTerminal();
			const tui = new Renderer(terminal);
			const component = new CountingComponent();
			tui.addChild(component);
			tui.start();
			tui.renderNow();
			await nextTick();
			terminal.input?.("\x1b[O");
			const loader = new Loader(
				tui,
				(s) => s,
				(s) => s,
				"Working",
				{ frames: ["-", "+"], intervalMs: 1 },
			);
			tui.addChild(loader);
			assert.equal(timers.size, 0);
			terminal.input?.("\x1b[I");
			await nextTick();
			const renders = component.renders;
			try {
				for (let tick = 0; tick < 200; tick++) {
					now += 10;
					t.mock.timers.tick(10);
					await nextTick();
				}
				const frames = component.renders - renders;
				assert.ok(frames <= 20, `${frames} spinner frames exceeds 20`);
				assert.ok(frames >= 18);
				t.diagnostic(`spinner ${Renderer.name}: ${frames} frames/2000ms, minimum interval 100ms`);
			} finally {
				loader.stop();
				tui.stop();
			}
			assert.equal(timers.size, 0);
		});
	});
}

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	it(`${Renderer.name} mouse input does not bypass the cap through component dispatch`, async (t) => {
		let now = 0;
		t.mock.method(performance, "now", () => now);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const counter = new CountingComponent();
		tui.addChild(counter);
		tui.setFocus(counter);
		tui.start();
		tui.renderNow();
		await nextTick();
		terminal.input?.("\x1b[<0;1;1M");
		await nextTick();
		assert.equal(counter.renders, 1);
		now = 99;
		t.mock.timers.tick(99);
		await nextTick();
		assert.equal(counter.renders, 1);
		now = 100;
		t.mock.timers.tick(1);
		await nextTick();
		assert.equal(counter.renders, 2);
		tui.stop();
	});
}

// smarty-dev#7403: invalid extension intervals must not become Node's 1 ms overflow timer.
it("clamps non-finite and sub-frame spinner intervals", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const intervals = t.mock.method(globalThis, "setInterval");
	const tui = new TuiMainScreen(new InputTerminal());
	for (const intervalMs of [1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const loader = new Loader(
			tui,
			(s) => s,
			(s) => s,
			"Working",
			{ frames: ["-", "+"], intervalMs },
		);
		assert.equal(intervals.mock.calls.at(-1)?.arguments[1], 100);
		loader.stop();
	}
	tui.stop();
});

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	it(`${Renderer.name} Unicode keyboard input restores a lied-about hidden pane`, async () => {
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const counter = new CountingComponent();
		tui.addChild(counter);
		tui.setFocus(counter);
		tui.start();
		tui.renderNow();
		await nextTick();
		terminal.input?.("\x1b[O");
		terminal.input?.("\u{1f642}");
		await nextTick();
		assert.equal(counter.renders, 2);
		assert.equal(counter.lastRendered, "\u{1f642}");
		tui.stop();
	});
}

// smarty-dev#7403: changing regular/fullscreen mode must not strand a loader on the stopped renderer.
it("visibility subscriptions survive renderer replacement on the same terminal", async (t) => {
	const now = 0;
	t.mock.method(performance, "now", () => now);
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const timers = trackTimers(t);
	const terminal = new InputTerminal();
	const main = new TuiMainScreen(terminal);
	const loader = new Loader(
		main,
		(s) => s,
		(s) => s,
	);
	main.addChild(loader);
	main.start();
	main.renderNow();
	await nextTick();
	main.stop({ preserveScreen: true });
	assert.equal(timers.size, 0);
	const alt = new TuiAltScreen(terminal);
	alt.start();
	await nextTick();
	assert.equal(timers.size, 1, "live loader resumes on the replacement renderer");
	terminal.input?.("\x1b[O");
	assert.equal(timers.size, 0);
	terminal.input?.("\x1b[I");
	await nextTick();
	assert.equal(timers.size, 1);
	loader.stop();
	alt.stop();
	assert.equal(timers.size, 0);
});

// smarty-dev#7403: cosmetic one-shot timers also stop, not merely repeating spinners.
it("fullscreen focus-out cancels flash/scrollbar/drag timers; hidden mutations create none", async (t) => {
	let now = 0;
	t.mock.method(performance, "now", () => now);
	t.mock.method(Date, "now", () => now);
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const timers = trackTimers(t);
	const terminal = new InputTerminal();
	const tui = new TuiAltScreen(terminal);
	const view = new ScrollView(new Text(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), 0, 0), {
		follow: "end",
		primary: true,
		scrollbar: "auto",
	});
	tui.setLayoutRoot(view);
	tui.start();
	tui.renderNow();
	await nextTick();
	tui.flash("expires while hidden", 1000);
	view.scrollBy(-1);
	await nextTick();
	assert.ok(timers.size >= 2);
	terminal.input?.("\x1b[O");
	assert.equal(timers.size, 0);
	now = 2000;
	t.mock.timers.tick(2000);
	await nextTick();
	tui.flash("current", 500);
	view.scrollBy(-1);
	await nextTick();
	assert.equal(timers.size, 0);
	const fullRedraws = tui.fullRedraws;
	terminal.input?.("\x1b[I");
	await nextTick();
	assert.equal(tui.fullRedraws, fullRedraws + 1);
	assert.ok(terminal.writes.at(-1)?.includes(" current "));
	assert.ok(!terminal.writes.at(-1)?.includes("expires while hidden"));
	assert.equal(timers.size, 1, "only the unexpired visible flash deadline");
	terminal.input?.("\x1b[O");
	tui.stop();
	assert.equal(timers.size, 0);
});

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	it(`${Renderer.name} shutdown does not render hidden components`, async () => {
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const component = new CountingComponent();
		tui.addChild(component);
		tui.start();
		tui.renderNow();
		await nextTick();
		terminal.input?.("\x1b[O");
		const renders = component.renders;
		tui.stop();
		assert.equal(component.renders, renders);
	});
}

it("VirtualTerminal waits for capped and unchanged frames without sleeping 20 ms", async () => {
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const text = new Text("initial", 0, 0);
	tui.addChild(text);
	tui.start();
	await terminal.waitForRender();
	try {
		text.setText("latest state");
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("latest state")));
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("latest state")));
	} finally {
		tui.stop();
	}
});

// smarty-dev#7403: only exact, fully assembled CSI focus reports control visibility.
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	it(`${Renderer.name} parses split focus reports, Alt-O and literal focus bytes in paste`, async () => {
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const component = new CountingComponent();
		const inputs: string[] = [];
		const visibility: boolean[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			inputs.push(data);
			return undefined;
		});
		tui.onVisibilityChange((visible) => visibility.push(visible));
		tui.start();
		tui.renderNow();
		await nextTick();
		visibility.length = 0;
		const buffer = new StdinBuffer();
		buffer.on("data", (data) => terminal.input?.(data));
		buffer.on("paste", (content) => terminal.input?.(`\x1b[200~${content}\x1b[201~`));
		try {
			// Each byte arrives on a separate read; prefixes must not be mistaken for focus.
			buffer.process("\x1b");
			buffer.process("[");
			assert.deepEqual(visibility, []);
			buffer.process("O");
			assert.deepEqual(visibility, [false]);
			const renders = component.renders;
			component.text = "latest after fragmented focus";
			tui.requestRender();
			await nextTick();
			assert.equal(component.renders, renders);
			buffer.process("\x1b");
			buffer.process("[");
			assert.deepEqual(visibility, [false]);
			buffer.process("I");
			await nextTick();
			assert.deepEqual(visibility, [false, true]);
			assert.equal(component.renders, renders + 1);
			assert.equal(component.lastRendered, "latest after fragmented focus");
			assert.deepEqual(inputs, []);
			assert.deepEqual(component.inputs, []);

			buffer.process("\x1b");
			buffer.process("O");
			// ESC O is an incomplete SS3 prefix until timeout, then remains a key, not CSI O.
			for (const data of buffer.flush()) terminal.input?.(data);
			await nextTick();
			assert.equal(component.inputs.at(-1), "\x1bO");
			assert.deepEqual(visibility, [false, true], "Alt-O must never hide the pane");
			buffer.process("\x1b[200~literal\x1b");
			buffer.process("[O and \x1b[I");
			buffer.process("\x1b[201~");
			await nextTick();
			assert.equal(component.inputs.at(-1), "\x1b[200~literal\x1b[O and \x1b[I\x1b[201~");
			assert.deepEqual(visibility, [false, true], "focus bytes in paste must remain text");

			buffer.process("\x1b[Ox\x1b[Iy");
			await nextTick();
			assert.deepEqual(component.inputs.slice(-2), ["x", "y"]);
			assert.deepEqual(inputs.slice(-2), ["x", "y"]);
			assert.deepEqual(visibility, [false, true, false, true]);
		} finally {
			buffer.destroy();
			tui.stop();
		}
	});
}

// smarty-dev#7403: a resize already being dispatched must not re-enable focus after stop.
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	it(`${Renderer.name} ignores a stale resize callback after stop`, async () => {
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const component = new CountingComponent();
		tui.addChild(component);
		tui.start();
		tui.renderNow();
		await nextTick();
		const resize = terminal.resize;
		tui.stop({ preserveScreen: true });
		const writes = terminal.writes.length;
		const renders = component.renders;
		resize?.();
		await nextTick();
		assert.equal(terminal.writes.length, writes, "do not re-enable ?1004h on exit");
		assert.equal(component.renders, renders);
	});
}

// smarty-dev#7403 round 4: only outstanding OSC 11 queries may remove input bytes.
const osc11Reply = "\x1b]11;rgb:ffff/0000/0000\x07";
const unrequestedReports = [
	["modified F3", "\x1b[1;5R"],
	["CPR", "\x1b[12;34R"],
	["DEC CPR", "\x1b[?12;34;1R"],
	["DA1", "\x1b[?1;2c"],
	["DA2", "\x1b[>0;276;0c"],
	["DSR", "\x1b[0n"],
	["private DSR", "\x1b[?10n"],
	["DECRQM", "\x1b[?1004;1$y"],
	["Kitty flags", "\x1b[?7u"],
	["Kitty query", "\x1b[?u"],
	["XTVERSION", "\x1bP>|XTerm(276)\x1b\\"],
	["color scheme", "\x1b[?997;2n"],
	["cell size", "\x1b[6;20;10t"],
] as const;

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	for (const scenario of [
		...unrequestedReports.map(([kind, input]) => ({
			kind,
			parts: [input],
			pending: false,
			expired: false,
			delivered: input,
			// pi#177: terminal-originated reports are delivered but never recover a hidden pane.
			recovers: kind !== "color scheme" && kind !== "cell size",
		})),
		{ kind: "unsolicited OSC 11", parts: [osc11Reply], pending: false, expired: false, delivered: osc11Reply },
		{ kind: "expired OSC 11", parts: [osc11Reply], pending: true, expired: true, delivered: osc11Reply },
		{ kind: "pending OSC 11 BEL", parts: [osc11Reply], pending: true, expired: false, delivered: "" },
		{ kind: "pending OSC 11 ST", parts: ["\x1b]11;#ff0000\x1b\\"], pending: true, expired: false, delivered: "" },
		{
			kind: "split OSC 11 payload",
			parts: ["\x1b]11;rgb:ffff/", "0000/0000\x07"],
			pending: true,
			expired: false,
			delivered: "",
		},
		{
			kind: "split OSC 11 prefix",
			parts: ["\x1b]1", "1;rgb:ffff/0000/0000\x07"],
			pending: true,
			expired: false,
			delivered: "",
		},
		{
			kind: "split OSC 11 ST",
			parts: ["\x1b]11;rgb:ffff/0000/0000\x1b", "\\"],
			pending: true,
			expired: false,
			delivered: "",
		},
		{ kind: "pending OSC 11 plus key", parts: [`${osc11Reply}k`], pending: true, expired: false, delivered: "k" },
		{
			kind: "one query with two replies",
			parts: [osc11Reply + osc11Reply],
			pending: true,
			expired: false,
			delivered: osc11Reply,
		},
		{
			kind: "partial OSC prefix diverges",
			parts: ["\x1b]1", "0;not-a-reply\x07"],
			pending: true,
			expired: false,
			delivered: "\x1b]10;not-a-reply\x07",
		},
		{ kind: "modified F3 during query", parts: ["\x1b[1;5R"], pending: true, expired: false, delivered: "\x1b[1;5R" },
	]) {
		it(`${Renderer.name} hidden ${scenario.kind}`, async (t) => {
			t.mock.method(performance, "now", () => 0);
			t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const timers = trackTimers(t);
			const terminal = new InputTerminal();
			const tui = new Renderer(terminal);
			const component = new CountingComponent();
			const inputs: string[] = [];
			const visibility: boolean[] = [];
			tui.addChild(component);
			tui.setFocus(component);
			tui.addInputListener((data) => {
				inputs.push(data);
				return undefined;
			});
			tui.onVisibilityChange((visible) => visibility.push(visible));
			tui.start();
			tui.renderNow();
			await nextTick();
			visibility.length = 0;
			try {
				const query = scenario.pending ? tui.queryTerminalBackgroundColor({ timeoutMs: 1000 }) : undefined;
				// Expiration is possible only while visible; hidden queries remain outstanding.
				if (scenario.expired) {
					t.mock.timers.tick(1000);
					assert.equal(await query, undefined);
				}
				terminal.input?.("\x1b[O");
				component.text = "latest hidden state";
				tui.requestRender();
				await nextTick();
				assert.equal(timers.size, 0, "focus-out must cancel every pending OSC 11 timeout");
				t.mock.timers.tick(2000);
				await nextTick();
				const renders = component.renders;
				const full = tui.fullRedraws;
				const writes = terminal.writes.length;
				for (const [index, part] of scenario.parts.entries()) {
					terminal.input?.(part);
					await nextTick();
					if (index < scenario.parts.length - 1) {
						assert.equal(component.renders, renders, "partial reply must not recover visibility");
						assert.deepEqual(inputs, []);
					}
				}
				if (query && !scenario.expired) {
					// These inputs leave the query outstanding; the actual reply must still work.
					if (scenario.kind === "partial OSC prefix diverges" || scenario.kind === "modified F3 during query") {
						terminal.input?.(osc11Reply);
					}
					assert.deepEqual(await query, { r: 255, g: 0, b: 0 });
				}
				const recovered = scenario.delivered && !("recovers" in scenario && !scenario.recovers) ? 1 : 0;
				assert.equal(component.renders - renders, recovered);
				assert.equal(tui.fullRedraws - full, recovered);
				assert.deepEqual(visibility, recovered ? [false, true] : [false]);
				// A rejected buffered prefix and its continuation retain their arrival chunks.
				const deliveredInputs =
					scenario.kind === "partial OSC prefix diverges"
						? scenario.parts
						: scenario.delivered
							? [scenario.delivered]
							: [];
				assert.deepEqual(inputs, deliveredInputs);
				assert.deepEqual(component.inputs, deliveredInputs);
				assert.equal(inputs.join(""), scenario.delivered);
				assert.equal(timers.size, 0, "no hidden frame timer or delayed recovery");
				if (!recovered) assert.equal(terminal.writes.length, writes);
				t.diagnostic(
					`OSC11 ${Renderer.name} ${scenario.kind}: ${recovered} renders, ${recovered} full redraws, 0 timers`,
				);
			} finally {
				tui.stop();
			}
		});
	}

	// smarty-dev#7648: a report split across reads is carried while hidden and never recovers.
	for (const [kind, report] of [
		["color scheme", "\x1b[?997;2n"],
		["cell size", "\x1b[6;20;10t"],
	] as const) {
		it(`${Renderer.name} hidden ${kind} split at every byte never recovers`, async (t) => {
			t.mock.method(performance, "now", () => 0);
			t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const timers = trackTimers(t);
			for (let split = 1; split < report.length; split++) {
				const terminal = new InputTerminal();
				const tui = new Renderer(terminal);
				const component = new CountingComponent();
				const inputs: string[] = [];
				const visibility: boolean[] = [];
				tui.addChild(component);
				tui.setFocus(component);
				tui.addInputListener((data) => {
					inputs.push(data);
					return undefined;
				});
				tui.onVisibilityChange((visible) => visibility.push(visible));
				tui.start();
				tui.renderNow();
				await nextTick();
				try {
					terminal.input?.("\x1b[O");
					await nextTick();
					visibility.length = 0;
					const renders = component.renders;
					const full = tui.fullRedraws;
					const writes = terminal.writes.length;
					terminal.input?.(report.slice(0, split));
					await nextTick();
					assert.deepEqual(inputs, [], `split ${split}: the fragment is held`);
					terminal.input?.(report.slice(split));
					await nextTick();
					assert.equal(component.renders, renders, `split ${split}: no render`);
					assert.equal(tui.fullRedraws, full, `split ${split}: no full redraw`);
					assert.equal(terminal.writes.length, writes, `split ${split}: no write`);
					assert.deepEqual(visibility, [], `split ${split}: stays hidden`);
					assert.deepEqual(inputs, [report], `split ${split}: delivered once, whole`);
					assert.deepEqual(component.inputs, [report]);
					assert.equal(timers.size, 0, `split ${split}: no timer`);
				} finally {
					tui.stop();
				}
			}
		});
	}

	// pi#177 review: the carry is bounded; digits past the report grammar are released as input.
	it(`${Renderer.name} hidden cell-size prefix then typed digits releases them once the limit passes`, async (t) => {
		t.mock.method(performance, "now", () => 0);
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const timers = trackTimers(t);
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const component = new CountingComponent();
		const inputs: string[] = [];
		const visibility: boolean[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			inputs.push(data);
			return undefined;
		});
		tui.onVisibilityChange((visible) => visibility.push(visible));
		tui.start();
		tui.renderNow();
		await nextTick();
		try {
			terminal.input?.("\x1b[O");
			await nextTick();
			visibility.length = 0;
			terminal.input?.("\x1b[6;");
			for (const digit of "12345") {
				terminal.input?.(digit);
				await nextTick();
			}
			assert.deepEqual(inputs, [], "five digits still fit the cell-size grammar");
			terminal.input?.("6");
			await nextTick();
			assert.deepEqual(inputs, ["\x1b[6;123456"], "the sixth digit releases everything, once, in order");
			assert.deepEqual(visibility, [true]);
			assert.equal(timers.size, 0);
		} finally {
			tui.stop();
		}
	});

	it(`${Renderer.name} hidden split reports update scheme and cell dimensions without recovering`, async (t) => {
		t.mock.method(performance, "now", () => 0);
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const timers = trackTimers(t);
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const component = new CountingComponent();
		const schemes: string[] = [];
		const visibility: boolean[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.onTerminalColorSchemeChange((scheme) => schemes.push(scheme));
		tui.onVisibilityChange((visible) => visibility.push(visible));
		tui.start();
		tui.renderNow();
		await nextTick();
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		try {
			terminal.input?.("\x1b[O");
			await nextTick();
			visibility.length = 0;
			const renders = component.renders;
			terminal.input?.("\x1b[?99");
			terminal.input?.("7;2n");
			await nextTick();
			assert.deepEqual(schemes, ["light"]);
			terminal.input?.("\x1b[6;2");
			terminal.input?.("0;10t");
			await nextTick();
			assert.deepEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });
			assert.equal(component.renders, renders);
			assert.deepEqual(visibility, []);
			assert.equal(timers.size, 0);
		} finally {
			tui.stop();
		}
	});

	it(`${Renderer.name} hidden shared ESC: pending OSC 11 prefix then a cell-size report does not recover`, async (t) => {
		t.mock.method(performance, "now", () => 0);
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const timers = trackTimers(t);
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const component = new CountingComponent();
		const inputs: string[] = [];
		const visibility: boolean[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			inputs.push(data);
			return undefined;
		});
		tui.onVisibilityChange((visible) => visibility.push(visible));
		tui.start();
		tui.renderNow();
		await nextTick();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			terminal.input?.("\x1b[O");
			await nextTick();
			visibility.length = 0;
			const renders = component.renders;
			// The ESC is held as a possible OSC 11 reply; it turns out to start a cell-size report.
			terminal.input?.("\x1b");
			await nextTick();
			terminal.input?.("[6;20;10t");
			await nextTick();
			assert.deepEqual(inputs, ["\x1b[6;20;10t"], "the report arrives whole");
			assert.equal(component.renders, renders);
			assert.deepEqual(visibility, []);
			assert.equal(timers.size, 0);
			// The OSC 11 query is still outstanding and its real reply still works.
			terminal.input?.("\x1b]11;rgb:ffff/0000/0000\x07");
			assert.deepEqual(await query, { r: 255, g: 0, b: 0 });
		} finally {
			tui.stop();
		}
	});

	it(`${Renderer.name} hidden key sharing a report prefix arrives whole and recovers once`, async (t) => {
		t.mock.method(performance, "now", () => 0);
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const timers = trackTimers(t);
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const component = new CountingComponent();
		const inputs: string[] = [];
		const visibility: boolean[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			inputs.push(data);
			return undefined;
		});
		tui.onVisibilityChange((visible) => visibility.push(visible));
		tui.start();
		tui.renderNow();
		await nextTick();
		try {
			terminal.input?.("\x1b[O");
			await nextTick();
			visibility.length = 0;
			const renders = component.renders;
			// Ctrl+PageDown (CSI 6;5~) shares the cell-size prefix CSI 6; until its "5~".
			terminal.input?.("\x1b[6;");
			await nextTick();
			assert.deepEqual(inputs, []);
			assert.equal(component.renders, renders);
			terminal.input?.("5~");
			await nextTick();
			assert.deepEqual(inputs, ["\x1b[6;5~"]);
			assert.deepEqual(component.inputs, ["\x1b[6;5~"]);
			assert.deepEqual(visibility, [true]);
			assert.equal(component.renders - renders, 1);
			assert.equal(timers.size, 0);
		} finally {
			tui.stop();
		}
	});

	it(`${Renderer.name} visible modified F3 reaches listeners and components`, async () => {
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const component = new CountingComponent();
		const inputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			inputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			terminal.input?.("\x1b[1;5R");
			await nextTick();
			assert.deepEqual(inputs, ["\x1b[1;5R"]);
			assert.deepEqual(component.inputs, inputs);
		} finally {
			tui.stop();
		}
	});

	it(`${Renderer.name} preserves OSC 11 bytes in fragmented paste while a query is pending`, async () => {
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const component = new CountingComponent();
		const inputs: string[] = [];
		const buffer = new StdinBuffer();
		buffer.on("data", (data) => terminal.input?.(data));
		buffer.on("paste", (content) => terminal.input?.(`\x1b[200~${content}\x1b[201~`));
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			inputs.push(data);
			return undefined;
		});
		tui.start();
		tui.renderNow();
		await nextTick();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			terminal.input?.("\x1b[O");
			const renders = component.renders;
			const paste = `\x1b[200~literal ${osc11Reply} and \x1b]11;unfinished\x1b[201~`;
			buffer.process("\x1b[200~literal \x1b]11;");
			buffer.process("rgb:ffff/0000/0000\x07 and \x1b]11;unfinished\x1b[201~");
			await nextTick();
			assert.equal(component.renders, renders + 1);
			assert.deepEqual(inputs, [paste]);
			assert.deepEqual(component.inputs, [paste]);
			terminal.input?.("\x1b[O");
			terminal.input?.(osc11Reply);
			assert.deepEqual(await query, { r: 255, g: 0, b: 0 });
			await nextTick();
			assert.equal(component.renders, renders + 1, "paste must not consume the pending query");
			assert.deepEqual(inputs, [paste]);
		} finally {
			buffer.destroy();
			tui.stop();
		}
	});
}

// smarty-dev#7403 round 5: partial input cannot cause hidden timer-driven recovery.
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	for (const [kind, input] of [
		["key", "k"],
		["Unicode key", "\u{1f642}"],
		["mouse", "\x1b[<35;1;1M"],
		["paste", "\x1b[200~literal\x1b]11;#fff\x07\x1b[201~"],
		["release", "\x1b[97;1:3u"],
		["unknown", "\x1b[999z"],
	] as const) {
		it(`${Renderer.name} hidden buffered OSC 11 waits for a real ${kind}`, async (t) => {
			t.mock.method(performance, "now", () => 0);
			t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const timers = trackTimers(t);
			const terminal = new InputTerminal();
			const tui = new Renderer(terminal);
			const component = new CountingComponent();
			const inputs: string[] = [];
			const visibility: boolean[] = [];
			tui.addChild(component);
			tui.addInputListener((data) => {
				inputs.push(data);
				return { consume: true };
			});
			tui.onVisibilityChange((visible) => visibility.push(visible));
			tui.start();
			tui.renderNow();
			await nextTick();
			visibility.length = 0;
			try {
				let settled = false;
				const query = tui.queryTerminalBackgroundColor({ timeoutMs: 10 }).then((rgb) => {
					settled = true;
					return rgb;
				});
				const partial = "\x1b]11;rgb:ffff/";
				terminal.input?.(partial);
				assert.equal(timers.size, 1);
				terminal.input?.("\x1b[O");
				assert.equal(timers.size, 0, "hide preserves the buffer but cancels its timeout");
				const renders = component.renders;
				const writes = terminal.writes.length;
				t.mock.timers.tick(2000);
				await nextTick();
				assert.equal(settled, false);
				assert.deepEqual(visibility, [false]);
				assert.equal(component.renders, renders);
				assert.equal(terminal.writes.length, writes);
				assert.deepEqual(inputs, []);
				assert.equal(timers.size, 0);
				terminal.input?.(input);
				await nextTick();
				// Fullscreen's built-in viewport listener owns SGR mouse input.
				assert.deepEqual(inputs, kind === "mouse" && Renderer === TuiAltScreen ? [partial] : [partial, input]);
				assert.deepEqual(visibility, [false, true]);
				assert.equal(component.renders, renders + 1);
				assert.equal(timers.size, 1, "only the resumed visible query timeout");
				terminal.input?.(osc11Reply);
				assert.deepEqual(await query, { r: 255, g: 0, b: 0 });
				assert.equal(timers.size, 0);
				t.diagnostic(
					`OSC11 partial ${Renderer.name} ${kind}: hidden 0 renders/timers; recovery 1 frame; bytes in order`,
				);
			} finally {
				tui.stop();
			}
		});
	}

	it(`${Renderer.name} focus-in re-arms a retained partial query timeout only while visible`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const timers = trackTimers(t);
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const inputs: string[] = [];
		tui.addInputListener((data) => {
			inputs.push(data);
			return { consume: true };
		});
		tui.start();
		await nextTick();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 10 });
			const partial = "\x1b]11;rgb:ffff/";
			terminal.input?.(partial);
			terminal.input?.("\x1b[O");
			assert.equal(timers.size, 0);
			t.mock.timers.tick(2000);
			terminal.input?.("\x1b[I");
			await nextTick();
			assert.deepEqual(inputs, [], "focus-in itself must not dispatch partial protocol bytes");
			assert.equal(timers.size, 1);
			tui.stop({ preserveScreen: true });
			assert.equal(timers.size, 0, "stop cancels a resumed query timer");
			tui.start();
			await nextTick();
			assert.equal(timers.size, 1, "visible restart resumes the retained timeout");
			t.mock.timers.tick(9);
			assert.deepEqual(inputs, []);
			t.mock.timers.tick(1);
			assert.equal(await query, undefined);
			assert.deepEqual(inputs, [partial]);
			assert.equal(timers.size, 0);
		} finally {
			tui.stop();
		}
	});

	it(`${Renderer.name} resumes multiple hidden OSC 11 query timeouts independently`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const timers = trackTimers(t);
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		tui.start();
		await nextTick();
		try {
			terminal.input?.("\x1b[O");
			const first = tui.queryTerminalBackgroundColor({ timeoutMs: 10 });
			const second = tui.queryTerminalBackgroundColor({ timeoutMs: 20 });
			assert.equal(timers.size, 0);
			t.mock.timers.tick(2000);
			terminal.input?.("\x1b[I");
			await nextTick();
			assert.equal(timers.size, 2);
			t.mock.timers.tick(10);
			assert.equal(await first, undefined);
			assert.equal(timers.size, 1);
			terminal.input?.(osc11Reply);
			assert.deepEqual(await second, { r: 255, g: 0, b: 0 });
			assert.equal(timers.size, 0);
		} finally {
			tui.stop();
		}
	});

	it(`${Renderer.name} hidden-created OSC 11 queries use no timers and consume replies silently`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const timers = trackTimers(t);
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const component = new CountingComponent();
		tui.addChild(component);
		tui.start();
		await nextTick();
		try {
			terminal.input?.("\x1b[O");
			const first = tui.queryTerminalBackgroundColor({ timeoutMs: 10 });
			const second = tui.queryTerminalBackgroundColor({ timeoutMs: 20 });
			assert.equal(timers.size, 0);
			const renders = component.renders;
			const writes = terminal.writes.length;
			t.mock.timers.tick(2000);
			terminal.input?.("\x1b]11;rgb:ffff/ffff/");
			terminal.input?.(`ffff\x07${osc11Reply}`);
			assert.deepEqual(await first, { r: 255, g: 255, b: 255 });
			assert.deepEqual(await second, { r: 255, g: 0, b: 0 });
			await nextTick();
			assert.equal(component.renders, renders);
			assert.equal(terminal.writes.length, writes);
			assert.equal(timers.size, 0);
		} finally {
			tui.stop();
		}
	});
}

// smarty-dev#7403 round 6: the first byte outside the reply grammar flushes all input,
// even a multi-character read, with no hidden timeout or key-classification heuristic.
// smarty-dev#7403 round 7: each xterm RGB channel allows only 1-4 hex digits.
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	for (const [kind, partial, continuation] of [
		["multi-character printable read", "\x1b]11;r", "abc"],
		["lone ESC", "\x1b]11;rgb:ffff/", "\x1b"],
		["arrow", "\x1b]11;rgb:ffff/", "\x1b[A"],
		["valid digits followed by an invalid byte", "\x1b]11;rgb:ffff/", "00gabc"],
		["invalid ST continuation", "\x1b]11;rgb:ffff/0000/0000\x1b", "abc"],
		["fifth hex digit in one read", "\x1b]11;rgb:", "fffffabc"],
		["fifth hex digit in first channel", "\x1b]11;rgb:ffff", "fabc"],
		["fifth hex digit in second channel", "\x1b]11;rgb:ffff/0000", "ABC"],
		["fifth hex digit in third channel", "\x1b]11;rgb:ffff/0000/ffff", "abc"],
		["invalid read containing a reply", "\x1b]11;r", `abc${osc11Reply}`],
		["empty channel", "\x1b]11;rgb:", "/abc"],
		["extra separator", "\x1b]11;rgb:ffff/0000/0000", "/abc"],
	] as const) {
		it(`${Renderer.name} hidden OSC 11 grammar rejects ${kind} in order`, async (t) => {
			t.mock.method(performance, "now", () => 0);
			t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const timers = trackTimers(t);
			const terminal = new InputTerminal();
			const tui = new Renderer(terminal);
			const component = new CountingComponent();
			const inputs: string[] = [];
			const visibility: boolean[] = [];
			tui.addChild(component);
			tui.setFocus(component);
			tui.addInputListener((data) => {
				inputs.push(data);
				return undefined;
			});
			tui.onVisibilityChange((visible) => visibility.push(visible));
			tui.start();
			tui.renderNow();
			await nextTick();
			visibility.length = 0;
			try {
				let settled = false;
				const query = tui.queryTerminalBackgroundColor({ timeoutMs: 10 }).then((rgb) => {
					settled = true;
					return rgb;
				});
				terminal.input?.("\x1b[O");
				const renders = component.renders;
				const full = tui.fullRedraws;
				const writes = terminal.writes.length;
				terminal.input?.(partial);
				await nextTick();
				assert.deepEqual(inputs, []);
				assert.deepEqual(visibility, [false]);
				assert.equal(timers.size, 0);
				t.mock.timers.tick(2000);
				await nextTick();
				assert.equal(settled, false);
				assert.equal(component.renders, renders);
				assert.equal(terminal.writes.length, writes);
				terminal.input?.(continuation);
				await nextTick();
				assert.deepEqual(inputs, [partial, continuation]);
				assert.equal(inputs.join(""), partial + continuation);
				assert.deepEqual(component.inputs, inputs);
				assert.deepEqual(visibility, [false, true]);
				assert.equal(component.renders, renders + 1);
				assert.equal(tui.fullRedraws, full + 1);
				assert.equal(settled, false, "ordinary bytes must not consume the outstanding query");
				assert.equal(timers.size, 1, "only the now-visible query timeout resumes");
				terminal.input?.(osc11Reply);
				assert.deepEqual(await query, { r: 255, g: 0, b: 0 });
				assert.equal(timers.size, 0);
				t.diagnostic(
					`OSC11 grammar ${Renderer.name} ${kind}: hidden 0 renders/timers; recovery 1 full frame; ordered bytes`,
				);
			} finally {
				tui.stop();
			}
		});
	}

	for (const [kind, parts] of [
		["split before BEL", ["\x1b]11;rgb:ffff/0000/0000", "\x07"]],
		["split ST", ["\x1b]11;rgb:ffff/0000/0000\x1b", "\\"]],
		["separate ST bytes", ["\x1b]11;rgb:ffff/0000/0000", "\x1b", "\\"]],
		["bytewise BEL", Array.from(osc11Reply)],
		["bytewise ST", Array.from("\x1b]11;rgb:ffff/0000/0000\x1b\\")],
		["one-digit channels BEL", ["\x1b]11;rgb:f/0/0", "\x07"]],
		["one-digit channels ST", ["\x1b]11;rgb:f/0/0", "\x1b", "\\"]],
		["two-digit channels", ["\x1b]11;rgb:ff/00/00", "\x07"]],
		["three-digit channels", ["\x1b]11;rgb:fff/000/000", "\x07"]],
	] as const) {
		it(`${Renderer.name} hidden OSC 11 grammar consumes ${kind} without recovery`, async (t) => {
			t.mock.method(performance, "now", () => 0);
			t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const timers = trackTimers(t);
			const terminal = new InputTerminal();
			const tui = new Renderer(terminal);
			const component = new CountingComponent();
			const inputs: string[] = [];
			tui.addChild(component);
			tui.setFocus(component);
			tui.addInputListener((data) => {
				inputs.push(data);
				return undefined;
			});
			tui.start();
			tui.renderNow();
			await nextTick();
			try {
				terminal.input?.("\x1b[O");
				const query = tui.queryTerminalBackgroundColor({ timeoutMs: 10 });
				const renders = component.renders;
				const full = tui.fullRedraws;
				const writes = terminal.writes.length;
				for (const part of parts) {
					terminal.input?.(part);
					await nextTick();
					assert.equal(timers.size, 0);
					assert.equal(component.renders, renders);
					assert.equal(tui.fullRedraws, full);
					assert.equal(terminal.writes.length, writes);
					assert.deepEqual(inputs, []);
					assert.deepEqual(component.inputs, []);
				}
				assert.deepEqual(await query, { r: 255, g: 0, b: 0 });
				t.mock.timers.tick(2000);
				await nextTick();
				assert.equal(component.renders, renders);
				assert.equal(timers.size, 0);
				t.diagnostic(`OSC11 grammar ${Renderer.name} ${kind}: reply consumed; hidden 0 renders/timers`);
			} finally {
				tui.stop();
			}
		});
	}
}

// smarty-dev#7403 round 2: recovery does not require the missing CSI I or a frame timer.
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	for (const [kind, data] of [
		["keypress", "k"],
		["mouse", "\x1b[<35;1;1M"],
		["paste", "\x1b[200~pasted\x1b[201~"],
		["key release", "\x1b[97;1:3u"],
		["unknown bytes", "\x1b[999z"],
	] as const) {
		it(`${Renderer.name} lost CSI I + streaming + ${kind} draws latest state once`, async (t) => {
			t.mock.method(performance, "now", () => 0);
			t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const timers = trackTimers(t);
			const terminal = new InputTerminal();
			const tui = new Renderer(terminal);
			const component = new CountingComponent();
			tui.addChild(component);
			// Recovery must precede even a listener that consumes all input.
			tui.addInputListener(() => ({ consume: true }));
			tui.start();
			tui.renderNow();
			await nextTick();
			try {
				terminal.input?.("\x1b[O");
				const renders = component.renders;
				const full = tui.fullRedraws;
				for (let token = 0; token < 200; token++) {
					component.text = `token ${token}`;
					tui.requestRender();
					await nextTick();
					t.mock.timers.tick(10);
				}
				assert.equal(component.renders, renders);
				assert.equal(timers.size, 0);
				terminal.input?.(data);
				await nextTick();
				assert.equal(component.renders, renders + 1);
				assert.equal(tui.fullRedraws, full + 1);
				assert.equal(component.lastRendered, "token 199");
				assert.ok(terminal.writes.at(-1)?.includes("token 199"));
				assert.equal(timers.size, 0, "recovery must not wait for a timer");
				t.diagnostic(
					`lost-focus ${Renderer.name} ${kind}: hidden 0 renders/2000ms, 0 timers; recovery 1 full render, token 199`,
				);
			} finally {
				tui.stop();
			}
		});
	}

	it(`${Renderer.name} hidden resize requests fresh focus and draws latest state once`, async (t) => {
		t.mock.method(performance, "now", () => 0);
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const timers = trackTimers(t);
		const terminal = new InputTerminal();
		const tui = new Renderer(terminal);
		const component = new CountingComponent();
		tui.addChild(component);
		tui.start();
		tui.renderNow();
		await nextTick();
		try {
			terminal.input?.("\x1b[O");
			component.text = "latest on attach";
			tui.requestRender();
			await nextTick();
			const renders = component.renders;
			const full = tui.fullRedraws;
			const focusRequests = terminal.writes.filter((write) => write === "\x1b[?1004h").length;
			terminal.resize?.();
			terminal.resize?.(); // duplicate stdout resize/SIGWINCH callbacks coalesce
			await nextTick();
			assert.equal(terminal.writes.filter((write) => write === "\x1b[?1004h").length, focusRequests + 2);
			assert.equal(component.renders, renders + 1);
			assert.equal(tui.fullRedraws, full + 1);
			assert.equal(component.lastRendered, "latest on attach");
			assert.equal(timers.size, 0);
			terminal.input?.("\x1b[I"); // current-state report does not cause a second draw
			await nextTick();
			assert.equal(component.renders, renders + 1);
			// A fresh hidden report still cancels the pending recovery frame.
			terminal.resize?.();
			terminal.input?.("\x1b[O");
			await nextTick();
			assert.equal(component.renders, renders + 1);
			assert.equal(timers.size, 0);
			component.text = "latest from report";
			tui.requestRender();
			terminal.input?.("\x1b[I");
			await nextTick();
			assert.equal(component.renders, renders + 2);
			assert.equal(component.lastRendered, "latest from report");
			t.diagnostic(
				`resize ${Renderer.name}: 1 full render, latest on attach; duplicate focus-in 0 renders; fresh focus-out 0 renders`,
			);
		} finally {
			tui.stop();
		}
	});
}
