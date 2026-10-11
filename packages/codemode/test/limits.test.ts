/**
 * Host budgets for one execution (pi#131 round-1 P1-3 and P2-4, smarty-dev#4506). The sandbox
 * refuses to start while the Codemode switch is off, so these drive the host's Execution directly
 * with a worker that posts the messages a script could make the real worker send.
 */
import { describe, expect, it } from "vitest";
import { Execution } from "../src/runtime/host.ts";
import {
	BridgeBudget,
	type CodemodeLimits,
	checkCodemodeStoreQuota,
	resolveCodemodeLimits,
} from "../src/runtime/limits.ts";
import { MAX_STORE_TOTAL_CHARS, MAX_STORE_VALUE_CHARS } from "../src/runtime/prelude-source.ts";
import type { WorkerToHostMessage } from "../src/runtime/protocol.ts";
import type { CodemodeResult, CodemodeTool } from "../src/types.ts";
import type { CodemodeWasmModule } from "../src/wasm.ts";

const RAW_WORKER = new URL("./fixtures/raw-worker.ts", import.meta.url);

function run(
	messages: WorkerToHostMessage[],
	options: {
		limits?: Partial<CodemodeLimits>;
		tools?: CodemodeTool[];
		timeoutMs?: number;
		snapshot?: Record<string, unknown>;
	} = {},
): Promise<CodemodeResult> {
	return new Execution({
		code: JSON.stringify(messages),
		tools: new Map((options.tools ?? []).map((tool) => [tool.name, tool])),
		globals: new Map(),
		timeoutMs: options.timeoutMs ?? 10_000,
		signal: undefined,
		memoryLimitBytes: undefined,
		limits: resolveCodemodeLimits(options.limits),
		snapshot: options.snapshot ?? {},
		store: {},
		wasm: Promise.resolve({} as CodemodeWasmModule),
		workerUrl: RAW_WORKER,
	}).promise;
}

const call = (id: number, args?: string): WorkerToHostMessage => ({
	type: "call",
	id,
	target: "tool",
	name: "t",
	args,
});
const text = (chars: number): WorkerToHostMessage => ({
	type: "output",
	item: { type: "text", text: "x".repeat(chars) },
});
const hang: CodemodeTool = { name: "t", execute: () => new Promise(() => {}) };

