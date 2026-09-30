import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	CodemodeSandbox,
	type CodemodeSandboxOptions,
	type CodemodeTool,
	MAX_STORE_TOTAL_CHARS,
	MAX_STORE_VALUE_CHARS,
} from "../src/index.ts";
import { MAX_MESSAGE_BYTES } from "../src/runtime/protocol.ts";

const sandboxes: CodemodeSandbox[] = [];
function sandbox(options: CodemodeSandboxOptions = {}): CodemodeSandbox {
	const instance = new CodemodeSandbox({ timeoutMs: Number.POSITIVE_INFINITY, ...options });
	sandboxes.push(instance);
	return instance;
}

function gate(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function settledWithin(promise: Promise<unknown>, milliseconds = 100): Promise<boolean> {
	return Promise.race([promise.then(() => true), delay(milliseconds).then(() => false)]);
}

function forgedWrites(entries: readonly (readonly string[])[]): string {
	return `Map.prototype[Symbol.iterator] = function* () { yield* ${JSON.stringify(entries)}; };`;
}

function stringValue(jsonChars: number): string {
	return "x".repeat(jsonChars - 2);
}

function fullStore(): Record<string, unknown> {
	return Object.fromEntries(
		["a", "b", "c", "d"].map((key, index) => [key, stringValue(MAX_STORE_VALUE_CHARS - (index === 3 ? 4 : 0))]),
	);
}

afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((instance) => instance.close()));
});

