import assert from "node:assert/strict";
import { it } from "node:test";
import type { Terminal } from "../src/index.ts";

// pi#173: a pre-1.1.0 implementation must still satisfy the exported Terminal interface.
class LegacyTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	output = "";
	onInput?: (data: string) => void;

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.onInput = onInput;
	}
	stop(): void {
		this.onInput = undefined;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.output += data;
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

it("accepts and operates a Terminal implementation without setProgramStatus (pi#173)", async () => {
	const legacy = new LegacyTerminal();
	const terminal: Terminal = legacy;
	terminal.start(
		(data) => terminal.write(data),
		() => {},
	);
	legacy.onInput?.("legacy input");
	assert.equal(legacy.output, "legacy input");
	assert.equal(terminal.setProgramStatus, undefined);
	await terminal.drainInput();
	terminal.stop();
	assert.equal(legacy.onInput, undefined);
});
