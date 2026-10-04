import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type { CompactionCompletionContext, ExtensionCommandContext } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// PR #131 NEW-P2-01: explicit callback joins exclude all callbacks, never external custody.
it.each([
	["onComplete", "waitForIdle"],
	["onComplete", "abort"],
	["onError", "waitForIdle"],
	["onError", "abort"],
] as const)("%s can await %s while external joins retain its continuation", async (callback, join) => {
	const entered = deferred();
	const releaseCycle = deferred();
	const finish = deferred();
	let innerResolved = false;
	let externalIdleResolved = false;
	let externalAbortResolved = false;
	let commandContext!: ExtensionCommandContext;
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.registerCommand("compact-self-join", {
					description: "Probe retained callback joins",
					handler: async (_args, ctx) => {
						commandContext = ctx;
					},
				});
				pi.on("session_before_compact", ({ preparation: { firstKeptEntryId, tokensBefore } }) => {
					if (callback === "onError") throw new Error("compaction failed");
					return { compaction: { summary: "compacted", firstKeptEntryId, tokensBefore } };
				});
			},
		],
	});
	let inner: Promise<void> | undefined;
	let externalIdle: Promise<void> | undefined;
	let externalAbort: Promise<void> | undefined;
	try {
		await harness.session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => harness.session.waitForIdle(),
				newSession: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			},
		});
		const command = harness.session.extensionRunner.getCommand("compact-self-join");
		if (!command) throw new Error("Command not registered");
		await command.handler("", harness.session.extensionRunner.createCommandContext());
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		commandContext.compact({
			[callback]: async (_result: unknown, owned: CompactionCompletionContext) => {
				entered.resolve();
				inner = (join === "waitForIdle" ? owned.waitForIdle() : owned.abort()).then(() => {
					innerResolved = true;
				});
				// Release a broken baseline cycle without orphaning any accepted work.
				await Promise.race([inner, releaseCycle.promise]);
				await finish.promise;
			},
		});
		await entered.promise;
		externalIdle = harness.session.waitForIdle().then(() => {
			externalIdleResolved = true;
		});
		externalAbort = harness.session.abort().then(() => {
			externalAbortResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		const observed = { innerResolved, externalIdleResolved, externalAbortResolved, idle: harness.session.isIdle };
		releaseCycle.resolve();
		finish.resolve();
		await Promise.all([inner, externalIdle, externalAbort]);
		expect(observed).toEqual({
			innerResolved: true,
			externalIdleResolved: false,
			externalAbortResolved: false,
			idle: false,
		});
		expect(harness.session.isIdle).toBe(true);
	} finally {
		releaseCycle.resolve();
		finish.resolve();
		await harness.session.abort();
		await Promise.all([inner, externalIdle, externalAbort]);
		harness.cleanup();
	}
});
