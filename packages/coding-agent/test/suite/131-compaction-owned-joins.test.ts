import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { CompactionCompletionContext, ExtensionCommandContext } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function pause(ms = 100) {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
function servicesFor(h: Harness) {
	return {
		cwd: h.tempDir,
		agentDir: h.tempDir,
		modelRuntime: h.session.modelRuntime,
		settingsManager: h.settingsManager,
		resourceLoader: h.session.resourceLoader,
		diagnostics: [],
	};
}
async function setup(failed = false) {
	let ctx!: ExtensionCommandContext;
	const h = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.registerCommand("audit-capture", {
					description: "Independent compaction acceptance probe",
					handler: async (_args, context) => {
						ctx = context;
					},
				});
				pi.on("session_before_compact", ({ preparation: { firstKeptEntryId, tokensBefore } }) =>
					failed ? { cancel: true } : { compaction: { summary: "audit summary", firstKeptEntryId, tokensBefore } },
				);
			},
		],
	});
	await h.session.bindExtensions({
		commandContextActions: {
			waitForIdle: () => h.session.waitForIdle(),
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		},
	});
	const cmd = h.session.extensionRunner.getCommand("audit-capture");
	if (!cmd) throw new Error("Missing public command registration");
	await cmd.handler("", h.session.extensionRunner.createCommandContext());
	h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	await h.session.prompt("first");
	await h.session.prompt("second");
	return { h, ctx };
}

// pi#131: independent reentrant joins, external custody, and real runtime replacement.
it.each([
	["onComplete", "waitForIdle"],
	["onComplete", "abort"],
	["onError", "waitForIdle"],
	["onError", "abort"],
] as const)("single %s/%s retains external retirement through continuation", async (callback, join) => {
	const { h, ctx } = await setup(callback === "onError");
	const entered = deferred(),
		finish = deferred(),
		rescue = deferred();
	const joins: Promise<unknown>[] = [];
	const replacements: Harness[] = [];
	let innerDone = false,
		idleDone = false,
		abortDone = false,
		replaced = false;
	const runtime = new AgentSessionRuntime(h.session, servicesFor(h), async ({ sessionManager }) => {
		const next = await createHarness({ sessionManager });
		replacements.push(next);
		return {
			session: next.session,
			extensionsResult: next.session.resourceLoader.getExtensions(),
			services: servicesFor(next),
			diagnostics: [],
		};
	});
	try {
		ctx.compact({
			[callback]: async (_result: unknown, owned: CompactionCompletionContext) => {
				const own = (join === "waitForIdle" ? owned.waitForIdle() : owned.abort()).then(() => {
					innerDone = true;
				});
				joins.push(own);
				entered.resolve();
				await Promise.race([own, rescue.promise]);
				await finish.promise;
			},
		});
		await entered.promise;
		joins.push(
			h.session.waitForIdle().then(() => {
				idleDone = true;
			}),
		);
		joins.push(
			h.session.abort().then(() => {
				abortDone = true;
			}),
		);
		joins.push(
			runtime.newSession().then(() => {
				replaced = true;
			}),
		);
		await pause();
		const observed = {
			innerDone,
			idleDone,
			abortDone,
			replaced,
			idle: h.session.isIdle,
			compacting: h.session.isCompacting,
		};
		console.log(`AUDIT2 ${JSON.stringify({ case: "single-reentrant", callback, join, ...observed })}`);
		rescue.resolve();
		finish.resolve();
		await Promise.all(joins);
		expect(observed).toEqual({
			innerDone: true,
			idleDone: false,
			abortDone: false,
			replaced: false,
			idle: false,
			compacting: false,
		});
		expect(runtime.session).not.toBe(h.session);
	} finally {
		rescue.resolve();
		finish.resolve();
		await Promise.all(joins);
		await runtime.dispose();
		h.cleanup();
		for (const next of replacements) next.cleanup();
	}
});

// pi#131: unawaited unrelated timer work is not the callback's own joining continuation.
it.each([
	["onComplete", "waitForIdle"],
	["onComplete", "abort"],
	["onError", "waitForIdle"],
	["onError", "abort"],
] as const)("unrelated work created in %s must not bypass %s custody", async (callback, join) => {
	const { h, ctx } = await setup(callback === "onError");
	const entered = deferred(),
		timerStarted = deferred(),
		finish = deferred();
	const joins: Promise<unknown>[] = [];
	let detachedDone = false,
		externalDone = false;
	try {
		ctx.compact({
			[callback]: async () => {
				// The callback never awaits or uses this timer's returned promise.
				setTimeout(() => {
					const detached = (join === "waitForIdle" ? ctx.waitForIdle() : h.session.abort()).then(() => {
						detachedDone = true;
					});
					joins.push(detached);
					timerStarted.resolve();
				}, 0);
				entered.resolve();
				await finish.promise;
			},
		});
		await entered.promise;
		await timerStarted.promise;
		joins.push(
			h.session.waitForIdle().then(() => {
				externalDone = true;
			}),
		);
		await pause();
		const observed = { detachedDone, externalDone, idle: h.session.isIdle, compacting: h.session.isCompacting };
		console.log(`AUDIT2 ${JSON.stringify({ case: "detached-context-leak", callback, join, ...observed })}`);
		finish.resolve();
		await Promise.all(joins);
		await h.session.waitForIdle();
		expect(observed).toEqual({ detachedDone: false, externalDone: false, idle: false, compacting: false });
	} finally {
		finish.resolve();
		await Promise.all(joins);
		await h.session.abort();
		h.cleanup();
	}
});

