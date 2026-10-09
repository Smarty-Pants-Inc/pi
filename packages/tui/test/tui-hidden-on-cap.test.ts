import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { it } from "node:test";
import type { Terminal } from "../src/terminal.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";

const nextTick = () => new Promise<void>((resolve) => process.nextTick(resolve));
const noop = () => {};

// smarty-dev#7403: hiding/showing must not replace the installed cap's trailing-frame scheduler.
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	it(`${Renderer.name} preserves a capped trailing request made during the recovery frame`, async (t) => {
		let now = 0;
		t.mock.method(performance, "now", () => now);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let input = noop as (data: string) => void;
		const pending: boolean[] = [];
		const terminal: Terminal = {
			columns: 80,
			rows: 24,
			kittyProtocolActive: false,
			start(onInput) {
				input = onInput;
			},
			stop: noop,
			drainInput: async () => {},
			write: noop,
			onRenderPending(value) {
				pending.push(value);
			},
			moveBy: noop,
			hideCursor: noop,
			showCursor: noop,
			clearLine: noop,
			clearFromCursor: noop,
			clearScreen: noop,
			setTitle: noop,
			setProgress: noop,
		};
		const tui = new Renderer(terminal);
		let renders = 0;
		let text = "initial";
		let latest = "";
		tui.addChild({
			render() {
				renders++;
				latest = text;
				if (renders === 2) {
					text = "trailing";
					tui.requestRender();
				}
				return [latest];
			},
			invalidate: noop,
		});
		t.after(() => tui.stop({ preserveScreen: true }));
		tui.start();
		tui.renderNow();
		await nextTick();
		input("\x1b[O");
		text = "hidden update";
		tui.requestRender();
		await nextTick();
		assert.equal(renders, 1);
		assert.equal(pending.at(-1), false);
		input("\x1b[I");
		await nextTick();
		assert.equal(renders, 2, "show immediately draws exactly one recovery frame");
		assert.equal(latest, "hidden update");
		assert.equal(pending.at(-1), true, "a request during recovery keeps the trailing frame pending");
		now = 99;
		t.mock.timers.tick(99);
		await nextTick();
		assert.equal(renders, 2, "trailing work may not bypass the installed 100 ms cap");
		now = 100;
		t.mock.timers.tick(1);
		await nextTick();
		assert.equal(renders, 3);
		assert.equal(latest, "trailing");
		assert.equal(pending.at(-1), false);
		now = 2100;
		t.mock.timers.tick(2000);
		await nextTick();
		assert.equal(renders, 3, "idle retains no trailing redraw");
	});
}
