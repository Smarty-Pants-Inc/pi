import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const supported =
	process.platform === "linux" &&
	spawnSync("sh", ["-c", "command -v python3 && command -v tmux && command -v Xvfb"], { stdio: "ignore" }).status ===
		0;

// pi#137 / smarty-dev#3535, A15 and A17. No mocked clipboard, renderer, CLI or provider.
it.skipIf(!supported)(
	"records real clipboard-image Bash submission and unchanged-image fullscreen redraw",
	async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-real-entry-"));
		const output = process.env.TASK_OUT
			? join(process.env.TASK_OUT, "real-entry-boundaries")
			: join(scratch, "recording");
		try {
			const { stdout } = await promisify(execFile)(
				"python3",
				[
					fileURLToPath(new URL("./fixtures/real-entry-proof.py", import.meta.url)),
					fileURLToPath(new URL("../../../", import.meta.url)),
					scratch,
					output,
					fileURLToPath(new URL("./fixtures/real-entry-widget.ts", import.meta.url)),
				],
				{
					env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch },
					timeout: 110000,
				},
			);
			expect(JSON.parse(stdout)).toMatchObject({ passed: true });
			const steps = JSON.parse(readFileSync(join(output, "steps.json"), "utf8")) as Array<{
				step: string;
				passed: boolean;
				excluded?: string;
			}>;
			expect(steps.find((entry) => entry.step === "fullscreen-image-redrawn")?.passed).toBe(true);
			// Linux intentionally lacks native file-path clipboard support. Do not label the image fallback as that proof.
			expect(steps.find((entry) => entry.step === "native-path")).toMatchObject({
				passed: false,
				excluded: expect.stringContaining("Darwin"),
			});
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	},
	120000,
);
