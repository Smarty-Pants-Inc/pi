import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

interface ProbeRecord {
	phase: "ready" | "shutdown";
	aJoined?: boolean;
	bJoined?: boolean;
	aFinished?: boolean;
	bFinished?: boolean;
}

// pi#131 AU2-P2-01: real EOF and real process exits; no mocked handles can keep an unref deadline alive.
it.each(["complete-wait", "complete-abort", "error-wait", "error-abort", "multi", "raw-wait", "raw-abort"] as const)(
	"native RPC retires within its EOF deadline: %s",
	async (kind) => {
		const dir = mkdtempSync(join(tmpdir(), "pi131-rpc-native-"));
		const child = spawn(
			process.execPath,
			[
				"--import",
				fileURLToPath(new URL("./fixtures/131-workspace-source-loader.mjs", import.meta.url)),
				fileURLToPath(new URL("./fixtures/131-rpc-compaction-child.ts", import.meta.url)),
				kind,
			],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, PI_OFFLINE: "1" },
			},
		);
		let stderr = "",
			eofAt = 0,
			timedOut = false;
		child.stdout.on("data", () => {});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (!eofAt && stderr.includes('"ready":true')) {
				eofAt = Date.now();
				child.stdin.end();
			}
		});
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, 10000);
		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
			const afterEofMs = eofAt ? Date.now() - eofAt : null;
			const records = stderr
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line) as ProbeRecord);
			const raw = kind.startsWith("raw");
			expect(timedOut, stderr).toBe(false);
			expect(eofAt, stderr).toBeGreaterThan(0);
			expect(code, stderr).toBe(raw ? 1 : 0);
			// 300ms tolerance for process teardown and scheduler latency, not another shutdown budget.
			expect(afterEofMs, stderr).not.toBeNull();
			expect(afterEofMs).toBeLessThan(1300);
			const shutdown = records.find((record) => record.phase === "shutdown");
			if (raw) {
				expect(afterEofMs).toBeGreaterThanOrEqual(950);
				expect(shutdown).toBeUndefined();
				expect(stderr).toContain("session or 0 operation(s) exceeded 1000 ms");
			} else {
				expect(shutdown).toMatchObject({ aJoined: true, aFinished: true });
				if (kind === "multi") expect(shutdown).toMatchObject({ bJoined: true, bFinished: true });
			}
		} finally {
			clearTimeout(timeout);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await new Promise<void>((resolve) => child.once("close", () => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	},
	15000,
);
