import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../src/core/compaction/branch-summarization.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	MAX_SUMMARY_FILES,
} from "../src/core/compaction/utils.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

function toolCalls(calls: Array<[string, string]>): AgentMessage {
	return {
		role: "assistant",
		content: calls.map(([name, path], i) => ({ type: "toolCall", id: `c${i}`, name, arguments: { path } })),
	} as unknown as AgentMessage;
}

// smarty-dev#2177: earlier compactions carried every file forward, so one summary held 4,891 paths (510 KB).
describe("compaction file lists", () => {
	it("keeps the most recently used files per list and reports how many were omitted", () => {
		const fileOps = createFileOps();
		// Files carried forward from a previous compaction come first.
		for (let i = 0; i < 200; i++) fileOps.read.add(`old/read-${i}.ts`);
		for (let i = 0; i < 80; i++) fileOps.edited.add(`old/edit-${i}.ts`);
		// A file read again in the compacted range counts as recent.
		extractFileOpsFromMessage(
			toolCalls([
				["read", "old/read-0.ts"],
				["read", "new/read.ts"],
				["edit", "new/edit.ts"],
			]),
			fileOps,
		);

		const lists = computeFileLists(fileOps);
		expect(lists.readFiles).toHaveLength(MAX_SUMMARY_FILES);
		expect(lists.readFiles.slice(-2)).toEqual(["old/read-0.ts", "new/read.ts"]);
		expect(lists.readFiles).not.toContain("old/read-1.ts");
		expect(lists.omittedReadFiles).toBe(201 - MAX_SUMMARY_FILES);
		expect(lists.modifiedFiles).toHaveLength(MAX_SUMMARY_FILES);
		expect(lists.modifiedFiles.at(-1)).toBe("new/edit.ts");
		expect(lists.omittedModifiedFiles).toBe(81 - MAX_SUMMARY_FILES);

		const text = formatFileOperations(lists);
		expect(text).toContain(`(+${201 - MAX_SUMMARY_FILES} earlier files omitted)\n</read-files>`);
		expect(text.split("\n").filter((line) => line.endsWith(".ts"))).toHaveLength(2 * MAX_SUMMARY_FILES);
	});

	it("does not grow across repeated compactions", () => {
		let carried = { readFiles: [] as string[], modifiedFiles: [] as string[] };
		for (let round = 0; round < 20; round++) {
			const fileOps = createFileOps();
			for (const f of carried.readFiles) fileOps.read.add(f);
			for (const f of carried.modifiedFiles) fileOps.edited.add(f);
			extractFileOpsFromMessage(
				toolCalls(Array.from({ length: 30 }, (_, i): [string, string] => ["read", `r${round}-${i}.ts`])),
				fileOps,
			);
			carried = computeFileLists(fileOps);
		}
		expect(carried.readFiles).toHaveLength(MAX_SUMMARY_FILES);
		expect(carried.readFiles.at(-1)).toBe("r19-29.ts");
	});

	it("lists everything when under the cap, sorted, without an omission note", () => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(
			toolCalls([
				["read", "b.ts"],
				["read", "a.ts"],
				["write", "c.ts"],
			]),
			fileOps,
		);
		expect(formatFileOperations(computeFileLists(fileOps))).toBe(
			"\n\n<read-files>\na.ts\nb.ts\n</read-files>\n\n<modified-files>\nc.ts\n</modified-files>",
		);
	});

	it("branch summaries keep the files touched last in the branch", () => {
		// The branch walk runs newest to oldest; recency must still follow session order.
		const entries: SessionEntry[] = Array.from({ length: 60 }, (_, i) => ({
			type: "message",
			id: `e${i}`,
			parentId: i === 0 ? null : `e${i - 1}`,
			timestamp: new Date(1_000 + i).toISOString(),
			message: toolCalls([["read", `f${i + 1}.ts`]]),
		}));
		const lists = computeFileLists(prepareBranchEntries(entries).fileOps);
		expect(lists.readFiles.at(-1)).toBe("f60.ts");
		expect(lists.readFiles).toContain("f51.ts");
		expect(lists.readFiles).not.toContain("f10.ts");
		expect(lists.omittedReadFiles).toBe(10);
	});
});
