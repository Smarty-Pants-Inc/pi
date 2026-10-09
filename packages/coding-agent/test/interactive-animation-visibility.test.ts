import { performance } from "node:perf_hooks";
import { type Component, type Terminal, type TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArminComponent } from "../src/modes/interactive/components/armin.ts";
import { CountdownTimer } from "../src/modes/interactive/components/countdown-timer.ts";
import { DaxnutsComponent } from "../src/modes/interactive/components/daxnuts.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveTuiReference } from "../src/modes/interactive/tui-renderer.ts";

class InputTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	input?: (data: string) => void;
	start(input: (data: string) => void): void {
		this.input = input;
	}
	stop(): void {
		this.input = undefined;
	}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}
const nextTick = () => new Promise<void>((resolve) => process.nextTick(resolve));

// smarty-dev#7403 / #7222: cover the real coding-agent composition, not a visibility stub.
describe("interactive animation visibility", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("working indicators keep rendering after a regular/fullscreen renderer swap", async () => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		initTheme("dark");
		const terminal = new InputTerminal();
		let renderer: TUI = new TuiMainScreen(terminal);
		const ui = createInteractiveTuiReference(() => renderer);
		let frames = 0;
		const counter: Component = {
			render: () => {
				frames++;
				return ["state"];
			},
			invalidate() {},
		};
		const indicator = new WorkingStatusIndicator(ui, "Working");
		renderer.addChild(counter);
		renderer.addChild(indicator);
		renderer.start();
		renderer.renderNow();
		await nextTick();
		renderer.stop({ preserveScreen: true });
		expect(vi.getTimerCount()).toBe(0);
		renderer = new TuiAltScreen(terminal);
		renderer.addChild(counter);
		renderer.addChild(indicator);
		renderer.start();
		await nextTick();
		expect(vi.getTimerCount()).toBe(1);
		const before = frames;
		vi.advanceTimersByTime(100);
		await nextTick();
		vi.advanceTimersByTime(0);
		await nextTick();
		expect(frames).toBe(before + 1);
		terminal.input?.("\x1b[O");
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(2000);
		await nextTick();
		expect(frames).toBe(before + 1);
		terminal.input?.("\x1b[I");
		await nextTick();
		expect(frames).toBe(before + 2);
		indicator.dispose();
		renderer.stop({ preserveScreen: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("pauses cosmetic countdown ticks but preserves the functional deadline while hidden", async () => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		const terminal = new InputTerminal();
		const ui = new TuiMainScreen(terminal);
		ui.start();
		ui.renderNow();
		await nextTick();
		const onTick = vi.fn();
		const onExpire = vi.fn();
		const timer = new CountdownTimer(3000, ui, onTick, onExpire);
		expect(vi.getTimerCount()).toBe(2);
		terminal.input?.("\x1b[O");
		expect(vi.getTimerCount()).toBe(1); // One functional deadline, zero cosmetic intervals.
		vi.advanceTimersByTime(2000);
		await nextTick();
		expect(onTick.mock.calls).toEqual([[3]]);
		vi.advanceTimersByTime(1000);
		await nextTick();
		expect(onTick.mock.calls).toEqual([[3], [0]]);
		expect(onExpire).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		timer.dispose();
		ui.stop();
	});

	it.each([ArminComponent, DaxnutsComponent])("pauses %s animation intervals while hidden", async (Animation) => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		initTheme("dark");
		const terminal = new InputTerminal();
		const ui = new TuiMainScreen(terminal);
		ui.start();
		ui.renderNow();
		await nextTick();
		terminal.input?.("\x1b[O");
		const animation = new Animation(ui);
		ui.addChild(animation);
		expect(vi.getTimerCount()).toBe(0);
		terminal.input?.("\x1b[I");
		await nextTick();
		expect(vi.getTimerCount()).toBe(1);
		terminal.input?.("\x1b[O");
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(2000);
		await nextTick();
		expect(vi.getTimerCount()).toBe(0);
		animation.dispose();
		terminal.input?.("\x1b[I");
		await nextTick();
		expect(vi.getTimerCount()).toBe(0);
		ui.stop();
	});
});
