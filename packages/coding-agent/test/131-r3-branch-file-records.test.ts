import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type NestedToolCallRecord,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { generateBranchSummary, prepareBranchEntries } from "../src/core/compaction/branch-summarization.ts";
import { computeFileLists, MAX_SUMMARY_FILES } from "../src/core/compaction/utils.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createHarness, getToolResult } from "./suite/harness.ts";

const model: Model<"anthropic-messages"> = {
	id: "offline-summary",
	name: "Offline summary",
	api: "anthropic-messages",
	provider: "test",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
};

async function summarize(entries: SessionEntry[]) {
	let prompt = "";
	const streamFn: StreamFn = (_model, context) => {
		prompt = JSON.stringify(context.messages);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() =>
			stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Offline summary") }),
		);
		return stream;
	};
	const result = await generateBranchSummary(entries, {
		model,
		signal: new AbortController().signal,
		streamFn,
	});
	return { result, prompt };
}

function messageEntry(message: AgentMessage, i: number): SessionEntry {
	return {
		type: "message",
		id: `entry-${i}`,
		parentId: i === 0 ? null : `entry-${i - 1}`,
		timestamp: new Date(i + 1).toISOString(),
		message,
	};
}

function historicalResult(calls: Array<[string, string]>, i: number): SessionEntry {
	// Round-trip the persisted JSON shape; no live recorder or Codemode admission is needed.
	const records: NestedToolCallRecord[] = calls.map(([name, path], j) => ({
		id: `historical-${i}/${j}`,
		name,
		arguments: { path },
		status: "ok",
	}));
	return JSON.parse(
		JSON.stringify(
			messageEntry(
				{
					role: "toolResult",
					toolCallId: `historical-${i}`,
					toolName: "generic_composite",
					content: [{ type: "text", text: "RESULT_PROSE_NOT_FOR_SUMMARY" }],
					isError: false,
					timestamp: i + 1,
					nestedCalls: { complete: true, calls: records },
				},
				i,
			),
		),
	) as SessionEntry;
}

