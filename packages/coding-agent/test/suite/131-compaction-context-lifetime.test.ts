import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import type { CompactionCompletionContext } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function pause() {
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
}
async function setup(failed = false) {
	const h = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", ({ preparation: { firstKeptEntryId, tokensBefore } }) =>
					failed ? { cancel: true } : { compaction: { summary: "au3-lifetime", firstKeptEntryId, tokensBefore } },
				);
			},
		],
	});
	h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	await h.session.prompt("one");
	await h.session.prompt("two");
	return h;
}

// pi#131: verify normal expiry, including error callback tokens and both public join methods.
it.each([
	["onComplete", "waitForIdle"],
	["onComplete", "abort"],
	["onError", "waitForIdle"],
	["onError", "abort"],
] as const)("settled %s token is an external %s join", async (callback, join) => {
	const h = await setup(callback === "onError");
	const laterEntered = gate(),
		laterFinish = gate();
	let saved!: CompactionCompletionContext;
	let joined = false,
		pending: Promise<void> | undefined;
	const ctx = h.session.extensionRunner.createContext();
	try {
		ctx.compact({
			[callback]: (_value: unknown, owned: CompactionCompletionContext) => {
				saved = owned;
			},
		});
		await h.session.waitForIdle();
		ctx.compact({
			onError: async () => {
				laterEntered.resolve();
				await laterFinish.promise;
			},
		});
		await laterEntered.promise;
		pending = saved[join]().then(() => {
			joined = true;
		});
		await pause();
		const observed = { callback, join, joined, idle: h.session.isIdle };
		laterFinish.resolve();
		await pending;
		await h.session.waitForIdle();
		expect(observed).toMatchObject({ joined: false, idle: false });
	} finally {
		laterFinish.resolve();
		await pending;
		await h.session.abort();
		h.cleanup();
	}
});

// pi#131: a pending exempted join must not carry its ownership beyond its callback's return.
it("pending owned idle join does not outlive its returned callback token", async () => {
	const ownerEntered = gate(),
		launchOwned = gate(),
		pendingStarted = gate(),
		returnOwner = gate();
	const operationEntered = gate(),
		operationRelease = gate(),
		secondEntered = gate(),
		secondFinish = gate();
	let attempts = 0,
		ownerReturned = false,
		pendingJoined = false,
		expiredJoined = false,
		externalJoined = false;
	let saved!: CompactionCompletionContext;
	let pending: Promise<void> | undefined, expired: Promise<void> | undefined, external: Promise<void> | undefined;
	const h = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async ({ preparation: { firstKeptEntryId, tokensBefore } }) => {
					if (++attempts === 2) {
						operationEntered.resolve();
						await operationRelease.promise;
					}
					return { compaction: { summary: "au3-pending-join", firstKeptEntryId, tokensBefore } };
				});
			},
		],
	});
	const ctx = h.session.extensionRunner.createContext();
	try {
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await h.session.prompt("one");
		await h.session.prompt("two");
		ctx.compact({
			onComplete: async (_result, owned) => {
				saved = owned;
				ownerEntered.resolve();
				await launchOwned.promise;
				pending = owned.waitForIdle().then(() => {
					pendingJoined = true;
				});
				pendingStarted.resolve();
				// The owner's timeout/cancellation branch returns before this operation-only join finishes.
				await returnOwner.promise;
				ownerReturned = true;
			},
		});
		await ownerEntered.promise;
		h.appendResponses([fauxAssistantMessage("three"), fauxAssistantMessage("four")]);
		await h.session.prompt("three");
		await h.session.prompt("four");
		ctx.compact({
			onComplete: async () => {
				secondEntered.resolve();
				await secondFinish.promise;
			},
		});
		await operationEntered.promise;
		launchOwned.resolve();
		await pendingStarted.promise;
		returnOwner.resolve();
		await pause();
		// This new call proves the saved token has actually expired before we release real work.
		expired = saved.waitForIdle().then(() => {
			expiredJoined = true;
		});
		external = h.session.waitForIdle().then(() => {
			externalJoined = true;
		});
		operationRelease.resolve();
		await secondEntered.promise;
		await pause();
		const observed = { ownerReturned, pendingJoined, expiredJoined, externalJoined, idle: h.session.isIdle };
		secondFinish.resolve();
		await Promise.all([pending, expired, external]);
		await h.session.waitForIdle();
		expect(observed).toEqual({
			ownerReturned: true,
			pendingJoined: false,
			expiredJoined: false,
			externalJoined: false,
			idle: false,
		});
	} finally {
		launchOwned.resolve();
		returnOwner.resolve();
		operationRelease.resolve();
		secondFinish.resolve();
		await Promise.all([pending, expired, external]);
		await h.session.abort();
		h.cleanup();
	}
});

// pi#131: the onComplete invocation has returned/rejected before the onError invocation begins.
it.each(["waitForIdle", "abort"] as const)(
	"returned onComplete token must not exempt an unrelated %s during error handling",
	async (join) => {
		const h = await setup();
		const errorEntered = gate(),
			errorFinish = gate();
		let saved!: CompactionCompletionContext;
		let joined = false,
			externalDone = false;
		const joins: Promise<void>[] = [];
		try {
			h.session.extensionRunner.createContext().compact({
				onComplete: (_result, owned) => {
					saved = owned;
					throw new Error("callback failed after capture");
				},
				onError: async (_error, owned) => {
					await owned.waitForIdle();
					errorEntered.resolve();
					await errorFinish.promise;
				},
			});
			await errorEntered.promise;
			joins.push(
				saved[join]().then(() => {
					joined = true;
				}),
			);
			joins.push(
				h.session.waitForIdle().then(() => {
					externalDone = true;
				}),
			);
			await pause();
			const observed = { join, joined, externalDone, idle: h.session.isIdle };
			errorFinish.resolve();
			await Promise.all(joins);
			await h.session.waitForIdle();
			expect(observed).toMatchObject({ joined: false, externalDone: false, idle: false });
		} finally {
			errorFinish.resolve();
			await Promise.all(joins);
			await h.session.abort();
			h.cleanup();
		}
	},
);

// pi#131: an options evaluation failure can invoke onError before the completion promise is assigned.
it.each(["waitForIdle", "abort"] as const)(
	"synchronous options failure supplies usable onError %s token",
	async (join) => {
		const h = await createHarness();
		const entered = gate(),
			finish = gate();
		let joined = false,
			failure: string | undefined,
			original: string | undefined,
			externalJoined = false;
		let external: Promise<void> | undefined;
		try {
			h.session.extensionRunner.createContext().compact({
				get customInstructions(): string {
					throw new Error("instructions resolver failed");
				},
				onError: async (error, owned) => {
					original = error.message;
					try {
						await owned[join]();
						joined = true;
					} catch (cause) {
						failure = String(cause);
					}
					entered.resolve();
					await finish.promise;
				},
			});
			await entered.promise;
			external = h.session.waitForIdle().then(() => {
				externalJoined = true;
			});
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			const observed = { join, joined, failure, original, externalJoined, idle: h.session.isIdle };
			finish.resolve();
			await external;
			expect(observed).toMatchObject({
				joined: true,
				failure: undefined,
				original: "instructions resolver failed",
				externalJoined: false,
				idle: false,
			});
		} finally {
			finish.resolve();
			await external;
			await h.session.abort();
			h.cleanup();
		}
	},
);
