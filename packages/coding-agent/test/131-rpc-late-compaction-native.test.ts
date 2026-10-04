import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// pi#131 AU4-P2-01: admit a raw-self-joining completion after the first idle join,
// while RPC drains a native operation owned by the current or retired session.
it.each(["current", "retired"] as const)(
	"native RPC bounds disposal after late compaction with %s native owner",
	async (owner) => {
		const dir = mkdtempSync(join(tmpdir(), "pi131-rpc-late-"));
		const child = spawn(
			process.execPath,
			[
				"--import",
				fileURLToPath(new URL("./fixtures/131-workspace-source-loader.mjs", import.meta.url)),
				fileURLToPath(new URL("./fixtures/131-rpc-late-compaction-child.ts", import.meta.url)),
			],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, TMPDIR: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1" },
			},
		);
		let stdout = "",
			stderr = "",
			sent = false,
			replacementSent = false,
			eofAt = 0,
			timedOut = false;
		const closed = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		let timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, 10000);
		const endInput = () => {
			eofAt = Date.now();
			clearTimeout(timeout);
			timeout = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, 4500);
			child.stdin.end();
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (!eofAt && stdout.includes('"id":"replace-b"') && stdout.includes('"success":true')) endInput();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (!sent && stderr.includes('"phase":"ready"')) {
				sent = true;
				child.stdin.write(`${JSON.stringify({ type: "bash", id: "held-native", command: "offline-held" })}\n`);
			}
			if (!eofAt && stderr.includes('"phase":"native-operation-held"')) {
				if (owner === "current") endInput();
				else if (!replacementSent) {
					replacementSent = true;
					child.stdin.write(`${JSON.stringify({ type: "new_session", id: "replace-b" })}\n`);
				}
			}
		});
		try {
			const code = await closed;
			const elapsed = Date.now() - eofAt;
			const records = stderr
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(records, stderr).toContainEqual({ phase: "eof", idle: true, replaced: owner === "retired" });
			expect(records, stderr).toContainEqual({ phase: "late-admission-accepted" });
			expect(records, stderr).toContainEqual({
				phase: "late-completion-entered",
				error: "Nothing to compact (session too small)",
				shutdownAborted: true,
				idle: false,
			});
			expect(timedOut, stderr).toBe(false);
			expect(child.signalCode, stderr).toBeNull();
			expect(code, stderr).toBe(1);
			expect(eofAt).toBeGreaterThan(0);
			// Command and independent disposal join each get 1s, plus teardown tolerance.
			expect(elapsed, stderr).toBeLessThan(2300);
			expect(stderr).toContain("RPC command shutdown incomplete");
			expect(stderr).toContain("RPC session cleanup incomplete");
			console.info(`${owner} native owner: exit ${code}, ${elapsed} ms after EOF, no watchdog`);
		} finally {
			clearTimeout(timeout);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await closed;
			}
		}
	},
	15000,
);
