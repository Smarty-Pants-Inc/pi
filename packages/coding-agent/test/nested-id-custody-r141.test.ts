import { type AgentToolResult, ToolCallQueue } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import { NestedToolCallRunner } from "../src/core/nested-tool-calls.ts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
// pi#141 / security F4/F18: a provider ID may equal another parent's display descendant ID.
it("refuses descendant-ID collision without replacing another invocation's join custody", async () => {
	const queue = new ToolCallQueue();
	const parentStarted = gate();
	const parentRelease = gate();
	const nativeStarted = gate();
	const nativeRelease = gate();
	let executions = 0;
	const runner = new NestedToolCallRunner({
		queue,
		getTools: () => [],
		isSequential: () => false,
		emit: async () => {},
		runToolCall: async (toolCall) => {
			executions++;
			nativeStarted.resolve();
			await nativeRelease.promise;
			return {
				toolCall,
				isError: false,
				result: {
					content: [{ type: "text", text: "accepted outcome" }],
					details: {},
				} satisfies AgentToolResult<unknown>,
			};
		},
	});
	runner.open("parent");
	runner.open("parent/1");
	const secondParent = queue.run({ id: "parent/1", exclusive: false }, async () => {
		parentStarted.resolve();
		await parentRelease.promise;
	});
	await parentStarted.promise;
	const acceptedDescendant = runner.execute("parent/1", "native", {});
	await nativeStarted.promise;
	try {
		await expect(runner.execute("parent", "native", {})).rejects.toThrow();
		let retired = false;
		const close = runner.close("parent/1").then(() => {
			retired = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(retired).toBe(false);
		nativeRelease.resolve();
		await acceptedDescendant;
		await close;
		expect(executions).toBe(1);
		expect(runner.takeRecord("parent/1")?.calls?.calls[0].status).toBe("ok");
	} finally {
		nativeRelease.resolve();
		parentRelease.resolve();
		await acceptedDescendant.catch(() => {});
		await secondParent;
		await runner.clear().catch(() => {});
	}
});
