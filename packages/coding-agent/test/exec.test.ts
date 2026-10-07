import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("execCommand cancellation", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	// pi#132 R1-S7: an already-aborted caller creates no process.
	it("refuses before spawn for an already-aborted signal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "exec-"));
		dirs.push(dir);
		const controller = new AbortController();
		controller.abort();
		const result = await execCommand("sh", ["-c", "touch spawned"], dir, { signal: controller.signal });
		expect(result).toMatchObject({ killed: true, code: 1 });
		expect(existsSync(join(dir, "spawned"))).toBe(false);
	});

	// pi#132 R2-S1: a child that ignores SIGTERM is force-killed; `proc.killed` is only signal delivery.
	it.skipIf(process.platform === "win32")(
		"force-kills a child that survives SIGTERM",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "exec-"));
			dirs.push(dir);
			const controller = new AbortController();
			const started = Date.now();
			const execution = execCommand("sh", ["-c", "trap '' TERM; touch ready; while :; do sleep 0.1; done"], dir, {
				signal: controller.signal,
			});
			while (!existsSync(join(dir, "ready"))) await new Promise((resolve) => setTimeout(resolve, 20));
			controller.abort();
			const result = await execution;
			expect(result.killed).toBe(true);
			expect(Date.now() - started).toBeLessThan(15_000);
		},
		20_000,
	);
});
