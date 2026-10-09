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
