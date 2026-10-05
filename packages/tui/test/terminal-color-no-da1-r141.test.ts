import assert from "node:assert/strict";
import { it } from "node:test";
import type { Terminal } from "../src/terminal.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";

class ColorTerminal implements Terminal {
	writes: string[] = [];
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	start(_input: (data: string) => void, _resize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DA1 = "\x1b[?62;22c";
function input(tui: TuiMainScreen, data: string): void {
	const probe = tui as unknown as { consumeTerminalColorResponse(data: string): boolean };
	assert.equal(probe.consumeTerminalColorResponse(data), true);
}
function colors(tui: TuiMainScreen, hex: string): void {
	input(tui, `\x1b]10;#${hex}\x07`);
	input(tui, `\x1b]11;#${hex}\x07`);
	for (let index = 0; index < 16; index++) input(tui, `\x1b]4;${index};#${hex}\x07`);
}
async function sent(terminal: ColorTerminal, count: number): Promise<void> {
	for (let attempt = 0; attempt < 100 && terminal.writes.length < count; attempt++) await wait(5);
	assert.equal(terminal.writes.length, count, "queued query must eventually get its own wire request");
}

// PR #141 cut #10: a complete no-DA1 reply batch cannot hold ownership of the next batch forever.
for (const timedOut of [false, true])
	it(`retires no-DA1 ownership after ${timedOut ? "late" : "timely"} colors`, async () => {
		const terminal = new ColorTerminal();
		const tui = new TuiMainScreen(terminal);
		try {
			const first = tui.queryTerminalColors({ timeoutMs: timedOut ? 1 : 300 });
			if (timedOut) {
				await wait(5);
				await first;
			}
			colors(tui, "000000");
			await first;
			const second = tui.queryTerminalColors({ timeoutMs: 300 });
			await sent(terminal, 2);
			colors(tui, "ffffff");
			const result = await second;
			assert.deepEqual(result.background, { r: 255, g: 255, b: 255 });
			assert.deepEqual(
				result.palette,
				Array.from({ length: 16 }, () => ({ r: 255, g: 255, b: 255 })),
			);
		} finally {
			tui.stop();
		}
	});

it("keeps late incomplete replies with the outgoing query while a successor waits to be issued", async () => {
	const terminal = new ColorTerminal();
	const tui = new TuiMainScreen(terminal);
	const late: unknown[] = [];
	try {
		await tui.queryTerminalColors({ timeoutMs: 1, onLateReply: (value) => late.push(value) });
		const second = tui.queryTerminalColors({ timeoutMs: 300 });
		assert.equal(terminal.writes.length, 1, "do not overlap unframed color requests");
		input(tui, "\x1b]11;#000000\x07");
		input(tui, DA1);
		assert.equal(late.length, 1);
		await sent(terminal, 2);
		colors(tui, "ffffff");
		assert.deepEqual((await second).background, { r: 255, g: 255, b: 255 });
	} finally {
		tui.stop();
	}
});

// No request IDs exist on OSC/DA1. Silence after an incomplete batch is not proof of fresh ownership.
it("bounds a successor empty when an incomplete no-DA1 batch cannot be safely retired", async () => {
	const terminal = new ColorTerminal();
	const tui = new TuiMainScreen(terminal);
	try {
		await tui.queryTerminalColors({ timeoutMs: 1 });
		const second = tui.queryTerminalColors({ timeoutMs: 10 });
		input(tui, "\x1b]11;#000000\x07");
		assert.deepEqual(await second, { foreground: undefined, background: undefined, palette: undefined });
		assert.equal(terminal.writes.length, 1);
	} finally {
		tui.stop();
	}
});

it("a delayed old DA1 cannot settle a newly issued query after a complete no-DA1 drain", async () => {
	const terminal = new ColorTerminal();
	const tui = new TuiMainScreen(terminal);
	try {
		const first = tui.queryTerminalColors({ timeoutMs: 300 });
		colors(tui, "000000");
		await first;
		const second = tui.queryTerminalColors({ timeoutMs: 300 });
		await sent(terminal, 2);
		input(tui, DA1);
		colors(tui, "ffffff");
		assert.deepEqual((await second).foreground, { r: 255, g: 255, b: 255 });
	} finally {
		tui.stop();
	}
});
