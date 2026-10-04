import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, JsonRepresentation } from "@earendil-works/chord";
import { createModels, type DeferredHandle, fauxAssistantMessage, type Models } from "@earendil-works/pi-ai";
import {
	defineDoc,
	GenerationTask,
	type Harness,
	LiveDoc,
	MemoryStorage,
	type Seq,
	type Storage,
	StorageRejected,
	type StorageWrite,
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addHooks } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

const Receipts = defineDoc<{
	receipts: Record<string, { status: string; checkpoint: { handle: JsonRepresentation<DeferredHandle> } }>;
}>({ kind: "pi.deferred-receipts", version: 1, scope: "session", initial: () => ({ receipts: {} }) });

/** Reopenable, deletion-free mock backend. Fail only adoption, after the provider accepted, before batch effects. */
class AdoptionStorage extends MemoryStorage {
	failures = 0;
	delegate: Storage | undefined;
	mode: "once" | "unavailable" | "poison" | "healthy" = "once";
	override async commit(writes: readonly StorageWrite[], callContext: Context): Promise<Seq> {
		const adopting = writes.some(
			(write) =>
				write.type === "task" &&
				"checkpoint" in write.value.state &&
				(write.value.state.checkpoint as { phase?: string }).phase === "poll",
		);
		if ((adopting || (this.mode === "unavailable" && this.failures > 0)) && this.mode !== "healthy") {
			this.failures++;
			if (this.mode === "once") this.mode = "healthy";
			if (this.mode === "poison" || (this.mode === "unavailable" && this.failures > 1)) {
				throw new Error("storage unavailable after the rejected adoption batch");
			}
			throw new StorageRejected("adoption batch rejected before effects");
		}
		return this.delegate === undefined
			? super.commit(writes, callContext)
			: this.delegate.commit(writes, callContext);
	}
	override async close(_context: Context): Promise<void> {
		// The launcher owns scratch. This mock keeps committed bytes across kernel instances.
	}
}

