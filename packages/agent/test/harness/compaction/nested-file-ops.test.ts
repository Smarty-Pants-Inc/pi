import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../../../src/harness/compaction/branch-summarization.ts";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../../../src/harness/compaction/utils.ts";
import type { Entry } from "../../../src/harness/session/index.ts";

function nestedResult(calls: Array<[string, string]>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "script",
		toolName: "codemode",
		content: [{ type: "text", text: "tool output must not enter branch summary".repeat(1000) }],
		isError: false,
		timestamp: 0,
		nestedCalls: {
			calls: calls.map(([name, path], i) => ({
				id: `script/${i}`,
				name,
				arguments: { path },
				status: "ok" as const,
			})),
			complete: true,
		},
	};
}

function entries(messages: AgentMessage[]): Entry[] {
	return messages.map((message, i) => ({
		type: "message",
		id: `e${i}`,
		parentId: i === 0 ? null : `e${i - 1}`,
		seq: i,
		timestamp: i,
		message,
	}));
}

// smarty-dev#2241 / pi#88: nested calls must retain the same capped recency as native calls.
describe("harness nested file operations", () => {
	it("extracts nested reads, edits and writes for automatic compaction", () => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(
			nestedResult([
				["read", "read.ts"],
				["read", "edit.ts"],
				["edit", "edit.ts"],
				["write", "write.ts"],
				["bash", "ignored.ts"],
				["read", ""],
			]),
			fileOps,
		);
		expect(computeFileLists(fileOps)).toEqual({
			readFiles: ["read.ts"],
			modifiedFiles: ["edit.ts", "write.ts"],
			omittedReadFiles: 0,
			omittedModifiedFiles: 0,
		});
	});

	it("keeps the latest 50 mixed native and nested reads in chronological reread order", () => {
		const first = nestedResult(Array.from({ length: 60 }, (_, i): [string, string] => ["read", `f${i}.ts`]));
		const native = fauxAssistantMessage(
			[{ type: "toolCall", id: "read", name: "read", arguments: { path: "f0.ts" } }],
			{ stopReason: "toolUse" },
		);
		const last = nestedResult([["read", "f1.ts"]]);
		const prepared = prepareBranchEntries(entries([first, native, last]));
		const lists = computeFileLists(prepared.fileOps);
		expect(lists.readFiles).toEqual([...Array.from({ length: 48 }, (_, i) => `f${i + 12}.ts`), "f0.ts", "f1.ts"]);
		expect(lists.omittedReadFiles).toBe(10);
		expect(prepared.messages).toEqual([native]);
	});

	it("tracks nested files without summarizing tool output or charging its token cost", () => {
		const user: AgentMessage = { role: "user", content: "keep this text", timestamp: 0 };
		const baseline = prepareBranchEntries(entries([user]), 100);
		const prepared = prepareBranchEntries(entries([user, nestedResult([["read", "a.ts"]])]), 100);
		expect(prepared.messages).toEqual(baseline.messages);
		expect(prepared.totalTokens).toBe(baseline.totalTokens);
		expect(computeFileLists(prepared.fileOps).readFiles).toEqual(["a.ts"]);
	});

	it("excludes older nested calls beyond the existing summary token boundary", () => {
		const oversized: AgentMessage = { role: "user", content: "x".repeat(4000), timestamp: 0 };
		const prepared = prepareBranchEntries(
			entries([nestedResult([["read", "older.ts"]]), oversized, nestedResult([["write", "recent.ts"]])]),
			10,
		);
		expect(prepared.messages).toEqual([]);
		expect(computeFileLists(prepared.fileOps).readFiles).toEqual([]);
		expect(computeFileLists(prepared.fileOps).modifiedFiles).toEqual(["recent.ts"]);
	});
});
