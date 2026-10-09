import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { it } from "node:test";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const nextTick = () => new Promise<void>((resolve) => process.nextTick(resolve));

// pi#175 / smarty-dev#7403: stopping the terminal itself must release, then replace, its frame waiter.
it("VirtualTerminal.stop clears pending render state and releases existing waiters", async () => {
	const terminal = new VirtualTerminal();
	terminal.onRenderPending(true);
	let oldResolved = false;
	const oldWaiter = terminal.waitForRender().then(() => {
		oldResolved = true;
	});
	await terminal.flush();
	assert.equal(oldResolved, false);
	terminal.stop();
	await oldWaiter;
	assert.equal(oldResolved, true);
	await terminal.waitForRender();

	terminal.start(
		() => {},
		() => {},
	);
	terminal.onRenderPending(true);
	let newResolved = false;
	const newWaiter = terminal.waitForRender().then(() => {
		newResolved = true;
	});
	await terminal.flush();
	assert.equal(newResolved, false, "restart must create a fresh pending promise");
	terminal.onRenderPending(false);
	await newWaiter;
	assert.equal(newResolved, true);
	terminal.stop();
});

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	// pi#175 / smarty-dev#7403: exercise requestRender and the real VirtualTerminal frame waiter.
	it(`${Renderer.name}: stop with a pending frame, restart and render the latest state`, async (t) => {
		let now = 1000;
		t.mock.method(performance, "now", () => now);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const terminal = new VirtualTerminal(20, 4);
		let state = "initial";
		const component = { render: () => [state], invalidate: () => {} };
		const renders = t.mock.method(component, "render");
		const pending = t.mock.method(terminal, "onRenderPending");
		const tui = new Renderer(terminal);
		const advance = async (ms: number) => {
			now += ms;
			t.mock.timers.tick(ms);
			await nextTick();
		};
		const flush = async () => {
			const flushed = terminal.waitForRender();
			await nextTick();
			t.mock.timers.tick(0);
			await flushed;
		};
		try {
			tui.addChild(component);
			tui.start();
			await nextTick();
			await advance(0);
			await flush();
			assert.equal(renders.mock.calls.length, 1);
			assert.ok(terminal.getViewport().includes("initial"));
			await advance(5);
			state = "pending";
			tui.requestRender();
			await nextTick();
			assert.equal(pending.mock.calls.at(-1)?.arguments[0], true);
			tui.stop({ preserveScreen: true });
			assert.equal(pending.mock.calls.at(-1)?.arguments[0], false);
			await flush();
			await advance(80);
			assert.equal(renders.mock.calls.length, 1, "stopped TUI must not render");

			state = "restarted";
			tui.start();
			tui.requestRender();
			await nextTick();
			assert.equal(pending.mock.calls.at(-1)?.arguments[0], true);
			let resolved = false;
			const waiter = terminal.waitForRender().then(() => {
				resolved = true;
			});
			await advance(14);
			assert.equal(renders.mock.calls.length, 1);
			assert.equal(resolved, false);
			await advance(1);
			await nextTick();
			t.mock.timers.tick(0);
			await waiter;
			assert.equal(resolved, true);
			assert.equal(renders.mock.calls.length, 2);
			assert.ok(terminal.getViewport().includes("restarted"));
			await advance(100);
			assert.equal(renders.mock.calls.length, 2, "no canceled frame may leak into the next run");
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});
}
