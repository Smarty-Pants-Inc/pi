import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { runToolCall } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentTool, AgentToolResult } from "../src/types.ts";

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call", name: "echo", arguments: {} }],
	api: "openai-responses",
	provider: "openai",
	model: "mock",
	stopReason: "toolUse",
	timestamp: 1,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

// pi#254 / smarty-dev#4703: transform snapshots before public events and nested onUpdate callbacks.
describe.each(["sequential", "parallel", "nested"] as const)("%s tool snapshot isolation", (mode) => {
	async function run(
		tool: AgentTool,
		transformToolUpdate: AgentLoopConfig["transformToolUpdate"],
	): Promise<AgentToolResult<unknown>[]> {
		const updates: AgentToolResult<unknown>[] = [];
		if (mode === "nested") {
			await runToolCall(
				{ type: "toolCall", id: "call", name: "echo", arguments: {} },
				{
					tools: [tool],
					assistantMessage: assistant,
					context: { messages: [] },
					transformToolUpdate,
					onUpdate: (update) => {
						updates.push(update);
					},
				},
			);
		} else {
			const agent = new Agent({
				initialState: { tools: [tool] },
				toolExecution: mode,
				transformToolUpdate,
				streamFn: () => {
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "toolUse", message: { ...assistant } });
					return stream;
				},
			});
			agent.subscribe((event: AgentEvent) => {
				if (event.type === "tool_execution_update") updates.push(event.partialResult);
			});
			await agent.prompt("run");
		}
		return updates;
	}

	it("starts detaching synchronously and emits updates in order despite asynchronous transforms", async () => {
		let releaseFirst = () => {};
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const transformed: number[] = [];
		const tool: AgentTool = {
			name: "echo",
			label: "echo",
			description: "emits mutable snapshots",
			parameters: Type.Object({}),
			execute: async (_id, _args, _signal, onUpdate) => {
				const snapshot = { content: [{ type: "text" as const, text: "private-1" }], details: { index: 1 } };
				onUpdate?.(snapshot);
				snapshot.content[0].text = "private-2";
				snapshot.details.index = 2;
				onUpdate?.(snapshot);
				snapshot.content[0].text = "mutated-after-update";
				snapshot.details.index = 3;
				releaseFirst();
				return { content: [], details: undefined, terminate: true };
			},
		};
		const updates = await run(tool, async (call, args, partialResult) => {
			expect(call.id).toBe("call");
			expect(args).toEqual({});
			const index = (partialResult.details as { index: number }).index;
			transformed.push(index);
			const detached: AgentToolResult<unknown> = {
				content: [{ type: "text", text: `[REDACTED]-${index}` }],
				details: { index },
			};
			if (index === 1) await first;
			return detached;
		});
		expect(transformed).toEqual([1, 2]);
		expect(updates.map((update) => update.content)).toEqual([
			[{ type: "text", text: "[REDACTED]-1" }],
			[{ type: "text", text: "[REDACTED]-2" }],
		]);
		expect(updates.map((update) => update.details)).toEqual([{ index: 1 }, { index: 2 }]);
		expect(JSON.stringify(updates)).not.toContain("private");
	});

	// #3155 CR-5: absent and asynchronously undefined transforms still publish call-time snapshots.
	it.each(["absent", "undefined", "replacement"] as const)(
		"detaches mutable input before an await with an %s transform",
		async (transform) => {
			let release = () => {};
			const ready = new Promise<void>((resolve) => {
				release = resolve;
			});
			const tool: AgentTool = {
				name: "echo",
				label: "echo",
				description: "reuses one mutable progress result",
				parameters: Type.Object({}),
				execute: async (_id, _args, _signal, onUpdate) => {
					const partial = {
						content: [
							{ type: "text" as const, text: "first" },
							{ type: "image" as const, mimeType: "image/png", data: "first-image" },
						],
						details: { nested: { index: 1 } },
						structuredContent: { index: 1 },
					};
					onUpdate?.(partial);
					partial.content[0].text = "second";
					partial.content[1].data = "second-image";
					partial.details.nested.index = 2;
					partial.structuredContent.index = 2;
					onUpdate?.(partial);
					partial.content[0].text = "mutated after both updates";
					partial.details.nested.index = 3;
					partial.structuredContent.index = 3;
					release();
					return { content: [], details: undefined, terminate: true };
				},
			};
			const updates = await run(
				tool,
				transform === "absent"
					? undefined
					: async (_call, _args, snapshot) => {
							await ready;
							return transform === "undefined" ? undefined : snapshot;
						},
			);
			expect(updates.map((update) => update.content)).toEqual([
				[
					{ type: "text", text: "first" },
					{ type: "image", mimeType: "image/png", data: "first-image" },
				],
				[
					{ type: "text", text: "second" },
					{ type: "image", mimeType: "image/png", data: "second-image" },
				],
			]);
			expect(updates.map((update) => update.details)).toEqual([{ nested: { index: 1 } }, { nested: { index: 2 } }]);
			expect(updates.map((update) => update.structuredContent)).toEqual([{ index: 1 }, { index: 2 }]);
			expect(updates[0]).not.toBe(updates[1]);
		},
	);

	it("withholds both the partial and a credential-bearing transform error", async () => {
		const tool: AgentTool = {
			name: "echo",
			label: "echo",
			description: "emits private snapshots",
			parameters: Type.Object({}),
			execute: async (_id, _args, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "planted-secret" }], details: { secret: "planted-secret" } });
				return { content: [], details: undefined, terminate: true };
			},
		};
		const updates = await run(tool, async () => {
			throw new Error("handler failed with planted-secret");
		});
		expect(updates).toEqual([
			{
				content: [{ type: "text", text: "[REDACTED] Partial tool result withheld: handler failed" }],
				details: {},
			},
		]);
		expect(JSON.stringify(updates)).not.toContain("planted-secret");
	});
});

// pi#150 R2: explicit null is an override, not permission to retain a private value.
it.each([false, true])("preserves null-only redaction with content replacement=%s", async (replaceContent) => {
	const content = [{ type: "text" as const, text: "redacted" }];
	const echo: AgentTool = {
		name: "echo",
		label: "echo",
		description: "returns private structured content",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: "private" }],
			details: { value: "private" },
			structuredContent: { value: "private" },
		}),
	};
	for (const redaction of [
		{ structuredContent: null },
		{ details: null },
		{ structuredContent: null, details: null },
	]) {
		const afterResult = { ...redaction, ...(replaceContent ? { content } : {}) };
		const outcome = await runToolCall(
			{ type: "toolCall", id: "null", name: "echo", arguments: {} },
			{
				tools: [echo],
				assistantMessage: assistant,
				context: { messages: [] },
				afterToolCall: async () => afterResult,
			},
		);
		if ("structuredContent" in redaction) expect(outcome.result.structuredContent).toBeNull();
		if ("details" in redaction) expect(outcome.result.details).toBeNull();
		expect(outcome.result.content).toEqual(replaceContent ? content : [{ type: "text", text: "private" }]);
	}
});
