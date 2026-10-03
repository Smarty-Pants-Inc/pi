import { appendFileSync, writeFileSync } from "node:fs";

/** Real messages plus retained extension snapshots that do not belong in model context. */
export function writeSyntheticSession(file: string, cwd: string, targetBytes = 150 * 1024 * 1024) {
	const timestamp = "2026-10-03T00:00:00.000Z";
	const header = { type: "session", version: 3, id: "lazy-large", timestamp, cwd };
	writeFileSync(file, `${JSON.stringify(header)}\n`);
	let bytes = Buffer.byteLength(JSON.stringify(header)) + 1;
	let parentId: string | null = null;
	let serial = 0;
	let firstMessageId = "";
	let lastCompactionId = "";
	const write = (value: Record<string, unknown>) => {
		const id = `e${serial++}`;
		const line = `${JSON.stringify({ ...value, id, parentId, timestamp })}\n`;
		appendFileSync(file, line);
		bytes += Buffer.byteLength(line);
		parentId = id;
		return id;
	};
	const user = (text: string) => write({ type: "message", message: { role: "user", content: text, timestamp: 1 } });
	const assistant = (text: string) =>
		write({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "faux",
				provider: "faux",
				model: "faux-1",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
		});
	const tool = (text: string) =>
		write({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 1,
			},
		});
	let kept = "";
	for (let round = 0; round < 240; round++) {
		const id = user(`Inspect file ${round}`);
		firstMessageId ||= id;
		if (round % 40 === 30) kept = id;
		assistant(`Inspection ${round} ${"a".repeat(4096)}`);
		tool(`File ${round} ${"t".repeat(32768)}`);
		if (round % 40 === 39)
			lastCompactionId = write({
				type: "compaction",
				summary: `Checkpoint ${round} ${"s".repeat(4096)}`,
				firstKeptEntryId: kept,
				tokensBefore: 100000,
				details: { readFiles: [`file-${round}`] },
			});
	}
	let snapshots = 0;
	while (bytes < targetBytes) {
		user(`Next operation ${snapshots}`);
		assistant(`Result ${snapshots} ${"a".repeat(1024)}`);
		tool(`Output ${snapshots} ${"t".repeat(2048)}`);
		write({
			type: "custom",
			customType: "run-snapshot",
			data: { status: "stopped", output: "d".repeat(512 * 1024) },
		});
		snapshots++;
	}
	return { bytes, entries: serial, firstMessageId, lastCompactionId, leafId: parentId!, snapshots };
}
