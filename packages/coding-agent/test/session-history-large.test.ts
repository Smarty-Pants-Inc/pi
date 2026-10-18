import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

function probe(fixture: string, mode?: string) {
	const result = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			"--max-old-space-size=4096",
			"--import",
			fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url)),
			fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url)),
			...(mode ? [mode] : []),
		],
		{ encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 },
	);
	const report = result.stdout.split("\n").find((line) => line.startsWith("REPORT "));
	console.log(report ?? result.stdout);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	expect(report).toBeDefined();
}

// smarty-dev#11897 / #14576 P2-2: consume every entry's payload, not length or one leaf.
it(
	"enumerates 122,169 unchanged entries twenty times below 3x CPU, including across idle GC",
	() => probe("large-history-probe.ts"),
	200_000,
);
it(
	"keeps a mixed 122k JSON/non-JSON history fast across idle GC",
	() => probe("large-history-probe.ts", "mixed"),
	200_000,
);
it(
	"does not retain a selection exceeding the 64 MiB metadata cache budget",
	() => probe("large-history-probe.ts", "overflow"),
	200_000,
);
it(
	"retires a previously read 32 MiB cold payload below 16 MiB retained",
	() => probe("retired-history-probe.ts"),
	200_000,
);
