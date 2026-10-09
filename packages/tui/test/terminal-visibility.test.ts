import assert from "node:assert/strict";
import { it } from "node:test";
import { ProcessTerminal } from "../src/terminal.ts";

// smarty-dev#7403: terminal-owned progress keepalives also have no hidden interval.
it("pauses progress keepalives while hidden and resumes only active progress", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const interval = t.mock.method(globalThis, "setInterval");
	const clearInterval = t.mock.method(globalThis, "clearInterval");
	const writes: string[] = [];
	const previousWrite = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		writes.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	const terminal = new ProcessTerminal();
	try {
		terminal.setProgress(true);
		assert.equal(interval.mock.calls.length, 1);
		terminal.setVisible(false);
		assert.equal(clearInterval.mock.calls.length, 1);
		const hiddenWrites = writes.length;
		t.mock.timers.tick(2000);
		terminal.setProgress(true);
		assert.equal(writes.length, hiddenWrites);
		assert.equal(interval.mock.calls.length, 1);
		terminal.setVisible(true);
		assert.equal(interval.mock.calls.length, 2);
		terminal.setVisible(false);
		terminal.setProgress(false);
		terminal.setVisible(true);
		assert.equal(interval.mock.calls.length, 2, "cleared progress must not resurrect");
	} finally {
		terminal.setProgress(false);
		process.stdout.write = previousWrite;
	}
});

// pi#177: deactivating while hidden clears the terminal's progress at once and does not resurrect.
it("clears active progress when deactivated while hidden", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const interval = t.mock.method(globalThis, "setInterval");
	const writes: string[] = [];
	const previousWrite = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		writes.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	const terminal = new ProcessTerminal();
	try {
		terminal.setProgress(true);
		terminal.setVisible(false);
		writes.length = 0;
		terminal.setProgress(false);
		assert.deepEqual(writes, ["\x1b]9;4;0\x07"], "hidden deactivate writes OSC 9;4;0");
		terminal.setProgress(false);
		assert.deepEqual(writes, ["\x1b]9;4;0\x07"], "an inactive progress is not cleared again");
		terminal.setVisible(true);
		t.mock.timers.tick(5000);
		assert.deepEqual(writes, ["\x1b]9;4;0\x07"], "focus-in keeps progress inactive");
		assert.equal(interval.mock.calls.length, 1, "no keepalive restarts");
	} finally {
		terminal.setProgress(false);
		process.stdout.write = previousWrite;
	}
});
