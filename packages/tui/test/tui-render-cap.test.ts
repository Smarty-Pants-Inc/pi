import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, it, type TestContext } from "node:test";
import { Loader } from "../src/components/loader.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import type { Terminal } from "../src/terminal.ts";
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
