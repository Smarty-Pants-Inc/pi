import { performance } from "node:perf_hooks";
import { type Terminal, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";

const nextTick = () => new Promise<void>((resolve) => process.nextTick(resolve));

// pi#175 / smarty-dev#7403: exercise the public request path, not renderNow().
// This lives in coding-agent because its test runner supports vi.useFakeTimers.
describe.each([
	{ name: "regular", Renderer: TuiMainScreen },
	{ name: "fullscreen", Renderer: TuiAltScreen },
])("$name render coalescing", ({ Renderer }) => {
	test("renders the latest trailing state, leads after idle, and preserves requests across stop/start", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let now = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		let state = "initial";
		const component = { render: vi.fn(() => [state]), invalidate: vi.fn() };
		const terminal: Terminal = {
			columns: 80,
			rows: 24,
			kittyProtocolActive: false,
			start: vi.fn(),
			stop: vi.fn(),
			drainInput: async () => {},
			write: vi.fn(),
			moveBy: vi.fn(),
			hideCursor: vi.fn(),
			showCursor: vi.fn(),
			clearLine: vi.fn(),
			clearFromCursor: vi.fn(),
			clearScreen: vi.fn(),
			setTitle: vi.fn(),
			setProgress: vi.fn(),
		};
		const tui = new Renderer(terminal);
		const advance = async (ms: number) => {
			now += ms;
			vi.advanceTimersByTime(ms);
			await nextTick();
		};
		const request = async (text: string) => {
			state = text;
			tui.requestRender();
			await nextTick();
		};
		try {
			tui.addChild(component);
			tui.start();
			await nextTick();
			await advance(0);
			expect(component.render).toHaveBeenCalledTimes(1);

			await advance(10);
			await request("first");
			expect(vi.getTimerCount()).toBe(1);
			await advance(30);
			await request("second");
			await request("third");
			expect(vi.getTimerCount()).toBe(1);
			await advance(59);
			await request("LAST");
			expect(component.render).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(1);
			await advance(1);
			expect(component.render).toHaveBeenCalledTimes(2);
			expect(component.render.mock.results.at(-1)?.value).toEqual(["LAST"]);
			expect(terminal.write).toHaveBeenLastCalledWith(expect.stringContaining("LAST"));
			expect(vi.getTimerCount()).toBe(0);

			await advance(200);
			expect(component.render).toHaveBeenCalledTimes(2);
			await request("leading after idle");
			await advance(0);
			expect(component.render).toHaveBeenCalledTimes(3);
			expect(component.render.mock.results.at(-1)?.value).toEqual(["leading after idle"]);
			expect(vi.getTimerCount()).toBe(0);

			await advance(10);
			await request("pending before stop");
			tui.stop({ preserveScreen: true });
			expect(vi.getTimerCount()).toBe(0);
			await advance(100);
			await request("latest while stopped");
			await advance(0);
			expect(component.render).toHaveBeenCalledTimes(3);
			tui.start();
			await nextTick();
			await advance(0);
			expect(component.render).toHaveBeenCalledTimes(4);
			expect(component.render.mock.results.at(-1)?.value).toEqual(["latest while stopped"]);

			await advance(10);
			await request("pending before quick restart");
			tui.stop({ preserveScreen: true });
			state = "latest at quick restart";
			tui.start();
			await nextTick();
			expect(vi.getTimerCount()).toBe(1);
			await advance(89);
			expect(component.render).toHaveBeenCalledTimes(4);
			await advance(1);
			expect(component.render).toHaveBeenCalledTimes(5);
			expect(component.render.mock.results.at(-1)?.value).toEqual(["latest at quick restart"]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			tui.stop({ preserveScreen: true });
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
	});
});
