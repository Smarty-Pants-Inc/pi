import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type DeferredHandle, fauxAssistantMessage, type Models } from "@earendil-works/pi-ai";
import { defineDoc, type Harness, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { chatSetup, openChat, waitFor } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

// A public document probe keeps these behavioral regressions runnable against the pre-repair checkpoint.
const ReceiptProbe = defineDoc<{
	receipts: Record<string, { status: string; checkpoint: { handle: { id: string } } }>;
}>({
	kind: "pi.deferred-receipts",
	version: 1,
	scope: "session",
	initial: () => ({ receipts: {} }),
});
const directories: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses) await harness.close(context);
	harnesses.length = 0;
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.length = 0;
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "durable-receipt-"));
	directories.push(directory);
	const path = join(directory, "session.sqlite");
	const base = chatSetup();
	let now = 1000;
	base.now = () => now;
	const reached = deferred();
	const release = deferred();
	const signalled = deferred();
	let requests = 0;
	let polls = 0;
	let cancellations = 0;
	let failCancellation = false;
	const handle: DeferredHandle = {
		provider: "faux",
		modelId: "faux-1",
		api: "faux",
		id: "accepted-job",
		pollAfterMs: 60_000,
	};
	const streamSimple: Models["streamSimple"] = (_model, _messages, options) => {
		requests++;
		options?.signal?.addEventListener("abort", () => signalled.resolve(), { once: true });
		const events = async function* () {
			reached.resolve();
			yield { type: "start" as const, partial: fauxAssistantMessage([], { stopReason: "pending" }) };
			await release.promise;
			yield {
				type: "done" as const,
				reason: "deferred" as const,
				message: fauxAssistantMessage([], { stopReason: "deferred", deferred: handle }),
			};
		};
		return {
			[Symbol.asyncIterator]: events,
			result: async () => fauxAssistantMessage([], { stopReason: "deferred", deferred: handle }),
		} as unknown as ReturnType<Models["streamSimple"]>;
	};
	const fetchDeferred: Models["fetchDeferred"] = async (_model, receipt) => {
		expect(receipt).toEqual(handle);
		polls++;
		return fauxAssistantMessage("recovered answer");
	};
	const cancelDeferred: Models["cancelDeferred"] = async (_model, receipt, options) => {
		expect(receipt).toEqual(handle);
		expect(options?.signal?.aborted).toBe(false);
		cancellations++;
		if (failCancellation) throw new Error("cancel unavailable");
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
	const setup = { ...base, models };
	const open = async (withoutModel = false) => {
		const opened = await openChat(
			await openNodeSqliteStorage(path),
			withoutModel ? { ...setup, models: createModels() } : setup,
		);
		harnesses.push(opened.harness);
		return opened;
	};
	return {
		open,
		reached,
		release,
		signalled,
		pollNow: () => {
			now = 61_000;
		},
		stats: () => ({ requests, polls, cancellations }),
		failCancel: (fail: boolean) => {
			failCancellation = fail;
		},
	};
}

async function runId(harness: Harness, conversationId: Parameters<Harness["conversation"]>[0]): Promise<TaskId> {
	return (await harness.snapshot(LiveDoc, conversationId, context))!.run!.taskId;
}

