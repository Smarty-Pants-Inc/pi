import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../src/core/compaction/branch-summarization.ts";
import { computeFileLists } from "../src/core/compaction/utils.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

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

function entries(messages: AgentMessage[]): SessionEntry[] {
	return messages.map((message, i) => ({
		type: "message",
		id: `e${i}`,
		parentId: i === 0 ? null : `e${i - 1}`,
		timestamp: new Date(i).toISOString(),
		message,
	}));
}

// smarty-dev#2241 / pi#88: nested calls live on skipped tool results, but file recency must survive.
describe("branch summary nested file recency", () => {
	it("tracks nested calls without summarizing tool output or charging its token cost", () => {
		const user: AgentMessage = { role: "user", content: "keep this text", timestamp: 0 };
		const baseline = prepareBranchEntries(entries([user]), 100);
		const prepared = prepareBranchEntries(
			entries([
				user,
				nestedResult([
					["read", "a.ts"],
					["edit", "b.ts"],
				]),
			]),
			100,
		);
		expect(prepared.messages).toEqual(baseline.messages);
		expect(prepared.totalTokens).toBe(baseline.totalTokens);
		expect(computeFileLists(prepared.fileOps)).toEqual({
			readFiles: ["a.ts"],
			modifiedFiles: ["b.ts"],
			omittedReadFiles: 0,
			omittedModifiedFiles: 0,
		});
	});

	it("keeps the latest 50 nested files and orders native and nested rereads chronologically", () => {
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

	it("does not walk nested calls past the existing summary token boundary", () => {
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
