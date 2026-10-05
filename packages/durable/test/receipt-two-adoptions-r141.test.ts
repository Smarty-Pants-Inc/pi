import type { Context } from "@earendil-works/chord";
import { type DeferredHandle, fauxAssistantMessage, type Models } from "@earendil-works/pi-ai";
import {
	defineDoc,
	LiveDoc,
	MemoryStorage,
	type Seq,
	StorageRejected,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat, waitFor } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

const Receipts = defineDoc<{ receipts: Record<string, { status: string; checkpoint: { handle: { id: string } } }> }>({
	kind: "pi.deferred-receipts",
	version: 1,
	scope: "session",
	initial: () => ({ receipts: {} }),
});

class TwoFailures extends MemoryStorage {
	failures = 0;
	attempts = 0;
	available = true;
	override async commit(writes: readonly StorageWrite[], ctx: Context): Promise<Seq> {
		const adopting = writes.some(
			(write) =>
				write.type === "task" &&
				"checkpoint" in write.value.state &&
				(write.value.state.checkpoint as { phase?: string }).phase === "poll",
		);
		if (adopting || this.failures > 0) {
			this.attempts++;
			if (this.failures < 2 || !this.available) {
				this.failures++;
				if (this.failures === 1) throw new StorageRejected("synthetic first adoption rejected");
				throw new Error("synthetic storage admission uncertainty");
			}
		}
		return super.commit(writes, ctx);
	}
	override async close(_ctx: Context): Promise<void> {}
}

// PR #141 security P2 #9: neither cancellation outcome may abandon the sole accepted receipt.
describe("two-adoption failure custody", () => {
	for (const cancellation of ["success", "failure"] as const) {
		it(`durably retires ${cancellation} cancellation before close and does not submit twice`, async () => {
			const base = chatSetup();
			const storage = new TwoFailures();
			const reached = deferred();
			const release = deferred();
			let requests = 0;
			let cancels = 0;
			const handle: DeferredHandle = {
				provider: "faux",
				modelId: "faux-1",
				api: "faux",
				id: "synthetic-receipt-141",
				pollAfterMs: 60_000,
			};
			const stream: Models["streamSimple"] = () => {
				requests++;
				const message = fauxAssistantMessage([], { stopReason: "deferred", deferred: handle });
				return {
					[Symbol.asyncIterator]: async function* () {
						reached.resolve();
						await release.promise;
						yield { type: "done", reason: "deferred", message };
					},
					result: async () => message,
				} as unknown as ReturnType<Models["streamSimple"]>;
			};
			const cancel: Models["cancelDeferred"] = async (_model, receipt) => {
				expect(receipt).toEqual(handle);
				cancels++;
				if (cancellation === "failure") throw new Error("synthetic cancellation failure");
			};
			const models = new Proxy(base.models, {
				get(target, key) {
					if (key === "streamSimple") return stream;
					if (key === "cancelDeferred") return cancel;
					const value: unknown = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const opened = await openChat(storage, { ...base, models });
			await opened.root.submit({ type: "input", content: "hi" }, context);
			await reached.promise;
			const id = (await opened.harness.snapshot(LiveDoc, opened.root.id, context))!.run!.taskId;
			release.resolve();
			await waitFor(() => cancels > 0);
			await opened.harness.close(context);
			expect(storage.failures).toBe(2);
			expect(requests).toBe(1);
			const reopened = await openChat(storage, { ...base, models });
			try {
				if (cancellation === "failure") {
					expect((await reopened.harness.snapshot(Receipts, context))?.receipts[String(id)]).toMatchObject({
						status: "cancel_failed",
						checkpoint: { handle: { id: handle.id } },
					});
				} else {
					expect(await reopened.harness.getTask(id, context)).toMatchObject({
						abortRequested: true,
						state: { checkpoint: { acceptanceUncertain: false } },
					});
				}
				reopened.harness.resume();
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(requests).toBe(1);
			} finally {
				await reopened.harness.close(context);
			}
		});
	}
});