describe("deferred receipt custody (PR #131, P2-25)", () => {
	it("persists acceptance delivered after close and polls on reopen without resending", async () => {
		const f = await fixture();
		let opened = await f.open();
		opened.harness.resume();
		const submission = await opened.root.submit({ type: "input", content: "hi" }, context);
		await f.reached.promise;
		const id = await runId(opened.harness, opened.root.id);
		const closing = opened.harness.close(context);
		await f.signalled.promise;
		f.release.resolve();
		await closing;
		opened = await f.open();
		const record = await opened.harness.getTask(id, context);
		expect(record?.state).toMatchObject({
			status: "pending",
			checkpoint: { phase: "poll", handle: { id: "accepted-job" } },
		});
		f.pollNow();
		opened.harness.resume();
		expect(await (await opened.harness.submission(submission.id, context))!.wait(context)).toMatchObject({
			status: "done",
		});
		expect(f.stats()).toEqual({ requests: 1, polls: 1, cancellations: 0 });
	});

	it("cancels late acceptance after a durable abort mark before terminal settlement", async () => {
		const f = await fixture();
		const opened = await f.open();
		opened.harness.resume();
		await opened.root.submit({ type: "input", content: "hi" }, context);
		await f.reached.promise;
		const id = await runId(opened.harness, opened.root.id);
		const aborting = opened.harness.abortTask(id, context);
		await f.signalled.promise;
		f.release.resolve();
		await aborting;
		expect((await opened.harness.waitForTask(id, context)).state.outcome).toMatchObject({ status: "aborted" });
		expect(f.stats()).toEqual({ requests: 1, polls: 0, cancellations: 1 });
	});

	it("retains failed cancellation through close and retries on reopen", async () => {
		const f = await fixture();
		f.failCancel(true);
		f.release.resolve();
		let opened = await f.open();
		opened.harness.resume();
		await opened.root.submit({ type: "input", content: "hi" }, context);
		await f.reached.promise;
		const id = await runId(opened.harness, opened.root.id);
		await waitFor(
			async () =>
				(await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.generation?.deferred !== undefined,
		);
		await opened.harness.abortTask(id, context);
		await waitFor(() => f.stats().cancellations === 1);
		expect((await opened.harness.waitForTask(id, context)).state.outcome).toMatchObject({ status: "aborted" });
		expect((await opened.harness.snapshot(ReceiptProbe, context))?.receipts[String(id)]).toMatchObject({
			status: "cancel_failed",
			checkpoint: { handle: { id: "accepted-job" } },
		});
		await opened.harness.close(context);
		f.failCancel(false);
		opened = await f.open();
		expect((await opened.harness.getTask(id, context))?.abortRequested).toBe(true);
		expect((await opened.harness.snapshot(ReceiptProbe, context))?.receipts[String(id)]).toMatchObject({
			status: "cancel_failed",
		});
		opened.harness.resume();
		await waitFor(
			async () =>
				f.stats().cancellations === 2 &&
				Object.keys((await opened.harness.snapshot(ReceiptProbe, context))!.receipts).length === 0,
		);
		expect(f.stats()).toEqual({ requests: 1, polls: 0, cancellations: 2 });
	});
	it("reconciles a persisted poll checkpoint even when its independent ledger is absent", async () => {
		const f = await fixture();
		f.release.resolve();
		let opened = await f.open();
		opened.harness.resume();
		await opened.root.submit({ type: "input", content: "hi" }, context);
		await f.reached.promise;
		const id = await runId(opened.harness, opened.root.id);
		await waitFor(
			async () =>
				(await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.generation?.deferred !== undefined,
		);
		await opened.harness.commit(async (tx) => {
			(await tx.doc(ReceiptProbe)).receipts = {};
		}, context);
		await opened.harness.close(context);
		f.failCancel(true);
		opened = await f.open();
		expect((await opened.harness.snapshot(ReceiptProbe, context))?.receipts[String(id)]).toMatchObject({
			status: "accepted",
		});
		opened.harness.resume();
		await opened.harness.abortTask(id, context);
		expect((await opened.harness.waitForTask(id, context)).state.outcome).toMatchObject({ status: "aborted" });
		expect((await opened.harness.snapshot(ReceiptProbe, context))?.receipts[String(id)]).toMatchObject({
			status: "cancel_failed",
		});
		expect(f.stats()).toEqual({ requests: 1, polls: 0, cancellations: 1 });
	});
	it("retains skipped cancellation after no_model termination and reconciles it on reopen", async () => {
		const f = await fixture();
		f.release.resolve();
		let opened = await f.open();
		opened.harness.resume();
		const submission = await opened.root.submit({ type: "input", content: "hi" }, context);
		await f.reached.promise;
		const id = await runId(opened.harness, opened.root.id);
		await waitFor(
			async () =>
				(await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.generation?.deferred !== undefined,
		);
		await opened.harness.close(context);
		opened = await f.open(true);
		opened.harness.resume();
		expect(await (await opened.harness.submission(submission.id, context))!.wait(context)).toMatchObject({
			status: "unanswered",
			reason: "no_model",
		});
		await waitFor(
			async () =>
				(await opened.harness.snapshot(ReceiptProbe, context))?.receipts[String(id)]?.status === "cancel_failed",
		);
		await opened.harness.close(context);
		opened = await f.open();
		expect((await opened.harness.getTask(id, context))?.state.status).toBe("terminal");
		opened.harness.resume();
		await waitFor(
			async () =>
				f.stats().cancellations === 1 &&
				Object.keys((await opened.harness.snapshot(ReceiptProbe, context))!.receipts).length === 0,
		);
		expect(f.stats()).toEqual({ requests: 1, polls: 0, cancellations: 1 });
	});
});
