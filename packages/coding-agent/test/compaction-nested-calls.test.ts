import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../src/core/compaction/utils.ts";

describe("compaction file operations", () => {
	it("include files touched by nested calls recorded on tool results", () => {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "codemode-1",
			toolName: "codemode",
			content: [],
			isError: false,
			timestamp: 0,
			nestedCalls: {
				calls: [
					{ id: "codemode-1/1", name: "read", arguments: { path: "a.ts" }, status: "ok" },
					{ id: "codemode-1/2", name: "edit", arguments: { path: "b.ts", edits: [] }, status: "ok" },
					{ id: "codemode-1/3", name: "write", argumentsBytes: 40000, status: "ok" },
				],
				complete: false,
			},
		};
		const fileOps = createFileOps();
		extractFileOpsFromMessage(result, fileOps);
		expect(computeFileLists(fileOps)).toEqual({
			readFiles: ["a.ts"],
			modifiedFiles: ["b.ts"],
			omittedReadFiles: 0,
			omittedModifiedFiles: 0,
		});
	});

	// pi#88: nested Codemode calls must preserve the same recency cap as native tools.
	it("keeps the last 50 nested reads and moves a reread file to the end", () => {
		const fileOps = createFileOps();
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "codemode-cap",
			toolName: "codemode",
			content: [],
			isError: false,
			timestamp: 0,
			nestedCalls: {
				calls: Array.from({ length: 60 }, (_, i) => ({
					id: `codemode-cap/${i}`,
					name: "read",
					arguments: { path: `file-${i}.ts` },
					status: "ok" as const,
				})),
				complete: true,
			},
		};
		extractFileOpsFromMessage(result, fileOps);
		const capped = computeFileLists(fileOps);
		expect(capped.readFiles).toEqual(Array.from({ length: 50 }, (_, i) => `file-${i + 10}.ts`));
		expect(capped.omittedReadFiles).toBe(10);
		extractFileOpsFromMessage(
			{
				...result,
				nestedCalls: {
					calls: [{ id: "reread", name: "read", arguments: { path: "file-0.ts" }, status: "ok" }],
					complete: true,
				},
			},
			fileOps,
		);
		const reread = computeFileLists(fileOps);
		expect(reread.readFiles).toHaveLength(50);
		expect(reread.readFiles[0]).toBe("file-11.ts");
		expect(reread.readFiles.at(-1)).toBe("file-0.ts");
		expect(reread.omittedReadFiles).toBe(10);
	});
});
