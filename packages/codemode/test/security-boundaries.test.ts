import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../coding-agent/src/core/tools/atomic-write.ts";
import { createWriteTool } from "../../coding-agent/src/core/tools/write.ts";
import { CodemodeSandbox, type CodemodeSandboxOptions } from "../src/index.ts";
import {
	MAX_CALLS,
	MAX_MESSAGE_BYTES,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_ITEMS,
	MAX_OUTSTANDING_BYTES,
	MAX_OUTSTANDING_MESSAGES,
	MAX_PENDING_CALLS,
} from "../src/runtime/protocol.ts";

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

async function settledWithin(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([promise.then(() => true), delay(100).then(() => false)]);
}

afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((instance) => instance.close()));
});

describe("guest completion metadata", () => {
	// #2241 F2: captured JSON.stringify still consults mutable guest toJSON methods.
	it.each(["42", "null", "{}", '"not entries"'])(
		"contains non-array store metadata (%s) and retires the worker",
		async (replacement) => {
			const instance = sandbox();
			const ports = process.getActiveResourcesInfo().filter((resource) => resource === "MessagePort").length;
			const result = await instance.execute(`
				store("k", 1);
				Array.prototype.toJSON = () => (${replacement});
			`);
			expect(result).toMatchObject({ ok: false, error: { kind: "sandbox" } });
			await instance.close();
			expect(
				process.getActiveResourcesInfo().filter((resource) => resource === "MessagePort").length,
			).toBeLessThanOrEqual(ports);
		},
	);

	// #2241 F2: validate entries and encoded values, not only the outer JSON array.
	it.each(['["k", 7]', '["k", "not-json"]', '[1, "1"]', '["k", null]'])(
		"contains an invalid store entry (%s)",
		async (entry) => {
			const result = await sandbox().execute(`
				store("k", 1);
				Map.prototype[Symbol.iterator] = function* () { yield ${entry}; };
			`);
			expect(result).toMatchObject({ ok: false, error: { kind: "sandbox" } });
		},
	);

	// #2241 F2: malformed error metadata is also untrusted completion data.
	it("contains a poisoned error serializer without accepting a guest error kind", async () => {
		expect(await sandbox().execute(`Object.prototype.toJSON = () => 7; throw new Error("boom");`)).toMatchObject({
			ok: false,
			error: { kind: "sandbox" },
		});
		const result = await sandbox().execute(`
			Object.prototype.toJSON = function () {
				return { kind: "aborted", name: this.name, message: this.message, stack: this.stack };
			};
			throw new TypeError("ordinary script failure");
		`);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "script", name: "TypeError", message: "ordinary script failure" },
		});
	});

	// #2241 F2 counterexample: a serializer that throws is a normal script failure, not a stalled promise.
	it("observes failures while serializing writes", async () => {
		expect(
			await sandbox().execute(`
				Array.prototype.toJSON = () => { throw new Error("metadata serialization failed"); };
			`),
		).toMatchObject({ ok: false, error: { kind: "script", message: "metadata serialization failed" } });
	});

	// #2241 F2 counterexample: supported return/store/delete metadata, including arbitrary keys, stays intact.
	it("preserves valid public metadata and later runs", async () => {
		const instance = sandbox();
		const result = await instance.execute(
			`store("__proto__", { owned: true }); store("counter", load("counter") + 1);
			store("old", undefined); return { answer: 42 };`,
			{ store: { counter: 1, old: true } },
		);
		expect(result).toMatchObject({
			ok: true,
			value: { answer: 42 },
			storeWrites: { set: { counter: 2 }, delete: ["old"] },
		});
		if (!result.ok) throw new Error(result.error.message);
		expect(Object.hasOwn(result.storeWrites.set, "__proto__")).toBe(true);
		expect(result.storeWrites.set.__proto__).toEqual({ owned: true });
		expect(Object.getPrototypeOf(result.storeWrites.set)).toBe(Object.prototype);
		expect(await instance.execute("return 'next run'")).toMatchObject({ ok: true, value: "next run" });
	});
});