// PR #131 F20: generic native nested file records were filtered out with tool-result prose.
describe("branch nested file records", () => {
	it("retains live generic composite records in preparation, final details and tags", async () => {
		const calls: Array<[string, string]> = [
			["read", "live-read.ts"],
			["read", "live-modified.ts"],
			["write", "live-written.ts"],
			["edit", "live-modified.ts"],
			["read", "live-read.ts"],
		];
		const executed: Array<[string, string]> = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					for (const name of ["read", "edit", "write"]) {
						pi.registerTool({
							name,
							label: name,
							description: "Mock file operation; no filesystem effects.",
							parameters: Type.Object({ path: Type.String() }),
							execute: async (_id, { path }) => {
								executed.push([name, path]);
								return { content: [{ type: "text", text: "mock file result" }], details: {} };
							},
						});
					}
					pi.registerTool({
						name: "generic_composite",
						label: "generic composite",
						description: "Ordinary native tool calling other tools.",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => {
							for (const [name, path] of calls) {
								const outcome = await ctx.executeTool(name, { path });
								if (outcome.isError) throw new Error("Mock nested operation failed");
							}
							return { content: [{ type: "text", text: "RESULT_PROSE_NOT_FOR_SUMMARY" }], details: {} };
						},
					});
				},
			],
		});
		try {
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("generic_composite", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("Finished branch work"),
			]);
			await harness.session.prompt("Explore branch");
			expect(executed).toEqual(calls);
			const record = getToolResult(harness, "generic_composite");
			expect(record.nestedCalls?.complete).toBe(true);
			expect(record.nestedCalls?.calls.map((call) => [call.name, call.arguments?.path, call.status])).toEqual(
				calls.map(([name, path]) => [name, path, "ok"]),
			);
			const entries = harness.sessionManager.getBranch();
			expect(entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult")).toMatchObject(
				{
					message: { nestedCalls: record.nestedCalls },
				},
			);
			const prepared = prepareBranchEntries(entries, 100000);
			expect(prepared.messages.some((message) => message.role === "toolResult")).toBe(false);
			expect(computeFileLists(prepared.fileOps)).toMatchObject({
				readFiles: ["live-read.ts"],
				modifiedFiles: ["live-written.ts", "live-modified.ts"],
			});
			const { result, prompt } = await summarize(entries);
			expect(result.readFiles).toEqual(["live-read.ts"]);
			expect(result.modifiedFiles).toEqual(["live-written.ts", "live-modified.ts"]);
			expect(result.summary).toContain("<read-files>\nlive-read.ts\n</read-files>");
			expect(result.summary).toContain("<modified-files>\nlive-modified.ts\nlive-written.ts\n</modified-files>");
			expect(prompt).not.toContain("RESULT_PROSE_NOT_FOR_SUMMARY");
		} finally {
			// Do not invoke harness.cleanup(): it recursively deletes its scratch directory.
			harness.session.dispose();
			harness.faux.unregister();
		}
	});

	// PR #131 F20: historical results must be read without re-enabling any refused transport.
	it("retains historical read/edit/write metadata with repeated paths and the chronological recent-file cap", async () => {
		const entries = [messageEntry({ role: "user", content: "Historical branch", timestamp: 1 }, 0)];
		const reads: string[] = [];
		const modified: string[] = [];
		for (let i = 0; i < MAX_SUMMARY_FILES + 10; i++) {
			reads.push(`read-${i}.ts`);
			modified.push(`modified-${i}.ts`);
			entries.push(
				historicalResult(
					[
						["read", reads[i]],
						[i % 2 === 0 ? "write" : "edit", modified[i]],
					],
					i + 1,
				),
			);
		}
		entries.push(
			historicalResult(
				[
					["read", reads[0]],
					["edit", modified[0]],
					["write", modified[1]],
				],
				100,
			),
		);
		const expectedReads = [...reads.slice(11), reads[0]];
		const expectedModified = [...modified.slice(12), modified[0], modified[1]];
		const prepared = prepareBranchEntries(entries, 100000);
		expect(prepared.messages).toHaveLength(1);
		expect(computeFileLists(prepared.fileOps)).toEqual({
			readFiles: expectedReads,
			modifiedFiles: expectedModified,
			omittedReadFiles: 10,
			omittedModifiedFiles: 10,
		});
		const { result, prompt } = await summarize(entries);
		expect(result.readFiles).toEqual(expectedReads);
		expect(result.modifiedFiles).toEqual(expectedModified);
		expect(result.summary).toContain(
			`<read-files>\n${[...expectedReads].sort().join("\n")}\n(+10 earlier files omitted)\n</read-files>`,
		);
		expect(result.summary).toContain(
			`<modified-files>\n${[...expectedModified].sort().join("\n")}\n(+10 earlier files omitted)\n</modified-files>`,
		);
		expect(prompt).not.toContain("RESULT_PROSE_NOT_FOR_SUMMARY");
	});

	// PR #131 F20 control: preserve carried summaries, hook exclusion, and direct tool extraction.
	it("carries pi summary details, excludes hook details and keeps direct file calls", async () => {
		const entries: SessionEntry[] = [
			{
				type: "branch_summary",
				id: "s",
				parentId: null,
				timestamp: new Date(1).toISOString(),
				fromId: "old",
				summary: "Previous summary",
				details: { readFiles: ["carried.ts"], modifiedFiles: ["carried-edit.ts"] },
			},
			{
				type: "branch_summary",
				id: "h",
				parentId: "s",
				timestamp: new Date(2).toISOString(),
				fromId: "hook",
				summary: "Hook summary",
				fromHook: true,
				details: { readFiles: ["hook.ts"], modifiedFiles: ["hook-edit.ts"] },
			},
			messageEntry(
				fauxAssistantMessage([
					fauxToolCall("read", { path: "direct.ts" }),
					fauxToolCall("edit", { path: "direct-edit.ts" }),
				]),
				2,
			),
		];
		expect(computeFileLists(prepareBranchEntries(entries, 100000).fileOps)).toMatchObject({
			readFiles: ["carried.ts", "direct.ts"],
			modifiedFiles: ["carried-edit.ts", "direct-edit.ts"],
		});
		const { result, prompt } = await summarize(entries);
		expect(result.readFiles).toEqual(["carried.ts", "direct.ts"]);
		expect(result.modifiedFiles).toEqual(["carried-edit.ts", "direct-edit.ts"]);
		expect(prompt).toContain("Previous summary");
		expect(prompt).toContain("Hook summary");
	});
});