// pi#131: two retained completions must not form A -> B -> A joins.
it.each([
	["nested", "waitForIdle"],
	["nested", "abort"],
	["concurrent", "waitForIdle"],
	["concurrent", "abort"],
] as const)("%s completions do not mutually join through %s", async (shape, join) => {
	const { h, ctx } = await setup();
	const enteredA = deferred(),
		enteredB = deferred(),
		start = deferred(),
		rescue = deferred();
	const joins: Promise<unknown>[] = [];
	const replacements: Harness[] = [];
	let aDone = false,
		bDone = false,
		externalDone = false,
		abortDone = false,
		replaced = false;
	const runtime = new AgentSessionRuntime(h.session, servicesFor(h), async ({ sessionManager }) => {
		const next = await createHarness({ sessionManager });
		replacements.push(next);
		return {
			session: next.session,
			extensionsResult: next.session.resourceLoader.getExtensions(),
			services: servicesFor(next),
			diagnostics: [],
		};
	});
	const childCallback = async (_result: unknown, owned: CompactionCompletionContext) => {
		enteredB.resolve();
		await start.promise;
		const own = (join === "waitForIdle" ? owned.waitForIdle() : owned.abort()).then(() => {
			bDone = true;
		});
		joins.push(own);
		await Promise.race([own, rescue.promise]);
	};
	const child = () => ctx.compact({ onComplete: childCallback, onError: childCallback });
	try {
		ctx.compact({
			onComplete: async (_result, owned) => {
				enteredA.resolve();
				if (shape === "nested") child();
				await start.promise;
				const own = (join === "waitForIdle" ? owned.waitForIdle() : owned.abort()).then(() => {
					aDone = true;
				});
				joins.push(own);
				await Promise.race([own, rescue.promise]);
			},
		});
		await enteredA.promise;
		if (shape === "concurrent") child();
		await enteredB.promise;
		start.resolve();
		joins.push(
			h.session.waitForIdle().then(() => {
				externalDone = true;
			}),
		);
		joins.push(
			h.session.abort().then(() => {
				abortDone = true;
			}),
		);
		joins.push(
			runtime.newSession().then(() => {
				replaced = true;
			}),
		);
		await pause();
		const observed = {
			aDone,
			bDone,
			externalDone,
			abortDone,
			replaced,
			idle: h.session.isIdle,
			compacting: h.session.isCompacting,
		};
		console.log(`AUDIT2 ${JSON.stringify({ case: "multi-completion-cycle", shape, join, ...observed })}`);
		rescue.resolve();
		await Promise.all(joins);
		await h.session.waitForIdle();
		expect(observed.aDone).toBe(true);
		expect(observed.bDone).toBe(true);
		expect(runtime.session).not.toBe(h.session);
	} finally {
		start.resolve();
		rescue.resolve();
		await Promise.all(joins);
		await runtime.dispose();
		h.cleanup();
		for (const next of replacements) next.cleanup();
	}
});

// pi#131: a detached lifecycle operation must not invalidate a still-running callback.
it("unrelated timer must not replace a runtime before its originating callback returns", async () => {
	const { h, ctx } = await setup();
	const entered = deferred(),
		timerStarted = deferred(),
		finish = deferred();
	const replacements: Harness[] = [];
	const joins: Promise<unknown>[] = [];
	let replaced = false,
		callbackFinished = false;
	const runtime = new AgentSessionRuntime(h.session, servicesFor(h), async ({ sessionManager }) => {
		const next = await createHarness({ sessionManager });
		replacements.push(next);
		return {
			session: next.session,
			extensionsResult: next.session.resourceLoader.getExtensions(),
			services: servicesFor(next),
			diagnostics: [],
		};
	});
	try {
		ctx.compact({
			onComplete: async () => {
				setTimeout(() => {
					joins.push(
						runtime.newSession().then(() => {
							replaced = true;
						}),
					);
					timerStarted.resolve();
				}, 0);
				entered.resolve();
				await finish.promise;
				callbackFinished = true;
			},
		});
		await entered.promise;
		await timerStarted.promise;
		await pause();
		let stale = false;
		try {
			ctx.isIdle();
		} catch {
			stale = true;
		}
		const observed = { replaced, callbackFinished, stale, idle: h.session.isIdle };
		console.log(`AUDIT2 ${JSON.stringify({ case: "detached-runtime-replacement", ...observed })}`);
		finish.resolve();
		await Promise.all(joins);
		await h.session.waitForIdle();
		expect(observed).toEqual({ replaced: false, callbackFinished: false, stale: false, idle: false });
	} finally {
		finish.resolve();
		await Promise.all(joins);
		await h.session.waitForIdle();
		await runtime.dispose();
		h.cleanup();
		for (const next of replacements) next.cleanup();
	}
});

