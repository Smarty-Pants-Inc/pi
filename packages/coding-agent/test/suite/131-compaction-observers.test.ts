import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// PR #131 P2-3: callback continuations remain owned through rejection and idle settlement.
it("owns and contains async compaction completion and error observers", async () => {
	let context!: ExtensionContext;
	const completed = deferred();
	const allowCompletion = deferred();
	const errored = deferred();
	const allowError = deferred();
	const errors: string[] = [];
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("agent_end", (_event, ctx) => {
					context = ctx;
				});
				pi.on("session_before_compact", ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
					compaction: { summary: "compacted", firstKeptEntryId, tokensBefore },
				}));
			},
		],
	});
	try {
		harness.session.extensionRunner.onError((error) => {
			errors.push(error.error);
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		context.compact({
			async onComplete() {
				completed.resolve();
				await allowCompletion.promise;
				throw new Error("completion observer failed");
			},
			async onError() {
				errored.resolve();
				await allowError.promise;
				throw new Error("error observer failed");
			},
		});
		await completed.promise;
		const idleDuringCompletion = harness.session.isIdle;
		allowCompletion.resolve();
		// If onComplete is discarded, onError will never run. Keep this probe bounded.
		await Promise.race([errored.promise, new Promise((resolve) => setTimeout(resolve, 50))]);
		const idleDuringError = harness.session.isIdle;
		allowError.resolve();
		await harness.session.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleDuringCompletion).toBe(false);
		expect(idleDuringError).toBe(false);
		expect(errors).toContain("error observer failed");
	} finally {
		allowCompletion.resolve();
		allowError.resolve();
		harness.cleanup();
	}
});

// PR #131 P2-3: synchronous callback and error-reporting observers are also contained.
it("contains throwing compaction completion, error and reporting callbacks", async () => {
	let context!: ExtensionContext;
	const errors: string[] = [];
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("agent_end", (_event, ctx) => {
					context = ctx;
				});
				pi.on("session_before_compact", ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
					compaction: { summary: "compacted", firstKeptEntryId, tokensBefore },
				}));
			},
		],
	});
	try {
		harness.session.extensionRunner.onError((error) => {
			errors.push(error.error);
			throw new Error("reporting failed");
		});
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		context.compact({
			onComplete() {
				throw new Error("completion failed");
			},
			onError() {
				throw new Error("error callback failed");
			},
		});
		await harness.session.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(errors).toEqual(["error callback failed"]);
		expect(harness.session.isIdle).toBe(true);
	} finally {
		harness.cleanup();
	}
});
