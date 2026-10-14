import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const child = fileURLToPath(new URL("./fixtures/session-export-heap-child.ts", import.meta.url));

function runChild(mode: "fixed-keys" | "fixed-buffer" | "old-buffer", scratch: string) {
	const result = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			"--max-old-space-size=1024",
			// Keep the young-generation allowance stable across Node 22 and 24.
			"--max-semi-space-size=16",
			"--experimental-strip-types",
			child,
			mode,
			scratch,
		],
		{ encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 },
	);
	const evidence = JSON.stringify({
		mode,
		status: result.status,
		signal: result.signal,
		error: result.error?.message,
		stdout: result.stdout,
		stderr: result.stderr.slice(-4096),
	});
	expect(result.error, evidence).toBeUndefined();
	expect(result.stdout, evidence).toMatch(new RegExp(`^EXPORT_READY ${mode} \\d+ heapUsed=\\d+$`, "m"));
	console.log(`Heavy child receipt: ${JSON.stringify({ mode, status: result.status, signal: result.signal })}`);
	return { result, evidence };
}

// smarty-dev#12074: real public exports under a fixed 1 GiB old-space cap. Opt in because
// each child holds a 10M-key object or a 512 MiB Buffer.
describe("session export heap bounds (#12074)", () => {
	test.skipIf(process.env.PI_HEAVY_TESTS !== "1")(
		"heavy (default skipped; set PI_HEAVY_TESTS=1): refuses a 512 MiB Buffer by brand where the old JSON.stringify path exhausts a 1 GiB old-space cap",
		() => {
			const scratch = mkdtempSync(join(tmpdir(), "pi-export-heap-buffer-"));
			try {
				const fixed = runChild("fixed-buffer", scratch);
				expect(fixed.result.status, fixed.evidence).toBe(0);
				expect(fixed.result.signal, fixed.evidence).toBeNull();
				for (const label of ["live-string", "live-jsonl", "trailing-string", "trailing-jsonl"]) {
					expect(fixed.result.stdout, fixed.evidence).toContain(`REFUSED ${label} `);
				}
				expect(fixed.result.stdout, fixed.evidence).toContain("FIXED_BUFFER_REFUSED\n");
				// Counterexample: Buffer.prototype.toJSON materializes one array element per byte.
				const old = runChild("old-buffer", scratch);
				expect(old.result.signal === "SIGABRT" || old.result.status === 134, old.evidence).toBe(true);
				expect(old.result.stdout, old.evidence).not.toContain("OLD_BUFFER_SERIALIZED");
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		},
		240_000,
	);

	test.skipIf(process.env.PI_HEAVY_TESTS !== "1")(
		"heavy (default skipped; set PI_HEAVY_TESTS=1): refuses a 10M-key object in live and trailing entries without exhausting a 1 GiB old-space cap",
		() => {
			const scratch = mkdtempSync(join(tmpdir(), "pi-export-heap-keys-"));
			try {
				const fixed = runChild("fixed-keys", scratch);
				expect(fixed.result.status, fixed.evidence).toBe(0);
				expect(fixed.result.signal, fixed.evidence).toBeNull();
				for (const label of ["live-string", "live-jsonl", "trailing-string", "trailing-jsonl"]) {
					expect(fixed.result.stdout, fixed.evidence).toContain(`REFUSED ${label} `);
				}
				// Not constant-space: for...in builds the full key list (about 32 B per array-index
				// key on Node 22.23.2 and 24.19.0) before the budget can stop the walk.
				const growth = Number(/^FIXED_KEYS_REFUSED retainedGrowth=(-?\d+)$/m.exec(fixed.result.stdout)?.[1]);
				expect(Number.isFinite(growth), fixed.evidence).toBe(true);
				expect(growth, fixed.evidence).toBeLessThan(512 * 1024 * 1024);
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		},
		240_000,
	);
});