async function fixture(
	mode: AdoptionStorage["mode"] = "once",
	cancel: "success" | "failed" | "missing" = "success",
	backend: "memory" | "sqlite" = "memory",
) {
	const base = chatSetup();
	const missingModels = createModels();
	missingModels.setProvider({ ...base.faux.provider, cancelDeferred: undefined });
	const storage = new AdoptionStorage();
	storage.mode = mode;
	let now = 1000;
	base.now = () => now;
	let polls = 0;
	const reached = deferred();
	const release = deferred();
	const signalled = deferred();
	const handle: DeferredHandle = {
		provider: "faux",
		modelId: "faux-1",
		api: "faux",
		id: "exact-accepted-job",
		pollAfterMs: 60_000,
	};
	let requests = 0;
	let cancellations = 0;
	let cancellation = cancel;
	const streamSimple: Models["streamSimple"] = (_model, _messages, options) => {
		requests++;
		options?.signal?.addEventListener("abort", () => signalled.resolve(), { once: true });
		const message = fauxAssistantMessage([], { stopReason: "deferred", deferred: handle });
		return {
			[Symbol.asyncIterator]: async function* () {
				reached.resolve();
				yield { type: "start", partial: fauxAssistantMessage([], { stopReason: "pending" }) };
				await release.promise;
				yield { type: "done", reason: "deferred", message };
			},
			result: async () => message,
		} as unknown as ReturnType<Models["streamSimple"]>;
	};
	const cancelDeferred: Models["cancelDeferred"] = async (model, receipt, options) => {
		expect(receipt).toEqual(handle);
		expect(options?.signal?.aborted).toBe(false);
		cancellations++;
		if (cancellation === "missing") return missingModels.cancelDeferred(model, receipt, options);
		if (cancellation === "failed") throw new Error("cancellation failed");
	};
	const fetchDeferred: Models["fetchDeferred"] = async (_model, receipt) => {
		expect(receipt).toEqual(handle);
		polls++;
		return fauxAssistantMessage("recovered answer");
	};
	const models = new Proxy(base.models, {
		get(target, property) {
			if (property === "streamSimple") return streamSimple;
			if (property === "fetchDeferred") return fetchDeferred;
			if (property === "cancelDeferred") return cancelDeferred;
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const path =
		backend === "sqlite" ? join(await mkdtemp(join(tmpdir(), "receipt-adoption-")), "session.sqlite") : undefined;
	const harnesses: Harness[] = [];
	const open = async () => {
		let connection: Storage = storage;
		if (path !== undefined) {
			const sqlite = await openNodeSqliteStorage(path);
			storage.delegate = sqlite;
			connection = new Proxy(sqlite, {
				get(target, property) {
					if (property === "commit") return storage.commit.bind(storage);
					const value: unknown = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		}
		const opened = await openChat(connection, { ...base, models });
		harnesses.push(opened.harness);
		return opened;
	};
	return {
		open,
		storage,
		base,
		handle,
		reached,
		release,
		signalled,
		stats: () => ({ requests, cancellations }),
		pollNow: () => {
			now = 61_000;
		},
		polls: () => polls,
		restoreCancel: () => {
			cancellation = "success";
		},
		close: async () => {
			release.resolve();
			for (const harness of harnesses) await harness.close(context);
		},
	};
}

async function idOf(harness: Harness, conversationId: Parameters<Harness["conversation"]>[0]): Promise<TaskId> {
	return (await harness.snapshot(LiveDoc, conversationId, context))!.run!.taskId;
}

// PR #131 F07: first receipt/checkpoint rejection must not abandon the accepted provider job.
describe("PR #131 round-3 receipt adoption", () => {
	it("owns and cancels the exact handle after healthy first-write rejection", async () => {
		const f = await fixture();
		try {
			const opened = await f.open();
			await opened.root.submit({ type: "input", content: "hi" }, context);
			await f.reached.promise;
			f.release.resolve();
			await waitFor(async () => (await opened.harness.inspect(context)).tasks.length === 0);
			expect(f.storage.failures).toBe(1);
			expect(f.stats()).toEqual({ requests: 1, cancellations: 1 });
			expect((await opened.harness.snapshot(Receipts, context))?.receipts ?? {}).toEqual({});
		} finally {
			await f.close();
		}
	});

	// PR #131 F07: late abort acceptance still owns the first rejected receipt.
	it("cancels late acceptance after abort despite first-write rejection", async () => {
		const f = await fixture();
		try {
			const opened = await f.open();
			await opened.root.submit({ type: "input", content: "hi" }, context);
			await f.reached.promise;
			const id = await idOf(opened.harness, opened.root.id);
			const aborting = opened.harness.abortTask(id, context);
			await f.signalled.promise;
			f.release.resolve();
			await aborting;
			await opened.harness.waitForTask(id, context);
			expect(f.storage.failures).toBe(1);
			expect(f.stats()).toEqual({ requests: 1, cancellations: 1 });
		} finally {
			await f.close();
		}
	});

	// PR #131 F07: close joins adoption; its original request must not be resent on reopen.
	it("retains late-close acceptance durably and cancels on reopen without resending", async () => {
		const f = await fixture();
		try {
			let opened = await f.open();
			await opened.root.submit({ type: "input", content: "hi" }, context);
			await f.reached.promise;
			const id = await idOf(opened.harness, opened.root.id);
			const closing = opened.harness.close(context);
			await f.signalled.promise;
			f.release.resolve();
			await closing;
			opened = await f.open();
			expect((await opened.harness.snapshot(Receipts, context))?.receipts[String(id)]).toMatchObject({
				status: "cancel_pending",
				checkpoint: { handle: f.handle },
			});
			opened.harness.resume();
			await opened.harness.waitForTask(id, context);
			expect(f.stats()).toEqual({ requests: 1, cancellations: 1 });
		} finally {
			await f.close();
		}
	});

	for (const cancellation of ["failed", "missing"] as const) {
		// PR #131 F07: no cancellation capability is not confirmation of cancellation.
		it(`retains ${cancellation} cancellation custody across reopen after first-write rejection`, async () => {
			const f = await fixture("once", cancellation);
			try {
				let opened = await f.open();
				await opened.root.submit({ type: "input", content: "hi" }, context);
				await f.reached.promise;
				const id = await idOf(opened.harness, opened.root.id);
				f.release.resolve();
				await waitFor(async () => (await opened.harness.inspect(context)).tasks.length === 0);
				expect((await opened.harness.snapshot(Receipts, context))?.receipts[String(id)]).toMatchObject({
					status: "cancel_failed",
					checkpoint: { handle: f.handle },
				});
				await opened.harness.close(context);
				f.restoreCancel();
				opened = await f.open();
				opened.harness.resume();
				await waitFor(
					async () => Object.keys((await opened.harness.snapshot(Receipts, context))?.receipts ?? {}).length === 0,
				);
				expect(f.stats()).toEqual({ requests: 1, cancellations: 2 });
			} finally {
				await f.close();
			}
		});
	}

	// PR #131 F07: observe the actual duplicate submit on the reviewed baseline, not only its absent receipt.
	it("does not spend a second request when late-close first-write rejection is reopened", async () => {
		const f = await fixture();
		try {
			let opened = await f.open();
			await opened.root.submit({ type: "input", content: "hi" }, context);
			await f.reached.promise;
			const closing = opened.harness.close(context);
			await f.signalled.promise;
			f.release.resolve();
			await closing;
			opened = await f.open();
			opened.harness.resume();
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(f.stats().requests).toBe(1);
			expect(f.stats().cancellations).toBe(1);
		} finally {
			await f.close();
		}
	});

	// PR #131 F07: the replay fence is committed to SQLite before dispatch, not merely retained in a scheduler map.
	it("reopens a poisoned SQLite first-write failure with explicit uncertainty and no duplicate spend", async () => {
		const f = await fixture("poison", "failed", "sqlite");
		try {
			let opened = await f.open();
			await opened.root.submit({ type: "input", content: "hi" }, context);
			await f.reached.promise;
			const id = await idOf(opened.harness, opened.root.id);
			f.release.resolve();
			await waitFor(() => f.storage.failures > 0);
			await opened.harness.close(context);
			f.storage.mode = "healthy";
			opened = await f.open();
			opened.harness.resume();
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(f.stats().requests).toBe(1);
			expect(
				(await opened.harness.inspect(context)).tasks.find((task) => task.record.id === id)?.state,
			).toMatchObject({
				kind: "blocked",
				reason: "acceptance_uncertain",
			});
			expect((await opened.harness.getTask(id, context))?.state).toMatchObject({
				checkpoint: { acceptanceUncertain: true },
			});
		} finally {
			await f.close();
		}
	});

	// PR #131 F07: pre-repair request checkpoints contain no proof of whether the provider already accepted.
	it("fences unmarked historical request checkpoints rather than resending an unknown accepted job", async () => {
		const f = await fixture("poison", "failed");
		try {
			let opened = await f.open();
			await opened.root.submit({ type: "input", content: "hi" }, context);
			await f.reached.promise;
			const id = await idOf(opened.harness, opened.root.id);
			f.release.resolve();
			await waitFor(() => f.storage.failures > 0);
			await opened.harness.close(context);
			f.storage.mode = "healthy";
			const stored = await f.storage.task(id, context);
			if (stored?.state.status !== "running") throw new Error("Expected interrupted request");
			const checkpoint = stored.state.checkpoint;
			if (checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint))
				throw new Error("Expected checkpoint object");
			const { acceptanceUncertain: _uncertain, ...historicalCheckpoint } = checkpoint;
			await f.storage.commit(
				[
					{
						type: "task",
						value: {
							...stored,
							state: { ...stored.state, checkpoint: historicalCheckpoint },
						},
					},
				],
				context,
			);
			opened = await f.open();
			opened.harness.resume();
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(f.stats().requests).toBe(1);
			expect(
				(await opened.harness.inspect(context)).tasks.find((task) => task.record.id === id)?.state,
			).toMatchObject({
				kind: "blocked",
				reason: "acceptance_uncertain",
			});
		} finally {
			await f.close();
		}
	});

	// Prepared-but-never-dispatched recovery control: only ambiguous acceptance is fenced, not request preparation.
	it("control: resumes an explicitly never-dispatched request after interrupted preparation hooks", async () => {
		const f = await fixture("healthy");
		const reachedHook = deferred();
		const hooks = addHooks(f.base.registry, GenerationTask, {
			beforeRequest: async (_request, _runtime, ctx) => {
				reachedHook.resolve();
				await aborted(ctx.abortSignal!);
			},
		});
		try {
			let opened = await f.open();
			await opened.root.submit({ type: "input", content: "hi" }, context);
			await reachedHook.promise;
			const id = await idOf(opened.harness, opened.root.id);
			await opened.harness.close(context);
			hooks.dispose();
			opened = await f.open();
			f.release.resolve();
			opened.harness.resume();
			await waitFor(
				async () =>
					(await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.generation?.deferred !== undefined,
			);
			expect(f.stats().requests).toBe(1);
			await opened.harness.abortTask(id, context);
			await opened.harness.waitForTask(id, context);
		} finally {
			hooks.dispose();
			await f.close();
		}
	});

	// Successful atomic adoption control: preserve the credited round-2 late-close polling path.
	it("control: successful late-close adoption polls once on reopen without cancellation or resend", async () => {
		const f = await fixture("healthy");
		try {
			let opened = await f.open();
			const submission = await opened.root.submit({ type: "input", content: "hi" }, context);
			await f.reached.promise;
			const id = await idOf(opened.harness, opened.root.id);
			const closing = opened.harness.close(context);
			await f.signalled.promise;
			f.release.resolve();
			await closing;
			opened = await f.open();
			expect((await opened.harness.getTask(id, context))?.state).toMatchObject({
				status: "pending",
				checkpoint: { phase: "poll", handle: f.handle },
			});
			expect((await opened.harness.snapshot(Receipts, context))?.receipts[String(id)]).toMatchObject({
				status: "accepted",
				checkpoint: { handle: f.handle },
			});
			f.pollNow();
			expect(await (await opened.harness.submission(submission.id, context))!.wait(context)).toMatchObject({
				status: "done",
			});
			expect(f.stats()).toEqual({ requests: 1, cancellations: 0 });
			expect(f.polls()).toBe(1);
		} finally {
			await f.close();
		}
	});

	// Successful atomic adoption control: preserve existing late-abort cancellation-failure custody.
	it("control: successful adoption retains failed late-abort cancellation through reopen", async () => {
		const f = await fixture("healthy", "failed");
		try {
			let opened = await f.open();
			await opened.root.submit({ type: "input", content: "hi" }, context);
			await f.reached.promise;
			const id = await idOf(opened.harness, opened.root.id);
			const aborting = opened.harness.abortTask(id, context);
			await f.signalled.promise;
			f.release.resolve();
			await aborting;
			await opened.harness.waitForTask(id, context);
			expect((await opened.harness.snapshot(Receipts, context))?.receipts[String(id)]).toMatchObject({
				status: "cancel_failed",
			});
			await opened.harness.close(context);
			f.restoreCancel();
			opened = await f.open();
			opened.harness.resume();
			await waitFor(
				async () => Object.keys((await opened.harness.snapshot(Receipts, context))?.receipts ?? {}).length === 0,
			);
			expect(f.stats()).toEqual({ requests: 1, cancellations: 2 });
		} finally {
			await f.close();
		}
	});

	// PR #131 F07: provider cancellation remains joined and independent when Session cannot admit retirement writes.
	it("confirms exact-handle cancellation independently of poisoned receipt storage", async () => {
		const f = await fixture("poison", "success");
		try {
			let opened = await f.open();
			await opened.root.submit({ type: "input", content: "hi" }, context);
			await f.reached.promise;
			const id = await idOf(opened.harness, opened.root.id);
			f.release.resolve();
			await waitFor(() => f.storage.failures > 0);
			await opened.harness.close(context);
			expect(f.stats()).toEqual({ requests: 1, cancellations: 1 });
			f.storage.mode = "healthy";
			opened = await f.open();
			opened.harness.resume();
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(f.stats().requests).toBe(1);
			expect(
				(await opened.harness.inspect(context)).tasks.find((task) => task.record.id === id)?.state,
			).toMatchObject({
				kind: "blocked",
				reason: "acceptance_uncertain",
			});
		} finally {
			await f.close();
		}
	});

	for (const mode of ["poison", "unavailable"] as const) {
		// PR #131 F07: independent cancellation and a pre-submit barrier survive unavailable receipt storage.
		it(`fences replay when ${mode} storage cannot persist the accepted handle`, async () => {
			const f = await fixture(mode, "failed");
			try {
				let opened = await f.open();
				await opened.root.submit({ type: "input", content: "hi" }, context);
				await f.reached.promise;
				const id = await idOf(opened.harness, opened.root.id);
				f.release.resolve();
				await waitFor(() => f.storage.failures > 0);
				await opened.harness.close(context);
				expect(f.stats()).toEqual({ requests: 1, cancellations: 1 });
				expect(
					f.base.reports.some(
						(report) =>
							report instanceof Error &&
							(report.cause as { receipt?: { checkpoint: { handle: DeferredHandle } } } | undefined)?.receipt
								?.checkpoint.handle.id === f.handle.id,
					),
				).toBe(true);
				f.storage.mode = "healthy";
				opened = await f.open();
				opened.harness.resume();
				await new Promise((resolve) => setTimeout(resolve, 30));
				expect(f.stats().requests).toBe(1);
				expect(
					(await opened.harness.inspect(context)).tasks.find((task) => task.record.id === id)?.state,
				).toMatchObject({
					kind: "blocked",
					reason: "acceptance_uncertain",
				});
			} finally {
				await f.close();
			}
		});
	}
});