// pi#131: a descendant of a finished completion must join a later live completion normally.
it("expired explicit capability does not bypass a later completion", async () => {
	const { h, ctx } = await setup();
	const launch = deferred(),
		detachedStarted = deferred(),
		held = deferred(),
		laterEntered = deferred();
	let detached: Promise<void> | undefined,
		detachedDone = false;
	try {
		ctx.compact({
			onComplete: async (_result, owned) => {
				detached = (async () => {
					await launch.promise;
					detachedStarted.resolve();
					await owned.waitForIdle();
					detachedDone = true;
				})();
				await owned.waitForIdle();
			},
		});
		await h.session.waitForIdle();
		ctx.compact({
			onError: async () => {
				laterEntered.resolve();
				await held.promise;
			},
		});
		await laterEntered.promise;
		launch.resolve();
		await detachedStarted.promise;
		await pause();
		const observed = { detachedDone, idle: h.session.isIdle };
		console.log(`AUDIT2 ${JSON.stringify({ case: "expired-scope", ...observed })}`);
		held.resolve();
		await detached;
		await h.session.waitForIdle();
		expect(observed).toEqual({ detachedDone: false, idle: false });
	} finally {
		launch.resolve();
		held.resolve();
		await detached;
		await h.session.abort();
		h.cleanup();
	}
});

// pi#131: reproduce the same mutual cycle with two successful summaries, not only onError.
it("both successful completions cannot mutually join", async () => {
	const { h, ctx } = await setup();
	const enteredA = deferred(),
		enteredB = deferred(),
		start = deferred(),
		rescue = deferred();
	const joins: Promise<unknown>[] = [];
	let aDone = false,
		bDone = false,
		secondSucceeded = false,
		externalDone = false;
	try {
		ctx.compact({
			onComplete: async (_result, owned) => {
				enteredA.resolve();
				await start.promise;
				const join = owned.waitForIdle().then(() => {
					aDone = true;
				});
				joins.push(join);
				await Promise.race([join, rescue.promise]);
			},
		});
		await enteredA.promise;
		h.appendResponses([fauxAssistantMessage("third"), fauxAssistantMessage("fourth")]);
		await h.session.prompt("third");
		await h.session.prompt("fourth");
		const child = async (success: boolean, owned: CompactionCompletionContext) => {
			secondSucceeded = success;
			enteredB.resolve();
			await start.promise;
			const join = owned.waitForIdle().then(() => {
				bDone = true;
			});
			joins.push(join);
			await Promise.race([join, rescue.promise]);
		};
		ctx.compact({
			onComplete: (_result, owned) => child(true, owned),
			onError: (_error, owned) => child(false, owned),
		});
		await enteredB.promise;
		start.resolve();
		joins.push(
			h.session.waitForIdle().then(() => {
				externalDone = true;
			}),
		);
		await pause();
		const observed = {
			aDone,
			bDone,
			secondSucceeded,
			externalDone,
			idle: h.session.isIdle,
			compacting: h.session.isCompacting,
		};
		console.log(`AUDIT2 ${JSON.stringify({ case: "two-successful-completions", ...observed })}`);
		rescue.resolve();
		await Promise.all(joins);
		await h.session.waitForIdle();
		expect(secondSucceeded).toBe(true);
		expect(observed.aDone).toBe(true);
		expect(observed.bDone).toBe(true);
	} finally {
		start.resolve();
		rescue.resolve();
		await Promise.all(joins);
		await h.session.abort();
		h.cleanup();
	}
});

// pi#131: awaited descendants explicitly receive the callback join capability across async boundaries.
it("legitimate awaited descendant can join its own continuation", async () => {
	const { h, ctx } = await setup();
	const entered = deferred(),
		finish = deferred(),
		rescue = deferred();
	const joins: Promise<unknown>[] = [];
	let innerDone = false,
		externalDone = false;
	try {
		ctx.compact({
			onComplete: async (_result, owned) => {
				const chain = (async () => {
					await pause(1);
					await owned.waitForIdle();
					await pause(1);
					await owned.abort();
					innerDone = true;
				})();
				joins.push(chain);
				entered.resolve();
				await Promise.race([chain, rescue.promise]);
				await finish.promise;
			},
		});
		await entered.promise;
		joins.push(
			h.session.waitForIdle().then(() => {
				externalDone = true;
			}),
		);
		await pause();
		const observed = { innerDone, externalDone, idle: h.session.isIdle };
		console.log(`AUDIT2 ${JSON.stringify({ case: "awaited-descendant", ...observed })}`);
		rescue.resolve();
		finish.resolve();
		await Promise.all(joins);
		expect(observed).toEqual({ innerDone: true, externalDone: false, idle: false });
	} finally {
		rescue.resolve();
		finish.resolve();
		await Promise.all(joins);
		await h.session.abort();
		h.cleanup();
	}
});
