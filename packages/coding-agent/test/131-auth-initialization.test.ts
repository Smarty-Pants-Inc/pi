import { type ChildProcess, spawn } from "node:child_process";
import type * as NativeFs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof NativeFs>();
	return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

// PR #131 P2-20: interleave a separate-process public save after wx open, before its body write.
it.each(["sync", "async"] as const)("preserves a public grant during %s first-file initialization", async (kind) => {
	const fs = await vi.importActual<typeof NativeFs>("fs");
	const root = mkdtempSync(join(tmpdir(), "pi-auth-initialization-"));
	const authPath = join(root, "auth.json");
	const startedPath = join(root, "started");
	const savedPath = join(root, "saved");
	let child: ChildProcess | undefined;
	let childResult: Promise<number | null> | undefined;
	let stderr = "";
	let opened = false;
	let lockedAtOpen = false;
	let savedBeforeBody = false;
	const pause = new Int32Array(new SharedArrayBuffer(4));
	vi.mocked(writeFileSync).mockImplementation((...args) => {
		const [path, data, options] = args;
		if (path !== authPath || typeof options !== "object" || options?.flag !== "wx") {
			return fs.writeFileSync(...args);
		}
		const fd = fs.openSync(authPath, "wx", 0o600);
		opened = true;
		try {
			lockedAtOpen = fs.existsSync(`${authPath}.lock`);
			child = spawn(
				process.execPath,
				[
					fileURLToPath(new URL("./fixtures/auth-public-writer.ts", import.meta.url)),
					authPath,
					startedPath,
					savedPath,
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			childResult = new Promise((resolve, reject) => {
				child?.once("error", reject);
				child?.once("close", resolve);
			});
			const deadline = Date.now() + 5000;
			while (!fs.existsSync(startedPath) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 10);
			if (!fs.existsSync(startedPath)) throw new Error("Public writer did not start");
			// Without a lock, reproduce the audit's complete save before the initializer body.
			// With a lock, give the writer a real opportunity to contend, then release initialization.
			const saveDeadline = Date.now() + (lockedAtOpen ? 100 : 5000);
			while (!fs.existsSync(savedPath) && Date.now() < saveDeadline) Atomics.wait(pause, 0, 0, 10);
			savedBeforeBody = fs.existsSync(savedPath);
			fs.writeFileSync(fd, data, options);
		} finally {
			fs.closeSync(fd);
		}
	});
	try {
		const backend = new FileAuthStorageBackend(authPath);
		if (kind === "sync") backend.withLock(() => ({ result: undefined }));
		else await backend.withLockAsync(async () => ({ result: undefined }));
		expect(await childResult, stderr).toBe(0);
		expect(opened).toBe(true);
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
			"fake-provider": { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 12345 },
		});
		expect(lockedAtOpen).toBe(true);
		expect(savedBeforeBody).toBe(false);
		if (process.platform !== "win32") expect(statSync(authPath).mode & 0o777).toBe(0o600);
	} finally {
		vi.mocked(writeFileSync).mockRestore();
		if (child?.exitCode === null) child.kill();
		await childResult;
		rmSync(root, { recursive: true, force: true });
	}
});
