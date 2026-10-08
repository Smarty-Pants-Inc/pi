import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * A tool that calls other tools, built only on the extension API: its own name, exposure, loadout
 * hook, and ctx.executeTool(). Codemode and tool search use the same mechanisms.
 */
function orchestratorExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "echo",
		label: "echo",
		description: "Echo text.",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id, { text }) => ({ content: [{ type: "text", text: `echo: ${text}` }], details: {} }),
	});
	pi.registerTool({
		name: "helper",
		label: "helper",
		description: "Only reachable from other tools.",
		parameters: Type.Object({}),
		exposure: "codemode",
		execute: async () => ({ content: [{ type: "text", text: "helped" }], details: {} }),
	});
	pi.registerTool({
		name: "run_tools",
		label: "run_tools",
		description: "Runs tools.",
		parameters: Type.Object({}),
		exposure: "model-only",
		prepareLoadout: (loadout) => ({
			descriptions: {
				run_tools: `Runs tools: ${loadout.callable.map((tool) => tool.name).join(", ")}`,
				echo: "Echo text (also callable from run_tools).",
			},
			hiddenDeclarations: ["echo"],
		}),
		execute: async (_id, _params, _signal, _onUpdate, ctx) => {
			const helper = await ctx.executeTool("helper", {});
			const echo = await ctx.executeTool("echo", { text: "hi" });
			const self = await ctx.executeTool("run_tools", {});
			const text = [helper, echo, self]
				.map((outcome) => (outcome.result.content[0] as { text: string }).text)
				.join(" | ");
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}

describe("AgentSession tool orchestration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("supports tools that call other tools under any name through the extension API", async () => {
		const toolCalls: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				orchestratorExtension,
				(pi) => {
					pi.on("tool_call", (event) => {
						toolCalls.push(`${event.toolName}:${event.parentToolCallId ?? "top"}`);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		expect(harness.session.getActiveToolNames()).toEqual(["echo", "run_tools"]);
		expect(harness.session.getCallableToolNames()).toEqual(["echo", "helper"]);
		const find = (name: string) => harness.session.agent.state.tools.find((tool) => tool.name === name);
		expect(find("run_tools")?.description).toBe("Runs tools: echo, helper");
		expect(find("echo")?.description).toBe("Echo text (also callable from run_tools).");

		const requestTools: string[][] = [];
		harness.setResponses([
			(context: TranscriptContext) => {
				requestTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage([fauxToolCall("run_tools", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		// echo stays active, but its declaration is left out of requests.
		expect(requestTools[0]).toEqual(["run_tools"]);
		const result = harness.session.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		if (!result) throw new Error("No tool result");
		expect(result.content).toEqual([
			{
				type: "text",
				text: "helped | echo: hi | Tool run_tools not found. Available tools in this session: echo, run_tools",
			},
		]);
		const parent = result.toolCallId;
		expect(toolCalls).toEqual(["run_tools:top", `helper:${parent}`, `echo:${parent}`]);
		expect(result.nestedCalls?.calls.map((call) => [call.id, call.name, call.status])).toEqual([
			[`${parent}/1`, "helper", "ok"],
			[`${parent}/2`, "echo", "ok"],
			[`${parent}/3`, "run_tools", "error"],
		]);
		// The record is persisted with the session.
		const persisted = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(persisted?.type === "message" && persisted.message).toMatchObject({ nestedCalls: result.nestedCalls });
	});

	it("joins fire-and-forget native children before persisting complete parent provenance", async () => {
		let retained: ExtensionToolContext | undefined;
		let child: Promise<unknown> | undefined;
		let effects = 0;
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "child",
						label: "Child",
						description: "Native child",
						parameters: Type.Object({}),
						execute: async () => {
							await new Promise((resolve) => setTimeout(resolve, 20));
							effects++;
							return { content: [], details: {} };
						},
					});
					pi.registerTool({
						name: "parent",
						label: "Parent",
						description: "Native parent",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => {
							retained = ctx;
							child = ctx.executeTool("child", {});
							return { content: [], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		try {
			await harness.session.prompt("go");
			const result = harness.session.messages.find((message) => message.role === "toolResult");
			expect(result).toMatchObject({ nestedCalls: { complete: true, calls: [{ name: "child", status: "ok" }] } });
			expect(effects).toBe(1);
			await expect(retained!.executeTool("child", {})).rejects.toThrow(/closed|settled/i);
			expect(effects).toBe(1);
			const persisted = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
			expect(persisted?.type === "message" && persisted.message).toMatchObject({ nestedCalls: { complete: true } });
		} finally {
			await child;
		}
	});

	// Dormant until reviewed re-enable: smarty-dev#4506 (pi#131 cutoff)
	it.skip("registers codemode and tool_search inactive until they are named", async () => {
		const extensionFactories = [createCodemodeExtension(), createToolSearchExtension()];
		const plain = await createHarness({ extensionFactories });
		harnesses.push(plain);
		expect(plain.session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["codemode", "tool_search"]),
		);
		expect(plain.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);

		// --tools and the defaultTools setting name them explicitly.
		const allowed = await createHarness({ allowedToolNames: ["read", "codemode"], extensionFactories });
		harnesses.push(allowed);
		expect(allowed.session.getActiveToolNames()).toEqual(["read", "codemode"]);
		const initial = await createHarness({ initialActiveToolNames: ["tool_search"], extensionFactories });
		harnesses.push(initial);
		expect(initial.session.getActiveToolNames()).toEqual(["tool_search"]);
	});

	// pi#150 review R1: nested calls go through the public session.agent hooks, as model-issued calls do.
	it("applies a public deny and a public redactor to nested calls, keeping parent attribution", async () => {
		const extensionCalls: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				orchestratorExtension,
				(pi) => {
					pi.on("tool_call", (event) => {
						extensionCalls.push(`call ${event.toolName}:${event.parentToolCallId ?? "top"}`);
					});
					pi.on("tool_result", (event) => {
						extensionCalls.push(`result ${event.toolName}:${event.parentToolCallId ?? "top"}`);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const agent = harness.session.agent;
		const before = agent.beforeToolCall;
		const after = agent.afterToolCall;
		const publicCalls: string[] = [];
		agent.beforeToolCall = async (context, signal) => {
			publicCalls.push(`before ${context.toolCall.name}`);
			if (context.toolCall.name === "helper") return { block: true, reason: "denied by SDK" };
			return before?.(context, signal);
		};
		agent.afterToolCall = async (context, signal) => {
			publicCalls.push(`after ${context.toolCall.name}`);
			const inner = await after?.(context, signal);
			if (context.toolCall.name === "echo") return { ...inner, content: [{ type: "text", text: "[redacted]" }] };
			return inner;
		};

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("run_tools", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		const result = harness.session.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		if (!result) throw new Error("No tool result");
		const text = (result.content[0] as { text: string }).text;
		expect(text.split(" | ").slice(0, 2)).toEqual(["denied by SDK", "[redacted]"]);
		expect(text).not.toContain("helped");
		expect(text).not.toContain("echo: hi");
		expect(publicCalls).toEqual([
			"before run_tools",
			"before helper",
			"before echo",
			"after echo",
			"after run_tools",
		]);
		const parent = result.toolCallId;
		expect(extensionCalls).toEqual([
			"call run_tools:top",
			`call echo:${parent}`,
			`result echo:${parent}`,
			"result run_tools:top",
		]);
	});

	// pi#150 review R6: tool results are left out of the summary prose, but their nested calls name files.
	it("keeps the files of nested read, edit and write calls in a branch summary", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "edit", "write"],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "files",
						label: "files",
						description: "Touches files through other tools.",
						parameters: Type.Object({}),
						execute: async (_id, _params, _signal, _onUpdate, ctx) => {
							const outcomes = [
								await ctx.executeTool("read", { path: "nested-read.txt" }),
								await ctx.executeTool("edit", {
									path: "nested-edit.txt",
									edits: [{ oldText: "old", newText: "new" }],
								}),
								await ctx.executeTool("write", { path: "nested-write.txt", content: "written" }),
							];
							const failed = outcomes.filter((outcome) => outcome.isError).length;
							return { content: [{ type: "text", text: `failed: ${failed}` }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		writeFileSync(join(harness.tempDir, "nested-read.txt"), "read me");
		writeFileSync(join(harness.tempDir, "nested-edit.txt"), "old");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("files", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("## Goal\nexplored files"),
		]);
		await harness.session.prompt("go");
		const result = harness.session.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(result?.content).toEqual([{ type: "text", text: "failed: 0" }]);

		const firstUser = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!firstUser) throw new Error("No user entry");
		const navigation = await harness.session.navigateTree(firstUser.id, { summarize: true });
		expect(navigation.summaryEntry?.details).toMatchObject({
			readFiles: ["nested-read.txt"],
			modifiedFiles: expect.arrayContaining(["nested-edit.txt", "nested-write.txt"]),
		});
	});

	it("leaves results without nested calls unchanged", async () => {
		const harness = await createHarness({ initialActiveToolNames: [], extensionFactories: [orchestratorExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result && "nestedCalls" in result).toBe(false);
	});
});