describe("host persistent-store admission", () => {
	// #2241 F19/Astra3: valid-shaped metadata can bypass the guest's store() checks.
	it("rejects a forged oversized JSON value below the native message cap", async () => {
		const json = JSON.stringify(stringValue(MAX_STORE_VALUE_CHARS + 1));
		expect(json.length).toBe(MAX_STORE_VALUE_CHARS + 1);
		expect(json.length).toBeLessThan(MAX_MESSAGE_BYTES);
		const result = await sandbox().execute(forgedWrites([["big", json]]));
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("value exceeds") },
		});
		expect(result).not.toHaveProperty("storeWrites");
	});

	// #2241 F19: valid-shaped aggregate metadata and arbitrary string keys consume quota too.
	it.each(["values", "key", "whitespace"] as const)(
		"rejects oversized effective aggregate metadata (%s)",
		async (kind) => {
			const entries =
				kind === "key"
					? [["k".repeat(MAX_STORE_TOTAL_CHARS), "0"]]
					: ["a", "b", "c", "d", "e"].map((key) => [
							key,
							kind === "whitespace"
								? `${" ".repeat(MAX_STORE_VALUE_CHARS - 1)}0`
								: JSON.stringify(stringValue(MAX_STORE_VALUE_CHARS)),
						]);
			expect(await sandbox().execute(forgedWrites(entries))).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: expect.stringContaining("store is full") },
			});
		},
	);

	// #2241 F19 counterexample: store quotas do not replace the native 16-MiB output message cap.
	it("keeps the native output boundary independent of the store quota", async () => {
		const result = await sandbox().execute(`text("x".repeat(${MAX_MESSAGE_BYTES})); return 42;`);
		expect(result).toMatchObject({ ok: true, value: 42 });
		expect(result.output).toHaveLength(1);
		const item = result.output[0];
		expect(item.type).toBe("text");
		if (item.type !== "text") throw new Error("Expected text output");
		expect(item.text.length).toBe(MAX_MESSAGE_BYTES);
		expect(await sandbox().execute(`text("x".repeat(${MAX_MESSAGE_BYTES + 1}));`)).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("Message byte budget") },
		});
	});

	// #2241 F19: incoming snapshots must be checked before a worker or host callback starts.
	it.each(["value", "aggregate"] as const)("rejects an oversized initial snapshot (%s)", async (kind) => {
		let called = false;
		const instance = sandbox({
			tools: [
				{
					name: "effect",
					execute: () => {
						called = true;
					},
				},
			],
		});
		const store = kind === "value" ? { big: stringValue(MAX_STORE_VALUE_CHARS + 1) } : { ...fullStore(), extra: 0 };
		await expect(async () => instance.execute("await tools.effect(); return 1", { store })).rejects.toThrow(/store/i);
		expect(called).toBe(false);
		expect(await instance.execute("return 2")).toMatchObject({ ok: true, value: 2 });
	});

	// #2241 F19: the host must account for the effective persisted store across public runs.
	it("blocks accumulation across runs without discarding the last admitted snapshot", async () => {
		const instance = sandbox();
		const saved = new Map<string, unknown>();
		const value = stringValue(MAX_STORE_VALUE_CHARS - 1);
		for (const key of ["a", "b", "c", "d"]) {
			const result = await instance.execute(forgedWrites([[key, JSON.stringify(value)]]), {
				store: Object.fromEntries(saved),
			});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(result.error.message);
			for (const deleted of result.storeWrites.delete) saved.delete(deleted);
			for (const [name, stored] of Object.entries(result.storeWrites.set)) saved.set(name, stored);
		}
		const result = await instance.execute(forgedWrites([["e", "0"]]), { store: Object.fromEntries(saved) });
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("store is full") },
		});
		expect(result).not.toHaveProperty("storeWrites");
		expect(saved.size).toBe(4);
		expect(await instance.execute('return load("a").length', { store: Object.fromEntries(saved) })).toMatchObject({
			ok: true,
			value: value.length,
		});
	});

	// #2241 F19 counterexample: quota counts JSON characters plus keys, not UTF-8 bytes.
	it("accepts exact per-value and aggregate boundaries and accounts for replacements/deletions", async () => {
		const instance = sandbox();
		const store = fullStore();
		expect(
			Object.entries(store).reduce((sum, [key, value]) => sum + key.length + JSON.stringify(value).length, 0),
		).toBe(MAX_STORE_TOTAL_CHARS);
		expect(await instance.execute('return load("a").length', { store })).toMatchObject({
			ok: true,
			value: MAX_STORE_VALUE_CHARS - 2,
		});
		const replacement = JSON.stringify("界".repeat(MAX_STORE_VALUE_CHARS - 2));
		expect(await instance.execute(forgedWrites([["a", replacement]]), { store })).toMatchObject({
			ok: true,
			storeWrites: { set: { a: "界".repeat(MAX_STORE_VALUE_CHARS - 2) }, delete: [] },
		});
		// The final write set is applied after deletions. An insertion may precede its freeing deletion.
		expect(await instance.execute(forgedWrites([["e", JSON.stringify(store.a)], ["a"]]), { store })).toMatchObject({
			ok: true,
			storeWrites: { set: { e: store.a }, delete: ["a"] },
		});
		expect(await instance.execute('store("a", undefined); store("e", "x".repeat(262142));', { store })).toMatchObject(
			{
				ok: true,
				storeWrites: { delete: ["a"] },
			},
		);
	});

	// #2241 F19: duplicates must use the public delete-then-set persistence semantics, not last-entry wins.
	it("does not let duplicate set/delete entries undercount returned writes", async () => {
		const result = await sandbox().execute(forgedWrites([["extra", "0"], ["extra"]]), { store: fullStore() });
		expect(result).toMatchObject({ ok: false, error: { kind: "sandbox" } });
	});

	// #2241 F19: a compact numeric encoding can expand when the persisted value is serialized next run.
	it("accounts for normalized JSON values as well as the incoming JSON text", async () => {
		const json = `[${"1e20,".repeat(12000)}0]`;
		expect(json.length).toBeLessThan(MAX_STORE_VALUE_CHARS);
		expect(JSON.stringify(JSON.parse(json)).length).toBeGreaterThan(MAX_STORE_VALUE_CHARS);
		expect(await sandbox().execute(forgedWrites([["numbers", json]]))).toMatchObject({
			ok: false,
			error: { kind: "sandbox" },
		});
	});

	// #2241 F19 counterexample: arbitrary reserved keys remain own data in snapshots and completions.
	it("preserves reserved keys, deletion, output and ordinary script errors", async () => {
		const store = Object.fromEntries(["__proto__", "constructor", "toString"].map((key) => [key, { kept: true }]));
		const result = await sandbox().execute(
			`
			text("ordinary output");
			store("__proto__", { count: 2 }); store("constructor", undefined);
			return [load("toString"), load("__proto__")];
		`,
			{ store },
		);
		expect(result).toMatchObject({
			ok: true,
			value: [{ kept: true }, { count: 2 }],
			output: [{ type: "text", text: "ordinary output" }],
		});
		if (!result.ok) throw new Error(result.error.message);
		expect(Object.hasOwn(result.storeWrites.set, "__proto__")).toBe(true);
		expect(result.storeWrites.set.__proto__).toEqual({ count: 2 });
		expect(result.storeWrites.delete).toEqual(["constructor"]);
		expect(Object.getPrototypeOf(result.storeWrites.set)).toBe(Object.prototype);
		expect(await sandbox().execute('throw new Error("ordinary")')).toMatchObject({
			ok: false,
			error: { kind: "script", message: "ordinary" },
		});
	});
});

