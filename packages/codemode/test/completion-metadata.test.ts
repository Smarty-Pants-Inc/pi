import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";

const sandboxes: CodemodeSandbox[] = [];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function completionSandbox(): Promise<CodemodeSandbox> {
	const directory = await mkdtemp(join(tmpdir(), "codemode-completion-"));
	directories.push(directory);
	const path = join(directory, "worker.mjs");
	await writeFile(
		path,
		'import { parentPort, workerData } from "node:worker_threads"; parentPort.postMessage(JSON.parse(workerData.code));',
	);
	const sandbox = new CodemodeSandbox({ workerUrl: pathToFileURL(path), timeoutMs: 1000 });
	sandboxes.push(sandbox);
	return sandbox;
}

// Dormant until reviewed re-enable: smarty-dev#4506 (pi#131 cutoff)
describe.skip("Reviewed re-enable", () => {
	// PR #107 F2: malformed completion must settle, not escape the worker message listener.
	it.each([
		{ type: "done", ok: true, writes: "{}" },
		{ type: "done", ok: true, writes: "null" },
		{ type: "done", ok: true, writes: "[null]" },
		{ type: "done", ok: true, writes: '[["key", 1]]' },
		{ type: "done", ok: true, writes: '[[7, "null"]]' },
		{ type: "done", ok: true, writes: '[["key", "not json"]]' },
		{ type: "done", ok: true, writes: '[["key", "null", "extra"]]' },
		{ type: "done", ok: true, writes: "[]", value: "not json" },
		{ type: "done", ok: true, writes: [] },
		{ type: "done", ok: true, writes: "[]", value: null },
		{ type: "done", ok: false, error: "not json" },
		{ type: "done", ok: false, error: "null" },
		{ type: "done", ok: false, error: "[]" },
		{ type: "done", ok: false, error: '{"message":7}' },
		{ type: "done", ok: false, error: '{"message":"bad","name":{}}' },
		{ type: "done", ok: false, error: '{"message":"bad","stack":[]}' },
		{ type: "done", ok: false, error: {} },
		{ type: "done", ok: "yes", writes: "[]" },
	])("contains malformed completion %#", async (message) => {
		const sandbox = await completionSandbox();
		expect(await sandbox.execute(JSON.stringify(message))).toMatchObject({ ok: false, error: { kind: "sandbox" } });
		await sandbox.close();
	});

	it("keeps guest error fields from replacing the host-owned error kind", async () => {
		const sandbox = await completionSandbox();
		expect(
			await sandbox.execute(
				JSON.stringify({ type: "done", ok: false, error: '{"message":"bad","kind":"timeout"}' }),
			),
		).toMatchObject({ ok: false, error: { kind: "script", message: "bad" } });
	});

	it.each([
		'Array.prototype.toJSON = () => ({}); store("key", 1); return 1;',
		'Object.prototype.toJSON = () => null; throw new Error("bad");',
	])("contains valid JSON forged by guest serialization intrinsics %#", async (code) => {
		const sandbox = new CodemodeSandbox({ timeoutMs: 1000 });
		sandboxes.push(sandbox);
		const result = await sandbox.execute(code);
		expect(result).toMatchObject({ ok: false, error: { kind: "sandbox" } });
		expect(await sandbox.execute("return 42")).toMatchObject({ ok: true, value: 42 });
	});

	it("preserves reserved store keys as own data", async () => {
		const sandbox = new CodemodeSandbox({ timeoutMs: 1000 });
		sandboxes.push(sandbox);
		const snapshot = JSON.parse('{"__proto__":{"saved":true},"constructor":2,"prototype":3}');
		const result = await sandbox.execute(
			'const saved = load("__proto__"); store("__proto__", { updated: true }); store("constructor", 4); store("prototype", undefined); return saved;',
			{ store: snapshot },
		);
		expect(result).toMatchObject({ ok: true, value: { saved: true } });
		if (!result.ok) throw new Error("Expected valid completion");
		expect(Object.getPrototypeOf(result.storeWrites.set)).toBeNull();
		expect(Object.hasOwn(result.storeWrites.set, "__proto__")).toBe(true);
		expect(result.storeWrites.set.__proto__).toEqual({ updated: true });
		expect(result.storeWrites.set.constructor).toBe(4);
		expect(result.storeWrites.delete).toEqual(["prototype"]);
	});
});
