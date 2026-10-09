import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

// smarty-dev#7403: SIGWINCH must reach the TUI even when stdout dimensions do not change.
for (const renderer of ["main", "alt"]) {
	for (const event of ["SIGWINCH", "resize", "keypress", "mouse", "paste"]) {
		it(`${renderer} ProcessTerminal ${event} recovers hidden streaming state`, (t) => {
			if (process.platform === "win32" && event === "SIGWINCH") return;
			const root = mkdtempSync(join(tmpdir(), "pi-resize-focus-"));
			try {
				const script = join(root, "resize.mjs");
				writeFileSync(
					script,
					`
import assert from "node:assert/strict";
import { ProcessTerminal } from ${JSON.stringify(new URL("../src/terminal.ts", import.meta.url).href)};
import { TuiMainScreen } from ${JSON.stringify(new URL("../src/tui-main-screen.ts", import.meta.url).href)};
import { TuiAltScreen } from ${JSON.stringify(new URL("../src/tui-alt-screen.ts", import.meta.url).href)};
const terminal = new ProcessTerminal();
const event = process.argv[3];
const focusRequestDelta = event === "SIGWINCH" || event === "resize" ? 1 : 0;
let focusRequests = 0;
const write = terminal.write.bind(terminal);
terminal.write = (data) => { if (data === "\x1b[?1004h") focusRequests++; write(data); };
const tui = new (process.argv[2] === "alt" ? TuiAltScreen : TuiMainScreen)(terminal);
const component = { renders: 0, text: "initial", latest: "", render() { this.renders++; this.latest = this.text; return [this.text]; }, invalidate() {} };
tui.addChild(component);
// Signal watchers are unreferenced in Node. Keep the child alive until both real signals arrive.
const watchdog = setTimeout(() => { throw new Error("focus resize probe timed out"); }, 5000);
const run = () => setImmediate(() => {
	process.stdin.emit("data", "\x1b[O");
	const baseline = component.renders;
	for (let token = 0; token < 200; token++) { component.text = "token " + token; tui.requestRender(); }
	setImmediate(() => {
		assert.equal(component.renders, baseline);
		const requests = focusRequests;
		const full = tui.fullRedraws;
		const finish = () => setImmediate(() => {
			assert.equal(focusRequests, requests + focusRequestDelta);
			assert.equal(component.renders, baseline + 1);
			assert.equal(tui.fullRedraws, full + 1);
			assert.equal(component.latest, "token 199");
			clearTimeout(watchdog);
			tui.stop({ preserveScreen: true });
			assert.equal(terminal.focusReportingEnabled, false);
			console.log("PROBE " + JSON.stringify({ renderer: process.argv[2], event: process.argv[3], hiddenRenders: 0, recoveredRenders: 1, fullDraws: 1, focusRequests: focusRequestDelta, latest: component.latest }));
		});
		if (event === "SIGWINCH") {
			process.once("SIGWINCH", finish);
			process.kill(process.pid, "SIGWINCH");
		} else {
			if (event === "resize") process.stdout.emit("resize");
			else if (event === "keypress") process.stdin.emit("data", "k");
			else if (event === "mouse") process.stdin.emit("data", "\x1b[<35;1;1M");
			else {
				// Actual ProcessTerminal paste assembly must not interpret literal focus bytes.
				process.stdin.emit("data", "\x1b[200~literal\x1b");
				process.stdin.emit("data", "[O and \x1b[I");
				process.stdin.emit("data", "\x1b[201~");
			}
			finish();
		}
	});
});
// Await startup's SIGWINCH, not an arbitrary event-loop turn, before hiding.
if (process.platform !== "win32") process.once("SIGWINCH", run);
tui.start();
if (process.platform === "win32") run();
`,
				);
				const result = spawnSync(process.execPath, [script, renderer, event], {
					encoding: "utf8",
					timeout: 10_000,
				});
				assert.ifError(result.error);
				assert.equal(result.status, 0, result.stderr);
				assert.equal(result.signal, null);
				assert.equal(result.stdout.split("\x1b[?1004l").length - 1, 1, "cleanup has one owner even in fullscreen");
				const match = result.stdout.match(/PROBE (.*)/);
				assert.ok(match, result.stdout);
				t.diagnostic(match[1]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
}
