import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { defineDoc, GenerationTask } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { chatSetup, openChat } from "./chat-support.ts";
import { addHooks } from "./harness-support.ts";
import { ControlledStorage, context, flush } from "./session-support.ts";
import { deferred } from "./task-support.ts";

// PR #141 cut #11: deletion-free copy of the hosted final-boundary scheduling fixture.
it("reads queue modes at the final boundary without waiting on its own held Session line", async () => {
	const setup = chatSetup();
	const reached = deferred();
	const answerRelease = deferred();
	setup.faux.setResponses([
		async () => {
			reached.resolve();
			await answerRelease.promise;
			return fauxAssistantMessage("first");
		},
		fauxAssistantMessage("both"),
	]);
	const yielded = deferred();
	const yieldRelease = deferred();
	addHooks(setup.registry, GenerationTask, {
		onYield: async () => {
			yielded.resolve();
			await yieldRelease.promise;
		},
	});
	const storage = new ControlledStorage();
	const { harness, root } = await openChat(storage, setup);
	await root.submit({ type: "input", content: "a" }, context);
	await reached.promise;
	const f1 = await root.submit({ type: "input", content: "f1" }, context);
	const f2 = await root.submit({ type: "input", content: "f2" }, context);
	answerRelease.resolve();
	await yielded.promise;
	const held = storage.holdCommits();
	const Marker = defineDoc<{ n: number }>({
		kind: "test.marker",
		version: 1,
		scope: "session",
		initial: () => ({ n: 0 }),
	});
	const occupying = root.commit(async (tx) => void (await tx.doc(Marker)).n++, context);
	await held.entered;
	yieldRelease.resolve();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reachedYield = false;
	try {
		reachedYield = await Promise.race([
			yielded.promise.then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), 250);
			}),
		]);
		await flush();
		setup.settings.followUpMode = "all";
	} finally {
		clearTimeout(timer);
		yieldRelease.resolve();
		held.release();
		await occupying;
	}
	try {
		const settled = await f2.wait(context);
		expect(await f1.status(context)).toEqual({ ...settled, id: f1.id, entry: expect.any(Number) });
		expect(setup.faux.state.callCount).toBe(2);
		expect(reachedYield, "fixture waits for onYield behind its own held line").toBe(true);
	} finally {
		await harness.close(context);
	}
});
