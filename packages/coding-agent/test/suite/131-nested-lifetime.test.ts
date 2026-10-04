import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const result = { content: [], details: {} };

// PR #131 P2-3: nested onUpdate promises are not discarded.
it("awaits and contains rejecting nested update observers before end", async () => {
	const entered = deferred();
	const release = deferred();
	let outcomeError = false;
	let observer = 0;
	let nestedEnded = false;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "parent",
					label: "parent",
					description: "parent",
					parameters: Type.Object({}),
					async execute(_id, _args, _signal, _update, ctx) {
						const outcome = await ctx.executeTool(
							"leaf",
							{},
							{
								onUpdate: async () => {
									if (++observer === 1) throw new Error("nested observer failed");
									entered.resolve();
									await release.promise;
								},
							},
						);
						outcomeError = outcome.isError;
						return result;
					},
				});
				pi.registerTool({
					name: "leaf",
					label: "leaf",
					description: "leaf",
					parameters: Type.Object({}),
					async execute(_id, _args, _signal, update) {
						update?.(result);
						update?.(result);
						return result;
					},
				});
				pi.on("tool_execution_end", (event) => {
					if (event.toolName === "leaf") nestedEnded = true;
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
		await entered.promise;
		await new Promise((resolve) => setTimeout(resolve, 10));
		const earlyEnd = nestedEnded;
		release.resolve();
		await prompt;
		expect(earlyEnd).toBe(false);
		expect(outcomeError).toBe(true);
	} finally {
		release.resolve();
		harness.cleanup();
	}
});

// PR #131 P2-1: retained contexts cannot reopen retired parent execution.
it("refuses retained parent admission even with a fresh override signal", async () => {
	let context!: ExtensionToolContext;
	let leafCalls = 0;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "parent",
					label: "parent",
					description: "parent",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						context = ctx;
						return result;
					},
				});
				pi.registerTool({
					name: "leaf",
					label: "leaf",
					description: "leaf",
					parameters: Type.Object({}),
					execute: async () => {
						leafCalls++;
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
		const outcome = await context.executeTool("leaf", {}, { signal: new AbortController().signal }).then(
			() => "accepted",
			() => "refused",
		);
		expect(outcome).toBe("refused");
		expect(leafCalls).toBe(0);
	} finally {
		harness.cleanup();
	}
});

it("composes child overrides with parent cancellation", async () => {
	const entered = deferred();
	const release = deferred();
	let childSignal!: AbortSignal;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "parent",
					label: "parent",
					description: "parent",
					parameters: Type.Object({}),
					async execute(_id, _args, _signal, _update, ctx) {
						await ctx.executeTool("leaf", {}, { signal: new AbortController().signal });
						return result;
					},
				});
				pi.registerTool({
					name: "leaf",
					label: "leaf",
					description: "leaf",
					parameters: Type.Object({}),
					async execute(_id, _args, signal) {
						childSignal = signal!;
						entered.resolve();
						await release.promise;
						return result;
					},
				});
			},
		],
	});
	try {
		harness.setResponses([fauxAssistantMessage(fauxToolCall("parent", {}), { stopReason: "toolUse" })]);
		const prompt = harness.session.prompt("go");
		await entered.promise;
		const abort = harness.session.abort();
		const cancelled = childSignal.aborted;
		release.resolve();
		await Promise.all([prompt, abort]);
		expect(cancelled).toBe(true);
	} finally {
		release.resolve();
		harness.cleanup();
	}
});

it("drains unawaited accepted children before parent result and prompt settlement", async () => {
	const entered = deferred();
	const release = deferred();
	let childFinished = false;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "parent",
					label: "parent",
					description: "parent",
					parameters: Type.Object({}),
					async execute(_id, _args, _signal, _update, ctx) {
						void ctx.executeTool("leaf", {});
						await entered.promise;
						return result;
					},
				});
				pi.registerTool({
					name: "leaf",
					label: "leaf",
					description: "leaf",
					parameters: Type.Object({}),
					async execute() {
						entered.resolve();
						await release.promise;
						childFinished = true;
						return result;
					},
				});
			},
		],
	});
	let settled = false;
	try {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("parent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("go").finally(() => {
			settled = true;
		});
		await entered.promise;
		await new Promise((resolve) => setTimeout(resolve, 20));
		const earlySettlement = settled;
		const earlyParentEnd = harness.eventsOfType("tool_execution_end").some((event) => !event.parentToolCallId);
		release.resolve();
		await prompt;
		// Join the original child even on RED, rather than leaving work behind the test.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(childFinished).toBe(true);
		expect(earlySettlement).toBe(false);
		expect(earlyParentEnd).toBe(false);
	} finally {
		release.resolve();
		harness.cleanup();
	}
});
