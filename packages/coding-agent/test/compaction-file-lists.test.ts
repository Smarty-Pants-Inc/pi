import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../src/core/compaction/branch-summarization.ts";
import { type CompactionDetails, prepareCompaction } from "../src/core/compaction/compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
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

	// #3155: the shared cap must follow actual write/edit order, not category order.
	it.each([
		["edit", "write"],
		["write", "edit"],
	] as const)("keeps a final %s after 50 %s calls", (latestTool, earlierTool) => {
		const fileOps = createFileOps();
		const earlierPaths = Array.from({ length: MAX_SUMMARY_FILES }, (_, i) => `earlier-${i}.ts`);
		extractFileOpsFromMessage(
			toolCalls([
				["read", earlierPaths[0]],
				["read", "latest.ts"],
				["read", "read-only.ts"],
				...earlierPaths.map((path): [string, string] => [earlierTool, path]),
			]),
			fileOps,
		);
		extractFileOpsFromMessage(toolCalls([[latestTool, "latest.ts"]]), fileOps);
		expect(computeFileLists(fileOps)).toEqual({
			readFiles: ["read-only.ts"],
			modifiedFiles: [...earlierPaths.slice(1), "latest.ts"],
			omittedReadFiles: 0,
			omittedModifiedFiles: 1,
		});

		// A duplicate touch is newest, not a second path or another omission.
		extractFileOpsFromMessage(toolCalls([[latestTool, earlierPaths[0]]]), fileOps);
		expect(computeFileLists(fileOps)).toEqual({
			readFiles: ["read-only.ts"],
			modifiedFiles: [...earlierPaths.slice(2), "latest.ts", earlierPaths[0]],
			omittedReadFiles: 0,
			omittedModifiedFiles: 1,
		});
	});

	// #3155: same-category and cross-category duplicate touches both move to the end.
	it.each([
		["write", "edit"],
		["edit", "write"],
	] as const)("moves repeated %s/%s touches last and excludes modified reads", (firstTool, secondTool) => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(
			toolCalls([
				["read", "a.ts"],
				["read", "b.ts"],
				["read", "c.ts"],
				["read", "read-only.ts"],
				[firstTool, "a.ts"],
				[secondTool, "b.ts"],
				[firstTool, "c.ts"],
				[secondTool, "a.ts"],
				[firstTool, "b.ts"],
				[firstTool, "b.ts"],
				["read", "a.ts"],
			]),
			fileOps,
		);
		expect(computeFileLists(fileOps)).toEqual({
			readFiles: ["read-only.ts"],
			modifiedFiles: ["c.ts", "a.ts", "b.ts"],
			omittedReadFiles: 0,
			omittedModifiedFiles: 0,
		});
	});

	// #3155: nested calls and native calls share the same modification timeline.
	it("orders native and nested modifications together", () => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(
			toolCalls([
				["write", "a.ts"],
				["edit", "b.ts"],
			]),
			fileOps,
		);
		extractFileOpsFromMessage(
			{
				role: "toolResult",
				toolCallId: "script",
				toolName: "codemode",
				content: [],
				isError: false,
				timestamp: 0,
				nestedCalls: {
					calls: [
						{ id: "script/1", name: "write", arguments: { path: "c.ts" }, status: "ok" },
						{ id: "script/2", name: "edit", arguments: { path: "a.ts" }, status: "ok" },
						{ id: "script/3", name: "write", arguments: { path: "b.ts" }, status: "ok" },
					],
					complete: true,
				},
			},
			fileOps,
		);
		extractFileOpsFromMessage(toolCalls([["edit", "c.ts"]]), fileOps);
		expect(computeFileLists(fileOps)).toEqual({
			readFiles: [],
			modifiedFiles: ["a.ts", "b.ts", "c.ts"],
			omittedReadFiles: 0,
			omittedModifiedFiles: 0,
		});
	});

	// #3155: existing three-set callers have no mixed chronology to reconstruct.
	it("preserves the deterministic fallback and does not mutate caller sets", () => {
		const fileOps: FileOperations = {
			read: new Set(["a.ts", "read-only.ts"]),
			edited: new Set(["b.ts", "a.ts"]),
			written: new Set(["a.ts", "c.ts"]),
		};
		const before = {
			read: [...fileOps.read],
			edited: [...fileOps.edited],
			written: [...fileOps.written],
		};
		const lists = computeFileLists(fileOps);
		expect(lists).toEqual({
			readFiles: ["read-only.ts"],
			modifiedFiles: ["b.ts", "a.ts", "c.ts"],
			omittedReadFiles: 0,
			omittedModifiedFiles: 0,
		});
		expect(computeFileLists(fileOps)).toEqual(lists);
		expect({ read: [...fileOps.read], edited: [...fileOps.edited], written: [...fileOps.written] }).toEqual(before);

		extractFileOpsFromMessage(
			toolCalls([
				["write", "b.ts"],
				["edit", "c.ts"],
			]),
			fileOps,
		);
		expect(computeFileLists(fileOps).modifiedFiles).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	// #3155: the stored list carries recency, not the original write/edit categories.
	it.each(["compaction", "branch_summary"] as const)(
		"carries persisted %s details before new mixed touches",
		(type) => {
			const fileOps = createFileOps();
			const earlierPaths = Array.from({ length: MAX_SUMMARY_FILES }, (_, i) => `earlier-${i}.ts`);
			fileOps.read.add("read-only.ts");
			fileOps.read.add("latest.ts");
			extractFileOpsFromMessage(
				toolCalls(earlierPaths.map((path, i): [string, string] => [i % 2 === 0 ? "write" : "edit", path])),
				fileOps,
			);
			const { readFiles, modifiedFiles } = computeFileLists(fileOps);
			// Match the JSON details received after session persistence, without carrying private state.
			const details = JSON.parse(JSON.stringify({ readFiles, modifiedFiles })) as CompactionDetails;
			const base = {
				id: "summary",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				summary: "Earlier work",
				details,
			};
			const entries: SessionEntry[] = [
				type === "compaction"
					? { ...base, type, firstKeptEntryId: "summary", tokensBefore: 100 }
					: { ...base, type, fromId: "old-leaf" },
				{
					type: "message",
					id: "calls",
					parentId: "summary",
					timestamp: new Date(1).toISOString(),
					message: toolCalls([
						["write", "latest.ts"],
						["edit", earlierPaths[0]],
					]),
				},
				{
					type: "message",
					id: "tail",
					parentId: "calls",
					timestamp: new Date(2).toISOString(),
					message: { role: "user", content: "Keep this input", timestamp: 2 },
				},
			];
			const prepared =
				type === "compaction"
					? prepareCompaction(entries, { enabled: true, reserveTokens: 100, keepRecentTokens: 1 })
					: prepareBranchEntries(entries);
			expect(prepared).toBeDefined();
			expect(computeFileLists(prepared!.fileOps)).toEqual({
				readFiles: ["read-only.ts"],
				modifiedFiles: [...earlierPaths.slice(2), "latest.ts", earlierPaths[0]],
				omittedReadFiles: 0,
				omittedModifiedFiles: 1,
			});
			expect(details).toEqual({ readFiles: ["read-only.ts", "latest.ts"], modifiedFiles: earlierPaths });
		},
	);

	// #3155: carrying earlier lists must bound both reads and mixed modifications.
	it("does not grow across repeated compactions", () => {
		let carried = { readFiles: [] as string[], modifiedFiles: [] as string[] };
		for (let round = 0; round < 20; round++) {
			const fileOps = createFileOps();
			for (const f of carried.readFiles) fileOps.read.add(f);
			for (const f of carried.modifiedFiles) fileOps.edited.add(f);
			extractFileOpsFromMessage(
				toolCalls([
					...Array.from({ length: 30 }, (_, i): [string, string] => ["read", `r${round}-${i}.ts`]),
					...Array.from({ length: 30 }, (_, i): [string, string] => [
						i % 2 === 0 ? "write" : "edit",
						`m${round}-${i}.ts`,
					]),
				]),
				fileOps,
			);
			const lists = computeFileLists(fileOps);
			expect(lists.omittedReadFiles).toBe(Math.max(0, carried.readFiles.length + 30 - MAX_SUMMARY_FILES));
			expect(lists.omittedModifiedFiles).toBe(Math.max(0, carried.modifiedFiles.length + 30 - MAX_SUMMARY_FILES));
			carried = lists;
		}
		expect(carried.readFiles).toHaveLength(MAX_SUMMARY_FILES);
		expect(carried.readFiles.at(-1)).toBe("r19-29.ts");
		expect(carried.modifiedFiles).toHaveLength(MAX_SUMMARY_FILES);
		expect(carried.modifiedFiles).toEqual([
			...Array.from({ length: 20 }, (_, i) => `m18-${i + 10}.ts`),
			...Array.from({ length: 30 }, (_, i) => `m19-${i}.ts`),
		]);
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
