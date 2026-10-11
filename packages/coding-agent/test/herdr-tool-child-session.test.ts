/**
 * smarty-dev#2636: Herdr refuses an enroll from outside the pane's foreground process group. Pi's
 * side of that: a tool child (`bash` tool and `!cmd`, which share these operations) runs in its own
 * new session with no controlling terminal, so it can never be a member of Pi's foreground group.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";

/** Fields of /proc/<pid>/stat after the command name: state, ppid, pgrp, session, tty_nr. */
function statFields(stat: string): { pgrp: number; session: number; ttyNr: number } {
	const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return { pgrp: Number(rest[2]), session: Number(rest[3]), ttyNr: Number(rest[4]) };
}

describe.skipIf(process.platform !== "linux")("tool child process isolation (smarty-dev#2636)", () => {
	it("runs a bash tool child in a new session, without Pi's process group or a controlling tty", async () => {
		let output = "";
		const result = await createLocalBashOperations().exec('echo "$$"; cat "/proc/$$/stat"', process.cwd(), {
			onData: (data) => {
				output += data.toString("utf8");
			},
		});
		expect(result.exitCode).toBe(0);
		const [pidLine, stat] = output.split("\n");
		const child = statFields(stat!);
		const pi = statFields(readFileSync("/proc/self/stat", "utf8"));
		expect(child.session).toBe(Number(pidLine));
		expect(child.session).not.toBe(pi.session);
		expect(child.pgrp).not.toBe(pi.pgrp);
		expect(child.ttyNr).toBe(0);
	});
});
