import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

// smarty-dev#7403: exercise actual process teardown, including synchronous pipe output.
for (const mode of [
	"stop",
	"natural",
	"exit",
	"crash",
	"handled-crash",
	"SIGINT",
	"SIGTERM",
	"SIGHUP",
	"handled-signal",
]) {
	it(`disables focus reporting exactly once on ${mode}`, () => {
		if (process.platform === "win32" && mode === "SIGHUP") return;
		const root = mkdtempSync(join(tmpdir(), "pi-focus-cleanup-"));
		try {
			const script = join(root, "exit.mjs");
			writeFileSync(
				script,
				`
import { ProcessTerminal } from ${JSON.stringify(new URL("../src/terminal.ts", import.meta.url).href)};
const terminal = new ProcessTerminal();
terminal.setFocusReporting(true);
terminal.setFocusReporting(true);
const mode = process.argv[2];
if (mode === "stop") { terminal.stop(); terminal.stop(); }
else if (mode === "exit") process.exit(7);
else if (mode === "crash") throw new Error("focus-cleanup-probe");
else if (mode === "handled-crash") {
	process.once("uncaughtException", () => process.exit(19));
	throw new Error("focus-cleanup-probe");
} else if (mode !== "natural") {
	const signal = mode === "handled-signal" ? "SIGTERM" : mode;
	if (mode === "handled-signal") process.once(signal, () => process.exit(23));
	setInterval(() => {}, 1000);
	process.kill(process.pid, signal);
}
`,
			);
			const result = spawnSync(process.execPath, [script, mode], { encoding: "utf8", timeout: 10_000 });
			assert.ifError(result.error);
			assert.equal(result.stdout.split("\x1b[?1004h").length - 1, 2, "repeat enables request fresh focus");
			assert.equal(result.stdout.split("\x1b[?1004l").length - 1, 1, "cleanup is synchronous and idempotent");
			if (mode.startsWith("SIG")) assert.equal(result.signal, mode, "default signal termination is preserved");
			else
				assert.equal(
					result.status,
					mode === "exit"
						? 7
						: mode === "crash"
							? 1
							: mode === "handled-crash"
								? 19
								: mode === "handled-signal"
									? 23
									: 0,
				);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
