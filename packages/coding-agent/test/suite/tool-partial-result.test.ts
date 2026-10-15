// smarty-dev#13239 Decision C: E2E-8976 lacks a real-model/partial-update/session-file driver; the offline harness guards this data-safety boundary now.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const SECRET = "0123456789abcdefghijklmnopqrstuvwxyzABCD";

describe("partial tool result redaction", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
	});

	it.each(["parallel", "sequential"] as const)("guards every update consumer in %s execution", async (mode) => {
		const observed: unknown[] = [];
		const nestedUpdates: unknown[] = [];
		const agentEvents: unknown[] = [];
		const sessionEvents: unknown[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					// An observer registered before the guard must still see only sanitized events.
					pi.on("tool_execution_update", (event) => {
						observed.push(event);
					});
					pi.on("tool_partial_result", (event) => ({
						partialResult: {
							content: [{ type: "text", text: `[REDACTED] ${event.toolCallId}` }],
							details: undefined,
							structuredContent: { safe: true },
						},
					}));
					pi.registerTool({
						name: "stream_secret",
						label: "Stream",
						description: "Stream synthetic output",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, onUpdate) => {
							onUpdate?.({
								content: [{ type: "text", text: SECRET.slice(0, 12) }],
								details: {},
								structuredContent: { value: SECRET },
							});
							onUpdate?.({ content: [{ type: "text", text: SECRET }], details: {} });
							return { content: [{ type: "text", text: "safe final" }], details: {} };
						},
					});
					pi.registerTool({
						name: "parent",
						label: "Parent",
						description: "Call nested tool",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _onUpdate, ctx) => {
							await ctx.executeTool(
								"stream_secret",
								{},
								{
									onUpdate: (partial) => {
										nestedUpdates.push(partial);
									},
								},
							);
							return { content: [{ type: "text", text: "safe parent" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.session.agent.toolExecution = mode;
		harness.session.agent.subscribe((event) => {
			agentEvents.push(event);
		});
		harness.session.subscribe((event) => {
			sessionEvents.push(event);
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("stream_secret", {}), fauxToolCall("parent", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(observed).toHaveLength(4);
		expect(nestedUpdates).toHaveLength(2);
		expect(agentEvents.filter((event) => (event as { type: string }).type === "tool_execution_update")).toHaveLength(
			2,
		);
		expect(
			sessionEvents.filter((event) => (event as { type: string }).type === "tool_execution_update"),
		).toHaveLength(4);
		const all = JSON.stringify([
			observed,
			nestedUpdates,
			agentEvents,
			sessionEvents,
			harness.sessionManager.getBranch(),
		]);
		expect(all).toContain("[REDACTED]");
		expect(all).not.toContain(SECRET.slice(0, 12));
		expect(all).not.toContain(SECRET);
	});

	it.each(["turn", "shutdown"] as const)("withholds held partials on %s cancellation", async (kind) => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const received: unknown[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					pi.on("tool_partial_result", async (event) => {
						entered();
						await held;
						return { partialResult: event.partialResult };
					});
					pi.registerTool({
						name: "held_stream",
						label: "Held stream",
						description: "Stream synthetic output through a held transform",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, onUpdate) => {
							onUpdate?.({ content: [{ type: "text", text: SECRET }], details: { secret: SECRET } });
							return { content: [{ type: "text", text: "safe final" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.session.subscribe((event) => {
			received.push(event);
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("held_stream", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("go");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await started;
			if (kind === "shutdown") harness.session.cancelForShutdown();
			await Promise.race([
				harness.session.abort(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("partial transform did not stop on cancellation")), 2000);
				}),
			]);
		} finally {
			clearTimeout(timer);
			release();
			await prompt;
		}
		const serialized = JSON.stringify([received, harness.sessionManager.getBranch()]);
		expect(serialized).toContain("Partial tool result withheld");
		expect(serialized).not.toContain(SECRET);
	});

	it("withholds throwing partial handlers on both direct and nested paths", async () => {
		const received: unknown[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					pi.on("tool_partial_result", async () => {
						throw new Error(SECRET);
					});
					pi.registerTool({
						name: "leaf",
						label: "Leaf",
						description: "Leaf",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, onUpdate) => {
							onUpdate?.({
								content: [{ type: "text", text: SECRET }],
								details: { secret: SECRET },
								structuredContent: SECRET,
							});
							return { content: [], details: {} };
						},
					});
					pi.registerTool({
						name: "parent",
						label: "Parent",
						description: "Parent",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _onUpdate, ctx) => {
							await ctx.executeTool(
								"leaf",
								{},
								{
									onUpdate: (value) => {
										received.push(value);
									},
								},
							);
							return { content: [], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.session.subscribe((event) => {
			received.push(event);
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("leaf", {}), fauxToolCall("parent", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(JSON.stringify(received)).toContain("[REDACTED]");
		expect(JSON.stringify(received)).not.toContain(SECRET.slice(0, 12));
	});
});
