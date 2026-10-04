import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import type { CompactionCompletionContext, ExtensionRunner } from "../../src/core/extensions/index.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, createTestUiContext } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// pi#131 AU2-P2-01: owned idle excludes callbacks, not a later real compaction operation.
it("callback-owned idle still joins real nested compaction work", async () => {
	const parentEntered = deferred(),
		operationEntered = deferred(),
		operationRelease = deferred(),
		finish = deferred();
	let owned!: CompactionCompletionContext;
	let attempts = 0,
		joined = false,
		externalJoined = false;
	const h = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async ({ preparation: { firstKeptEntryId, tokensBefore } }) => {
					if (++attempts === 2) {
						operationEntered.resolve();
						await operationRelease.promise;
					}
					return { compaction: { summary: "owned-work", firstKeptEntryId, tokensBefore } };
				});
			},
		],
	});
	let idle: Promise<void> | undefined, external: Promise<void> | undefined;
	try {
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await h.session.prompt("one");
		await h.session.prompt("two");
		const ctx = h.session.extensionRunner.createContext();
		ctx.compact({
			onComplete: async (_result, completion) => {
				owned = completion;
				parentEntered.resolve();
				await finish.promise;
			},
		});
		await parentEntered.promise;
		h.appendResponses([fauxAssistantMessage("three"), fauxAssistantMessage("four")]);
		await h.session.prompt("three");
		await h.session.prompt("four");
		ctx.compact();
		await operationEntered.promise;
		idle = owned.waitForIdle().then(() => {
			joined = true;
		});
		external = h.session.waitForIdle().then(() => {
			externalJoined = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.session.isCompacting).toBe(true);
		expect(joined).toBe(false);
		operationRelease.resolve();
		await idle;
		expect(h.session.isCompacting).toBe(false);
		expect(h.session.isIdle).toBe(false);
		expect(externalJoined).toBe(false);
	} finally {
		operationRelease.resolve();
		finish.resolve();
		await Promise.all([idle, external]);
		await h.session.waitForIdle();
		h.cleanup();
	}
});

// pi#131: shortcut contexts must use the same retained callback path as event/command contexts.
it.each([false, true])(
	"shortcut compaction retains its callback and supplies owned joins (failed: %s)",
	async (failed) => {
		const entered = deferred(),
			joined = deferred(),
			finish = deferred();
		const h = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.registerShortcut("ctrl+y", {
						handler: async (ctx) => {
							const callback = async (_value: unknown, owned: CompactionCompletionContext) => {
								entered.resolve();
								await owned.waitForIdle();
								joined.resolve();
								await finish.promise;
							};
							ctx.compact(failed ? { onError: callback } : { onComplete: callback });
						},
					});
					pi.on("session_before_compact", ({ preparation: { firstKeptEntryId, tokensBefore } }) =>
						failed ? { cancel: true } : { compaction: { summary: "shortcut", firstKeptEntryId, tokensBefore } },
					);
				},
			],
		});
		let external: Promise<void> | undefined,
			externalJoined = false;
		try {
			h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			await h.session.prompt("one");
			await h.session.prompt("two");
			const ui = {
				session: h.session,
				sessionManager: h.sessionManager,
				settingsManager: h.settingsManager,
				keybindings: { getEffectiveConfig: () => ({}) },
				defaultEditor: { onExtensionShortcut: undefined as ((data: string) => boolean) | undefined },
				createExtensionUIContext: () => createTestUiContext(),
			};
			const setup = Reflect.get(InteractiveMode.prototype, "setupExtensionShortcuts") as (
				this: typeof ui,
				runner: ExtensionRunner,
			) => void;
			setup.call(ui, h.session.extensionRunner);
			expect(ui.defaultEditor.onExtensionShortcut?.("\u0019")).toBe(true);
			await entered.promise;
			await joined.promise;
			external = h.session.waitForIdle().then(() => {
				externalJoined = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(externalJoined).toBe(false);
			expect(h.session.isIdle).toBe(false);
		} finally {
			finish.resolve();
			await external;
			await h.session.waitForIdle();
			h.cleanup();
		}
	},
);