describe("host invocation retirement", () => {
	// #2241 F4: use the real built-in write + atomic rename and the public Agent hook dispatcher.
	// The operation gate makes abort-before-rename deterministic; cancellation does not stop that I/O.
	it.each(["abort", "deadline", "unawaited", "close"] as const)(
		"joins atomic write, after hook and recorder before settlement (%s)",
		async (mode) => {
			const directory = await mkdtemp(join(tmpdir(), "pi-codemode-security-"));
			const ioEntered = gate();
			const ioRelease = gate();
			const hookEntered = gate();
			const hookRelease = gate();
			const aborted = gate();
			const controller = new AbortController();
			let beforeCount = 0;
			let afterCount = 0;
			let abortCount = 0;
			const records: boolean[] = [];
			const write = createWriteTool(directory, {
				operations: {
					mkdir: async () => {},
					writeFile: async (path, content) => {
						ioEntered.release();
						await ioRelease.promise;
						await writeFileAtomic(path, content);
					},
				},
			});
			const instance = sandbox({
				tools: [
					{
						name: "write",
						execute: async (args, { signal }) => {
							signal.addEventListener(
								"abort",
								() => {
									abortCount++;
									aborted.release();
								},
								{ once: true },
							);
							const outcome = await runToolCall(
								{
									type: "toolCall",
									id: "parent/write",
									name: "write",
									arguments: args as { path: string; content: string },
								},
								{
									tools: [write],
									assistantMessage: fauxAssistantMessage("nested write"),
									context: { messages: [], tools: [write] },
									signal,
									beforeToolCall: async () => {
										beforeCount++;
										return undefined;
									},
									afterToolCall: async () => {
										afterCount++;
										hookEntered.release();
										await hookRelease.promise;
										return undefined;
									},
								},
							);
							records.push(outcome.isError);
							return outcome.result.content;
						},
					},
					{ name: "started", execute: () => ioEntered.promise },
				],
			});
			const script = `${mode === "unawaited" ? "" : "await "}tools.write({path: "target.txt", content: "committed"});
				${mode === "unawaited" ? "await tools.started();" : ""} return "early";`;
			const execution = instance.execute(script, {
				signal: controller.signal,
				timeoutMs: mode === "deadline" ? 1000 : Number.POSITIVE_INFINITY,
			});
			let closing: Promise<void> | undefined;
			try {
				await ioEntered.promise;
				if (mode === "abort") controller.abort(new Error("caller cancelled"));
				if (mode === "close") closing = instance.close();
				await aborted.promise;
				expect(await settledWithin(execution)).toBe(false);
				if (closing) expect(await settledWithin(closing)).toBe(false);
				expect(records).toEqual([]);

				ioRelease.release();
				await hookEntered.promise;
				expect(await readFile(join(directory, "target.txt"), "utf8")).toBe("committed");
				expect(await settledWithin(execution)).toBe(false);
				expect(records).toEqual([]);
				hookRelease.release();
				const result = await execution;
				expect(result).toMatchObject(
					mode === "unawaited"
						? { ok: true, value: "early" }
						: { ok: false, error: { kind: mode === "deadline" ? "timeout" : "aborted" } },
				);
				expect(result.calls.map((call) => [call.name, call.status])).toEqual(
					mode === "unawaited"
						? [
								["write", "cancelled"],
								["started", "ok"],
							]
						: [["write", "cancelled"]],
				);
				expect(beforeCount).toBe(1);
				expect(afterCount).toBe(1);
				expect(abortCount).toBe(1);
				expect(records).toEqual([true]);
				await closing;
				await delay(0);
				expect(records).toEqual([true]);
			} finally {
				ioRelease.release();
				hookRelease.release();
				await instance.close();
				await execution;
				await rm(directory, { recursive: true, force: true });
			}
		},
		10_000,
	);

	// #2241 F4: globals are unrecorded but their finally/cleanup promises still belong to the invocation.
	it("joins unawaited global cleanup and handles synchronous reentrant cancellation exactly once", async () => {
		const cleanup = gate();
		const cancelled = gate();
		const controller = new AbortController();
		let calls = 0;
		let cleanups = 0;
		const instance = sandbox({
			globals: [
				{
					name: "host.work",
					execute: async (_args, { signal }) => {
						calls++;
						controller.abort();
						if (signal.aborted) cancelled.release();
						try {
							return "unused";
						} finally {
							await cleanup.promise;
							cleanups++;
						}
					},
				},
			],
		});
		const execution = instance.execute("host.work(); return 1", { signal: controller.signal });
		try {
			await cancelled.promise;
			expect(await settledWithin(execution)).toBe(false);
			cleanup.release();
			expect(await execution).toMatchObject({ ok: false, error: { kind: "aborted" }, calls: [] });
			expect([calls, cleanups]).toEqual([1, 1]);
		} finally {
			cleanup.release();
			await instance.close();
		}
	});

	// #2241 F4 counterexample: ordinary awaited calls and outputs still complete once, without cancellation.
	it("keeps normal parallel calls and script errors working", async () => {
		let executions = 0;
		let aborts = 0;
		const instance = sandbox({
			tools: [
				{
					name: "echo",
					execute: (args, { signal }) => {
						executions++;
						signal.addEventListener("abort", () => aborts++);
						return args;
					},
				},
			],
		});
		const result = await instance.execute(`
			const values = await Promise.all([tools.echo(1), tools.echo(2)]);
			text(values); image("data:image/png;base64,AAAA"); console.log("done"); return values;
		`);
		expect(result).toMatchObject({ ok: true, value: [1, 2], calls: [{ status: "ok" }, { status: "ok" }] });
		expect(result.output).toEqual([
			{ type: "text", text: "[1,2]" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "text", text: "done" },
		]);
		expect([executions, aborts]).toEqual([2, 0]);
		expect(await instance.execute('throw new Error("normal")')).toMatchObject({
			ok: false,
			error: { kind: "script", message: "normal" },
		});
	});
});