describe("bridge deadline", () => {
	it("clamps an infinite timeout to the host maximum, so a call that never settles cannot hang the run", async () => {
		const started = performance.now();
		const result = await run([call(1)], {
			tools: [hang],
			timeoutMs: Number.POSITIVE_INFINITY,
			limits: { maxTimeoutMs: 100 },
		});
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "timeout", message: expect.stringContaining("100 ms") },
		});
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("rejects limits that are not finite", () => {
		expect(() => resolveCodemodeLimits({ maxTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(/maxTimeoutMs/);
		expect(() => resolveCodemodeLimits({ maxPendingCalls: 0 })).toThrow(/maxPendingCalls/);
	});
});

describe("bridge budgets", () => {
	it("fails a message over the per-message limit before keeping it", async () => {
		const result = await run([text(101)], { limits: { maxMessageChars: 100 } });
		expect(result).toMatchObject({ ok: false, error: { kind: "limit" }, output: [] });
	});

	it("fails when all messages together pass the total limit", async () => {
		const result = await run([text(60), text(60), text(60)], { limits: { maxTotalChars: 100 } });
		expect(result).toMatchObject({ ok: false, error: { kind: "limit" } });
		expect(result.output).toHaveLength(1);
	});

	it("counts call arguments against the byte budget", async () => {
		const result = await run([call(1, "1".repeat(200))], { tools: [hang], limits: { maxMessageChars: 100 } });
		expect(result).toMatchObject({ ok: false, error: { kind: "limit" }, calls: [] });
	});

	it("fails a script that starts more calls than the call budget", async () => {
		const echo: CodemodeTool = { name: "t", execute: () => 1 };
		const result = await run([call(1), call(2), call(3), call(4)], { tools: [echo], limits: { maxCalls: 3 } });
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "limit", message: expect.stringContaining("3 calls") },
		});
		expect(result.calls).toHaveLength(3);
	});

	it("fails a script with more calls in flight than the waiter budget, and cancels the waiting calls", async () => {
		const signals: AbortSignal[] = [];
		const waiting: CodemodeTool = {
			name: "t",
			execute: (_args, { signal }) => {
				signals.push(signal);
				return new Promise(() => {});
			},
		};
		const result = await run([call(1), call(2), call(3)], { tools: [waiting], limits: { maxPendingCalls: 2 } });
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "limit", message: expect.stringContaining("in flight") },
		});
		expect(signals).toHaveLength(2);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
	});

	it("fails a tool reply over the per-message limit instead of posting it", async () => {
		const big: CodemodeTool = { name: "t", execute: () => "y".repeat(200) };
		const result = await run([call(1)], { tools: [big], limits: { maxMessageChars: 100 } });
		expect(result).toMatchObject({ ok: false, error: { kind: "limit" } });
	});

	it("maps a worker-side limit report to a limit error", async () => {
		const result = await run([{ type: "limit", message: "over" }]);
		expect(result).toMatchObject({ ok: false, error: { kind: "limit", message: "over" } });
	});

	it("is the same check the worker runs before it posts", () => {
		const budget = new BridgeBudget(resolveCodemodeLimits({ maxPendingCalls: 1 }));
		budget.charge(call(1));
		expect(() => budget.charge(call(2))).toThrow(/in flight/);
		budget.settle(0);
		budget.settle(0);
		expect(() => budget.charge(call(3))).not.toThrow();
	});
});

describe("host store quotas", () => {
	const writesJson = (entries: [string, string?][]) => JSON.stringify(entries);

	it("fails a run whose store writes pass the value quota, whatever the guest checked", async () => {
		const value = JSON.stringify("v".repeat(MAX_STORE_VALUE_CHARS));
		const result = await run([{ type: "done", ok: true, value: undefined, writes: writesJson([["k", value]]) }]);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "limit", message: expect.stringContaining("store quota") },
		});
	});

	// Four values just under the value quota fill the store just under the total quota.
	const big = "v".repeat(MAX_STORE_VALUE_CHARS - 10);
	const full = { a: big, b: big, c: big, d: big };

	it("fails a run whose writes fit alone but overflow the snapshot it started from", async () => {
		const result = await run(
			[{ type: "done", ok: true, value: undefined, writes: writesJson([["e", JSON.stringify(big)]]) }],
			{ snapshot: full },
		);
		expect(result).toMatchObject({ ok: false, error: { kind: "limit" } });
	});

	it("bounds deletion keys (tombstones) like writes", () => {
		const keys = Array.from({ length: 200 }, (_, index) => `${index}`.padEnd(10_000, "k"));
		expect(() => checkCodemodeStoreQuota({}, { set: {}, delete: keys })).toThrow(/writes exceed/);
	});

	it("checks the merged state, so two disjoint commits that each fit an old snapshot cannot both persist", () => {
		expect(JSON.stringify(full).length).toBeLessThan(MAX_STORE_TOTAL_CHARS);
		expect(() => checkCodemodeStoreQuota({}, { set: { e: big }, delete: [] })).not.toThrow();
		expect(() => checkCodemodeStoreQuota(full, { set: { e: big }, delete: [] })).toThrow(/store would exceed/);
		expect(() => checkCodemodeStoreQuota(full, { set: { e: big }, delete: ["a"] })).not.toThrow();
	});

	it("keeps writes within the quotas", async () => {
		const result = await run([{ type: "done", ok: true, value: "1", writes: writesJson([["k", '"v"'], ["gone"]]) }]);
		expect(result).toMatchObject({ ok: true, value: 1, storeWrites: { set: { k: "v" }, delete: ["gone"] } });
	});
});
