import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// smarty-dev#11897: performance regression on real-sized cold history at the extension trust boundary.
// Stream one ~1 MiB JSONL record at a time; never construct the complete fixture as a string.
const root = mkdtempSync(join(tmpdir(), "pi-history-memory-"));
const file = join(root, "session.jsonl");
beforeAll(() => {
	const fd = openSync(file, "w", 0o600);
	let parentId: string | null = null;
	let sequence = 0;
	const emit = (fields: Record<string, unknown>) => {
		const id = (++sequence).toString(16).padStart(8, "0");
		writeSync(fd, `${JSON.stringify({ id, parentId, timestamp: "2026-10-17T00:00:00.000Z", ...fields })}\n`);
		parentId = id;
		return id;
	};
	try {
		writeSync(
			fd,
			`${JSON.stringify({ type: "session", version: 3, id: "history-memory", timestamp: "2026-10-17T00:00:00.000Z", cwd: root })}\n`,
		);
		for (let i = 0; i < 300; i++) {
			emit({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: `call-${i}`,
					toolName: "read",
					content: [{ type: "text", text: `${i}`.padStart(6, "0") + "x".repeat(1024 * 1024 - 6) }],
					isError: false,
					timestamp: i,
				},
			});
		}
		// Match the real journal's ~50k entries as well as its cold payload size.
		for (let i = 0; i < 49_600; i++) emit({ type: "custom", customType: "history-metadata", data: { index: i } });
		const checkpoint = (sequence + 1).toString(16).padStart(8, "0");
		emit({
			type: "compaction",
			firstKeptEntryId: checkpoint,
			summary: "Synthetic checkpoint.",
			tokensBefore: 100_000_000,
		});
		for (let i = 0; i < 150; i++)
			emit({ type: "message", message: { role: "user", content: `tail ${i}`, timestamp: i } });
	} finally {
		closeSync(fd);
	}
	expect(statSync(file).size).toBeGreaterThan(300 * 1024 * 1024);
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function probe(mode: "history" | "ancestry" | "projection" | "compact") {
	const result = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			"--trace-gc",
			"--max-old-space-size=8192",
			"--import",
			fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url)),
			fileURLToPath(new URL("./fixtures/history-memory-probe.ts", import.meta.url)),
			mode,
			file,
		],
		{ encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
	);
	const reportLine = result.stdout.split("\n").find((line) => line.startsWith("REPORT "));
	const report = reportLine
		? (JSON.parse(reportLine.slice(7)) as Record<string, number | boolean | string>)
		: undefined;
	console.log(JSON.stringify({ mode, status: result.status, error: result.error?.message, report }));
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	expect(report).toBeDefined();
	if (mode === "compact") {
		const phase = result.stdout.split("COMPACT_PEAK_START\n")[1]?.split("COMPACT_PEAK_END")[0] ?? "";
		const gcPeaks = [...phase.matchAll(/(\d+(?:\.\d+)?) \([\d.]+\) ->/g)].map(
			(match) => Number(match[1]) * 1024 * 1024,
		);
		const gcPeak = Math.max(Number(report!.peak), ...gcPeaks);
		console.log(JSON.stringify({ mode, gcPeak, budget: report!.budget }));
		expect(gcPeak).toBeLessThan(Number(report!.budget));
	}
}

describe("extension history memory budgets", () => {
	it("retains less than 16 MiB after a full-history payload read", () => probe("history"), 240_000);
	it(
		"retains less than 16 MiB walking the full ancestry through getLeafEntry/getEntry",
		() => probe("ancestry"),
		240_000,
	);
	it("projects only active context without retaining cold history", () => probe("projection"), 240_000);
	it("dispatches before-compact below twice the loaded session heap", () => probe("compact"), 240_000);
});
