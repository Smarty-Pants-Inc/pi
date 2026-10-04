import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const result = { content: [], details: {} };

// PR #131 P2-2: shared children must participate in exclusivity through end delivery.
it.each(["shared", "exclusive"])("keeps a %s sibling outside the writer's execute and end lease", async (mode) => {
	const writerStarted = deferred();
	const releaseWriter = deferred();
	const endStarted = deferred();
	const releaseEnd = deferred();
	let siblingStarted = false;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "parent",
					label: "parent",
					description: "parent",
					parameters: Type.Object({}),
					executionMode: "sequential",
					async execute(_id, _args, _signal, _update, ctx) {
						const writer = ctx.executeTool("writer", {});
						await writerStarted.promise;
						const sibling = ctx.executeTool("sibling", {});
						await Promise.all([writer, sibling]);
						return result;
					},
				});
				pi.registerTool({
					name: "writer",
					label: "writer",
					description: "writer",
					parameters: Type.Object({}),
					executionMode: "sequential",
					async execute() {
						writerStarted.resolve();
						await releaseWriter.promise;
						return result;
					},
				});
				pi.registerTool({
					name: "sibling",
					label: "sibling",
					description: "sibling",
					parameters: Type.Object({}),
					executionMode: mode === "exclusive" ? "sequential" : "parallel",
					async execute() {
						siblingStarted = true;
						return result;
					},
				});
				pi.on("tool_execution_end", async (event) => {
					if (event.toolName === "writer") {
						endStarted.resolve();
						await releaseEnd.promise;
					}
				});
			},
		],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("parent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("go");
		await writerStarted.promise;
		await new Promise((resolve) => setTimeout(resolve, 10));
		const overlapExecute = siblingStarted;
		releaseWriter.resolve();
		await endStarted.promise;
		await new Promise((resolve) => setTimeout(resolve, 10));
		const overlapEnd = siblingStarted;
		releaseEnd.resolve();
		await prompt;
		expect(siblingStarted).toBe(true);
		expect(overlapExecute).toBe(false);
		expect(overlapEnd).toBe(false);
	} finally {
		releaseWriter.resolve();
		releaseEnd.resolve();
		harness.cleanup();
	}
});

it("does not exempt conflicting grandchildren of an exclusive nested parent", async () => {
	let active = 0;
	let maxActive = 0;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "parent",
					label: "parent",
					description: "parent",
					parameters: Type.Object({}),
					executionMode: "sequential",
					async execute(_id, _args, _signal, _update, ctx) {
						await ctx.executeTool("middle", {});
						return result;
					},
				});
				pi.registerTool({
					name: "middle",
					label: "middle",
					description: "middle",
					parameters: Type.Object({}),
					executionMode: "sequential",
					async execute(_id, _args, _signal, _update, ctx) {
						await Promise.all([ctx.executeTool("worker", {}), ctx.executeTool("worker", {})]);
						return result;
					},
				});
				pi.registerTool({
					name: "worker",
					label: "worker",
					description: "worker",
					parameters: Type.Object({}),
					executionMode: "sequential",
					async execute() {
						active++;
						maxActive = Math.max(maxActive, active);
						await new Promise((resolve) => setTimeout(resolve, 10));
						active--;
						return result;
					},
				});
			},
		],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("parent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(maxActive).toBe(1);
	} finally {
		harness.cleanup();
	}
});

it("refuses conflicting shared-to-exclusive reentry instead of overlapping direct shared work or deadlocking", async () => {
	const directEntered = deferred();
	const releaseDirect = deferred();
	let leafCalls = 0;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "parent",
					label: "parent",
					description: "parent",
					parameters: Type.Object({}),
					async execute(_id, _args, _signal, _update, ctx) {
						await directEntered.promise;
						await ctx.executeTool("leaf", {});
						return result;
					},
				});
				pi.registerTool({
					name: "direct",
					label: "direct",
					description: "direct",
					parameters: Type.Object({}),
					async execute() {
						directEntered.resolve();
						await releaseDirect.promise;
						return result;
					},
				});
				pi.registerTool({
					name: "leaf",
					label: "leaf",
					description: "leaf",
					parameters: Type.Object({}),
					executionMode: "sequential",
					async execute() {
						leafCalls++;
						return result;
					},
				});
			},
		],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {}), fauxToolCall("direct", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("go");
		await directEntered.promise;
		await new Promise((resolve) => setTimeout(resolve, 20));
		const parentEnd = harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "parent");
		releaseDirect.resolve();
		await prompt;
		expect(leafCalls).toBe(0);
		expect(parentEnd).toMatchObject({
			isError: true,
			result: { content: [{ type: "text", text: "TOOL_QUEUE_CONFLICTING_REENTRY" }] },
		});
	} finally {
		releaseDirect.resolve();
		harness.cleanup();
	}
});

// PR #131 P2-2: pin the receiving definition, not only a closure that rereads it.
it.each(["extension", "sdk"])("pins the native %s receiver across authorization", async (route) => {
	const calls: string[] = [];
	const native: ToolDefinition = {
		name: "native",
		label: "native",
		description: "native",
		parameters: Type.Object({}),
		execute: async () => {
			calls.push("authorized");
			return result;
		},
	};
	const sdk: AgentTool = {
		name: "native",
		label: "native",
		description: "native",
		parameters: Type.Object({}),
		execute: async () => {
			calls.push("authorized");
			return result;
		},
	};
	const harness = await createHarness(
		route === "sdk"
			? { tools: [sdk] }
			: {
					extensionFactories: [
						(pi) => {
							pi.registerTool(native);
						},
					],
				},
	);
	try {
		const before = harness.session.agent.beforeToolCall;
		harness.session.agent.beforeToolCall = async (context, signal) => {
			const decision = await before?.(context, signal);
			native.execute = async () => {
				calls.push("replacement");
				return result;
			};
			sdk.execute = async () => {
				calls.push("replacement");
				return result;
			};
			return decision;
		};
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("native", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(calls).toEqual(["authorized"]);
	} finally {
		harness.cleanup();
	}
});