describe("public sandbox reentrant retirement", () => {
	// #2241 F24/Astra2: awaiting close inside a retained callback must not join itself.
	it.each(["tool", "global"] as const)(
		"allows awaited close inside a normal %s callback but externally drains hooks",
		async (target) => {
			const entered = gate();
			const request = gate();
			const closeReturned = gate();
			const hook = gate();
			const events: string[] = [];
			let selfCloseSettled = false;
			let instance!: CodemodeSandbox;
			const callback: CodemodeTool = {
				name: "retire",
				execute: async () => {
					entered.release();
					await request.promise;
					// Bounded race breaks the original self-deadlock so this regression cleans up on the old head.
					selfCloseSettled = await settledWithin(
						(async () => {
							await instance.close();
						})(),
						200,
					);
					closeReturned.release();
					events.push("effect");
					await hook.promise;
					events.push("hook");
				},
			};
			instance = sandbox(target === "tool" ? { tools: [callback] } : { globals: [callback] });
			const execution = instance.execute(target === "tool" ? "await tools.retire()" : "await retire()");
			try {
				await entered.promise;
				request.release();
				await closeReturned.promise;
				const closing = instance.close();
				expect(await settledWithin(closing)).toBe(false);
				expect(await settledWithin(execution)).toBe(false);
				expect(events).toEqual(["effect"]);
				hook.release();
				expect(await execution).toMatchObject({ ok: false, error: { kind: "aborted" } });
				await closing;
				expect(events).toEqual(["effect", "hook"]);
				expect(selfCloseSettled).toBe(true);
				await expect(instance.execute("return 1")).rejects.toThrow("closed");
			} finally {
				request.release();
				hook.release();
				await instance.close();
			}
		},
	);

	// #2241 F24: external cancellation dispatches abort listeners in the caller's context.
	it.each(["tool", "global"] as const)(
		"allows awaited close in %s abort cleanup without releasing the external drain",
		async (target) => {
			const entered = gate();
			const cleanupReturned = gate();
			const hook = gate();
			const controller = new AbortController();
			let selfCloseSettled = false;
			let cleaned = false;
			let instance!: CodemodeSandbox;
			const callback: CodemodeTool = {
				name: "retire",
				execute: async (_args, { signal }) => {
					const cancelled = new Promise<void>((resolve) => {
						signal.addEventListener(
							"abort",
							() => {
								void settledWithin(
									(async () => {
										await instance.close();
									})(),
									200,
								).then((settled) => {
									selfCloseSettled = settled;
									cleanupReturned.release();
									resolve();
								});
							},
							{ once: true },
						);
					});
					entered.release();
					await cancelled;
					await hook.promise;
					cleaned = true;
				},
			};
			instance = sandbox(target === "tool" ? { tools: [callback] } : { globals: [callback] });
			const execution = instance.execute(target === "tool" ? "await tools.retire()" : "await retire()", {
				signal: controller.signal,
			});
			try {
				await entered.promise;
				controller.abort();
				await cleanupReturned.promise;
				const closing = instance.close();
				expect(await settledWithin(closing)).toBe(false);
				expect(await settledWithin(execution)).toBe(false);
				expect(cleaned).toBe(false);
				hook.release();
				expect(await execution).toMatchObject({ ok: false, error: { kind: "aborted" } });
				await closing;
				expect(cleaned).toBe(true);
				expect(selfCloseSettled).toBe(true);
			} finally {
				hook.release();
				await instance.close();
			}
		},
	);

	// #2241 F24 counterexample: closing another sandbox from host code must still drain that sandbox.
	it("does not treat another sandbox's callback as a self-join", async () => {
		const entered = gate();
		const effect = gate();
		const closingEntered = gate();
		let effectDone = false;
		let closeDone = false;
		const target = sandbox({
			tools: [
				{
					name: "work",
					execute: async () => {
						entered.release();
						await effect.promise;
						effectDone = true;
					},
				},
			],
		});
		const caller = sandbox({
			tools: [
				{
					name: "retire",
					execute: async () => {
						closingEntered.release();
						await target.close();
						closeDone = true;
					},
				},
			],
		});
		const targetExecution = target.execute("await tools.work()");
		try {
			await entered.promise;
			const callerExecution = caller.execute("await tools.retire()");
			await closingEntered.promise;
			expect(await settledWithin(callerExecution)).toBe(false);
			expect([effectDone, closeDone]).toEqual([false, false]);
			effect.release();
			expect(await targetExecution).toMatchObject({ ok: false, error: { kind: "aborted" } });
			expect(await callerExecution).toMatchObject({ ok: true });
			expect([effectDone, closeDone]).toEqual([true, true]);
		} finally {
			effect.release();
			await Promise.all([target.close(), caller.close()]);
		}
	});

	// #2241 F24 counterexample: an inherited context is no longer a self-join once its callback settles.
	it("drains effects when close comes from a retired callback's inherited context", async () => {
		const request = gate();
		const closeEntered = gate();
		const entered = gate();
		const effect = gate();
		let closing = Promise.resolve();
		let closeDone = false;
		let instance!: CodemodeSandbox;
		instance = sandbox({
			tools: [
				{
					name: "schedule",
					execute: () => {
						closing = (async () => {
							await request.promise;
							closeEntered.release();
							await instance.close();
							closeDone = true;
						})();
					},
				},
				{
					name: "work",
					execute: async () => {
						entered.release();
						await effect.promise;
					},
				},
			],
		});
		try {
			expect(await instance.execute("await tools.schedule()")).toMatchObject({ ok: true });
			const execution = instance.execute("await tools.work()");
			await entered.promise;
			request.release();
			await closeEntered.promise;
			expect(await settledWithin(closing)).toBe(false);
			expect(closeDone).toBe(false);
			effect.release();
			await Promise.all([execution, closing]);
			expect(closeDone).toBe(true);
		} finally {
			request.release();
			effect.release();
			await instance.close();
			await closing;
		}
	});

	// #2241 F24 counterexample: ordinary external closes must retain effects and finally hooks.
	it("makes concurrent external closes wait for effects and finally hooks", async () => {
		const entered = gate();
		const effect = gate();
		const hookEntered = gate();
		const hook = gate();
		const events: string[] = [];
		const instance = sandbox({
			tools: [
				{
					name: "work",
					execute: async () => {
						entered.release();
						try {
							await effect.promise;
							events.push("effect");
						} finally {
							hookEntered.release();
							await hook.promise;
							events.push("hook");
						}
					},
				},
			],
		});
		const execution = instance.execute("await tools.work()");
		try {
			await entered.promise;
			const first = instance.close();
			const second = instance.close();
			expect(await settledWithin(Promise.race([first, second]))).toBe(false);
			effect.release();
			await hookEntered.promise;
			expect(events).toEqual(["effect"]);
			expect(await settledWithin(Promise.race([first, second, execution]))).toBe(false);
			hook.release();
			await Promise.all([first, second, execution]);
			expect(events).toEqual(["effect", "hook"]);
		} finally {
			effect.release();
			hook.release();
			await instance.close();
		}
	});
});