describe("native emission admission", () => {
	// #2241 F5: unlimited deadlines do not permit infinite host-owned text/image item accumulation.
	it.each(['text("")', 'image("data:image/png;base64,AAAA")', 'console.log("x")'])(
		"stops an infinite emitter (%s), even if it catches exceptions",
		async (emit) => {
			const result = await sandbox().execute(`while (true) { try { ${emit}; } catch {} }`);
			expect(result).toMatchObject({ ok: false, error: { kind: "sandbox" } });
			expect(result.output.length).toBeLessThanOrEqual(MAX_OUTPUT_ITEMS);
		},
	);

	// #2241 F5: await a host call between emissions to return queue credit and isolate the total byte cap.
	it.each(["text", "image"] as const)("bounds total %s bytes before accumulation", async (kind) => {
		const emit = kind === "text" ? "text(chunk)" : 'image({ type: "image", data: chunk, mimeType: "image/png" })';
		const chunk = kind === "text" ? '"界".repeat(1024 * 1024)' : '"A".repeat(1024 * 1024)';
		const result = await sandbox({ tools: [{ name: "tick", execute: () => undefined }] }).execute(`
			const chunk = ${chunk};
			while (true) { ${emit}; await tools.tick(); }
		`);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("Output byte budget") },
		});
		const bytes = result.output.reduce(
			(sum, item) =>
				sum +
				(item.type === "text"
					? Buffer.byteLength(item.text)
					: Buffer.byteLength(item.data) + Buffer.byteLength(item.mimeType)),
			0,
		);
		expect(bytes).toBeGreaterThan(0);
		expect(bytes).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
	});

	// #2241 F5: reject a single oversize string before copying it from wasm into native messages.
	it.each(["text(value)", "return value", 'image({ type: "image", data: value, mimeType: "image/png" })'])(
		"bounds a single payload (%s)",
		async (emit) => {
			const result = await sandbox().execute(`const value = "x".repeat(${MAX_MESSAGE_BYTES + 1}); ${emit};`);
			expect(result).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: expect.stringContaining("Message byte budget") },
				output: [],
			});
		},
	);

	// #2241 F5: a slow host cannot leave an unbounded port queue, even when each output is tiny.
	it("bounds outstanding message items before postMessage", async () => {
		const instance = sandbox({
			tools: [
				{
					name: "block",
					execute: () => {
						Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
					},
				},
			],
		});
		const result = await instance.execute(
			`tools.block(); for (let i = 0; i < ${MAX_OUTSTANDING_MESSAGES + 10}; i++) text("x");`,
		);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("Outstanding message budget") },
		});
		expect(result.output.length).toBeLessThanOrEqual(MAX_OUTSTANDING_MESSAGES);
	});

	// #2241 F5: queued tool arguments also consume byte credit; output-only limits are insufficient.
	it("bounds outstanding message bytes before postMessage", async () => {
		const instance = sandbox({
			tools: [
				{
					name: "block",
					execute: () => {
						Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
					},
				},
				{ name: "echo", execute: () => undefined },
			],
		});
		const result = await instance.execute(`
			tools.block(); const chunk = "x".repeat(${MAX_OUTSTANDING_BYTES / 4});
			for (let i = 0; i < 8; i++) tools.echo(chunk);
		`);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("Outstanding message budget") },
			output: [],
		});
	});

	// #2241 F5: a spinning guest cannot make the host queue unbounded tool responses either.
	it("bounds host response bytes while the guest is not draining its port", async () => {
		const chunk = "x".repeat(MAX_OUTSTANDING_BYTES / 4);
		const instance = sandbox({ tools: [{ name: "large", execute: () => chunk }] });
		const result = await instance.execute("for (let i = 0; i < 16; i++) tools.large(); while (true) {}");
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("Outstanding host response budget") },
		});
	});

	// #2241 F5: pending tool effects and retained call metadata need bounds independently of port receipt.
	it("bounds concurrent calls and joins admitted calls on budget failure", async () => {
		let entered = 0;
		let cleaned = 0;
		const instance = sandbox({
			tools: [
				{
					name: "wait",
					execute: (_args, { signal }) => {
						entered++;
						return new Promise<void>((resolve) => {
							signal.addEventListener(
								"abort",
								() => {
									cleaned++;
									resolve();
								},
								{ once: true },
							);
						});
					},
				},
			],
		});
		const result = await instance.execute(`for (let i = 0; i < ${MAX_PENDING_CALLS + 1}; i++) tools.wait();`);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("Host call budget") },
		});
		expect(entered).toBeLessThanOrEqual(MAX_PENDING_CALLS);
		expect(cleaned).toBe(entered);
		expect(result.calls.length).toBeLessThanOrEqual(MAX_PENDING_CALLS);
	});

	// #2241 F5: sequential calls otherwise accumulate unlimited result.calls even with bounded concurrency.
	it("bounds total call metadata while allowing ordinary sequential calls", async () => {
		const instance = sandbox({ tools: [{ name: "echo", execute: (args) => args }] });
		expect(await instance.execute("return await tools.echo(42)")).toMatchObject({
			ok: true,
			value: 42,
			calls: [{ status: "ok" }],
		});
		const result = await instance.execute(`for (let i = 0; i < ${MAX_CALLS + 1}; i++) await tools.echo(i);`);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("Host call budget") },
		});
		expect(result.calls).toHaveLength(MAX_CALLS);
	}, 10_000);
});
