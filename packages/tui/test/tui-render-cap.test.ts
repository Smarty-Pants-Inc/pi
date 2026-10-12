import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { it } from "node:test";
import { Loader } from "../src/components/loader.ts";
import { Text } from "../src/components/text.ts";
import type { Terminal } from "../src/terminal.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";

const nextTick = () => new Promise<void>((resolve) => process.nextTick(resolve));
const identity = (s: string) => s;
const noop = () => {};
// smarty-dev#7403: count actual component renders, without unrelated xterm timers in the fake clock.
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	it(`${Renderer.name}: 100 Hz stream, immediate input/force, and 10 fps spinner`, async (t) => {
		let now = 0;
		t.mock.method(performance, "now", () => now);
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		let input = noop as (data: string) => void;
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
			moveBy: noop,
			hideCursor: noop,
			showCursor: noop,
			clearLine: noop,
			clearFromCursor: noop,
			clearScreen: noop,
			setTitle: noop,
			setProgress: noop,
		};
		const tick = async () => {
			now += 10;
			t.mock.timers.tick(10);
			await nextTick();
		};
		const tui = new Renderer(terminal);
		const text = new Text("initial", 0, 0);
		const renders = t.mock.method(text, "render");
		t.after(() => tui.stop());
		tui.addChild(text);
		tui.start();
		tui.renderNow();
		for (let token = 0; token < 200; token++) {
			text.setText(`token ${token}`);
			tui.requestRender();
			await nextTick();
			await tick();
		}
		const streamFrames = renders.mock.calls.length;
		assert.ok(streamFrames >= 20 && streamFrames <= 21, `${streamFrames} stream frames`);
		tui.addInputListener(() => ({ consume: true }));
		tui.requestRender();
		input("k");
		await nextTick();
		assert.equal(renders.mock.calls.length, streamFrames + 1, "consumed key renders before timer tick");
		tui.requestRender(true);
		await nextTick();
		assert.equal(renders.mock.calls.length, streamFrames + 2, "force bypasses cap");
		const intervals = t.mock.method(globalThis, "setInterval");
		const loader = new Loader(tui, identity, identity, "Working", { frames: ["-", "+"], intervalMs: 1 });
		t.after(() => loader.stop());
		assert.equal(intervals.mock.calls.at(-1)?.arguments[1], 100);
		const before = renders.mock.calls.length;
		for (let frame = 0; frame < 200; frame++) await tick();
		const frames = renders.mock.calls.length - before;
		assert.ok(frames >= 19 && frames <= 20, `${frames} spinner frames`);
		t.diagnostic(`${Renderer.name}: stream=${streamFrames} (including initial), spinner=${frames} renders/2000ms`);
	});
}
