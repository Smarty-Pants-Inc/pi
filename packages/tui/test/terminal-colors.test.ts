import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type Component,
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type Terminal,
	type TUI,
	TuiMainScreen,
} from "../src/index.ts";

class TestTerminal implements Terminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private readonly columnCount: number;
	private readonly rowCount: number;
	readonly writes: string[] = [];

	constructor(columnCount = 80, rowCount = 24) {
		this.columnCount = columnCount;
		this.rowCount = rowCount;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this.columnCount;
	}

	get rows(): number {
		return this.rowCount;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	sendResize(): void {
		this.resizeHandler?.();
	}
}

class InputRecorder implements Component {
	readonly inputs: string[] = [];
	renders = 0;

	render(_width: number): string[] {
		this.renders++;
		return [];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("parseOsc11BackgroundColor", () => {
	it("parses 16-bit OSC 11 rgb responses", () => {
		assert.deepStrictEqual(parseOsc11BackgroundColor("\x1b]11;rgb:0000/8000/ffff\x07"), {
			r: 0,
			g: 128,
			b: 255,
		});
	});

	it("parses OSC 11 hex responses", () => {
		assert.deepStrictEqual(parseOsc11BackgroundColor("\x1b]11;#ffffff\x1b\\"), { r: 255, g: 255, b: 255 });
		assert.deepStrictEqual(parseOsc11BackgroundColor("\x1b]11;#000000\x07"), { r: 0, g: 0, b: 0 });
	});

	it("rejects non-strict OSC 11 responses", () => {
		assert.strictEqual(parseOsc11BackgroundColor(`x\x1b]11;#ffffff\x07`), undefined);
		assert.strictEqual(parseOsc11BackgroundColor("\x1b]10;#ffffff\x07"), undefined);
		assert.strictEqual(parseOsc11BackgroundColor("\x1b]11;#ffffff\x07x"), undefined);
	});
});

describe("parseTerminalColorSchemeReport", () => {
	it("parses color scheme reports", () => {
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;1n"), "dark");
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;2n"), "light");
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;2n\x1b[?997;1n\x1b[?997;1n"), "dark");
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;1n\x1b[?997;2n\x1b[?997;2n"), "light");
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;3n"), undefined);
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?996n"), undefined);
		assert.strictEqual(parseTerminalColorSchemeReport("x\x1b[?997;1n"), undefined);
	});
});

describe("TUI.queryTerminalBackgroundColor", () => {
	it("writes OSC 11 query and resolves with the parsed RGB reply", async () => {
		const terminal = new TestTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		tui.start();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			assert.ok(terminal.writes.includes("\x1b]11;?\x07"));

			terminal.sendInput("\x1b]11;#ffffff\x07");

			assert.deepStrictEqual(await query, { r: 255, g: 255, b: 255 });
		} finally {
			tui.stop();
		}
	});

	it("consumes OSC 11 replies before input listeners and focused component dispatch", async () => {
		const terminal = new TestTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputRecorder();
		const listenerInputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });

			terminal.sendInput("\x1b]11;#000000\x07");

			assert.deepStrictEqual(await query, { r: 0, g: 0, b: 0 });
			assert.deepStrictEqual(listenerInputs, []);
			assert.deepStrictEqual(component.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("consumes unparseable strict OSC 11 replies and resolves undefined", async () => {
		const terminal = new TestTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputRecorder();
		const listenerInputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });

			terminal.sendInput("\x1b]11;not-a-color\x07");

			assert.strictEqual(await query, undefined);
			assert.deepStrictEqual(listenerInputs, []);
			assert.deepStrictEqual(component.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("dispatches non-matching input normally while waiting for an OSC 11 reply", async () => {
		const terminal = new TestTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputRecorder();
		const listenerInputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			let settled = false;
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 }).then((rgb) => {
				settled = true;
				return rgb;
			});

			terminal.sendInput("x");
			await Promise.resolve();

			assert.strictEqual(settled, false);
			assert.deepStrictEqual(listenerInputs, ["x"]);
			assert.deepStrictEqual(component.inputs, ["x"]);

			terminal.sendInput("\x1b]11;#ffffff\x07");
			assert.deepStrictEqual(await query, { r: 255, g: 255, b: 255 });
		} finally {
			tui.stop();
		}
	});

	// smarty-dev#7403: each outstanding query consumes exactly one reply, in order.
	it("consumes only as many OSC 11 replies as outstanding queries", async () => {
		const terminal = new TestTerminal();
		const tui = new TuiMainScreen(terminal);
		const inputs: string[] = [];
		tui.addInputListener((data) => {
			inputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			const first = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			const second = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			const white = "\x1b]11;#ffffff\x07";
			const black = "\x1b]11;#000000\x07";
			terminal.sendInput(white + black + white);
			assert.deepStrictEqual(await first, { r: 255, g: 255, b: 255 });
			assert.deepStrictEqual(await second, { r: 0, g: 0, b: 0 });
			assert.deepStrictEqual(inputs, [white]);
		} finally {
			tui.stop();
		}
	});

	// smarty-dev#7403: an expired query cannot take a later active query's reply.
	it("removes expired queries before resolving another outstanding query", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const terminal = new TestTerminal();
		const tui = new TuiMainScreen(terminal);
		tui.start();
		try {
			const expired = tui.queryTerminalBackgroundColor({ timeoutMs: 10 });
			const active = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			t.mock.timers.tick(10);
			assert.strictEqual(await expired, undefined);
			terminal.sendInput("\x1b]11;#ffffff\x07");
			assert.deepStrictEqual(await active, { r: 255, g: 255, b: 255 });
		} finally {
			tui.stop();
		}
	});

	// smarty-dev#7403 round 5: a timeout must never recover a hidden pane.
	it("keeps a partial OSC 11 timer-free while hidden until a key recovers it", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const scheduled = t.mock.method(globalThis, "setTimeout");
		const cancelled = t.mock.method(globalThis, "clearTimeout");
		const terminal = new TestTerminal();
		const tui = new TuiMainScreen(terminal);
		const inputs: string[] = [];
		const visibility: boolean[] = [];
		const component = new InputRecorder();
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			inputs.push(data);
			return undefined;
		});
		tui.onVisibilityChange((visible) => visibility.push(visible));
		tui.start();
		tui.renderNow();
		await new Promise<void>((resolve) => process.nextTick(resolve));
		try {
			let settled = false;
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 10 }).then((rgb) => {
				settled = true;
				return rgb;
			});
			terminal.sendInput("\x1b[O");
			const partial = "\x1b]11;rgb:ffff/";
			terminal.sendInput(partial);
			assert.deepStrictEqual(inputs, []);
			assert.strictEqual(visibility.at(-1), false);
			const renders = component.renders;
			const writes = terminal.writes.length;
			t.mock.timers.tick(1000);
			await new Promise<void>((resolve) => process.nextTick(resolve));
			assert.strictEqual(settled, false);
			assert.strictEqual(visibility.at(-1), false);
			assert.strictEqual(component.renders, renders);
			assert.strictEqual(terminal.writes.length, writes);
			assert.strictEqual(scheduled.mock.calls.length - cancelled.mock.calls.length, 0, "no active timeout");
			assert.deepStrictEqual(inputs, []);
			terminal.sendInput("k");
			await new Promise<void>((resolve) => process.nextTick(resolve));
			assert.strictEqual(visibility.at(-1), true);
			assert.strictEqual(component.renders, renders + 1);
			assert.deepStrictEqual(inputs, [partial, "k"]);
			assert.deepStrictEqual(component.inputs, inputs);
			terminal.sendInput("\x1b]11;#ffffff\x07");
			assert.deepStrictEqual(await query, { r: 255, g: 255, b: 255 });
		} finally {
			tui.stop();
		}
	});

	// smarty-dev#7403: a timed-out query is no longer waiting for a reply.
	it("dispatches a late OSC 11 reply after timeout", async () => {
		const terminal = new TestTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputRecorder();
		const listenerInputs: string[] = [];
		tui.addChild(component);
		tui.setFocus(component);
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.start();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1 });
			await wait(5);

			assert.strictEqual(await query, undefined);

			const reply = "\x1b]11;#ffffff\x07";
			terminal.sendInput(reply);

			assert.deepStrictEqual(listenerInputs, [reply]);
			assert.deepStrictEqual(component.inputs, [reply]);
		} finally {
			tui.stop();
		}
	});
});
