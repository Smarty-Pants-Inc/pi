import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";

async function running(pid: number): Promise<boolean> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
	} catch {
		return false;
	}
}

describe.skipIf(process.platform !== "linux")("native process-group custody (PR #131)", () => {
	it.each(["closed", "inherited"])("retires same-group descendants with %s pipes before settlement", async (pipes) => {
		const root = await mkdtemp(join(tmpdir(), "durable-custody-"));
		const env = new NodeExecutionEnv({ cwd: root });
		const controller = new AbortController();
		let pid: number | undefined;
		try {
			// Ignore TERM; the descendant is not detached into a new session/group.
			const redirect = pipes === "closed" ? ">/dev/null 2>&1" : "";
			const result = await env.exec(
				`echo $$ > group.pid; bash -c 'trap "" TERM; echo $$ > descendant.pid; while :; do sleep 60; done' ${redirect} & while [ ! -s descendant.pid ]; do sleep 0.01; done; exit 7`,
				{ timeout: 3 },
				withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
			);
			pid = Number(await readFile(join(root, "descendant.pid"), "utf8"));
			expect(result).toMatchObject({ ok: true, value: { exitCode: 7 } });
			expect(await running(pid)).toBe(false);
			// No later task/environment cleanup should be needed to retire this work.
			await env.cleanup(BACKGROUND_CONTEXT);
			expect(await running(pid)).toBe(false);
		} finally {
			controller.abort();
			try {
				process.kill(-Number(await readFile(join(root, "group.pid"), "utf8")), "SIGKILL");
			} catch {}
			if (pid !== undefined) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			await env.cleanup(BACKGROUND_CONTEXT);
			await rm(root, { recursive: true, force: true });
		}
	});
});
