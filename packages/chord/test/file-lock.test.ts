import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { acquireFileLock } from "../src/file-lock.ts";

// pi#244: a live owner must refuse takeover, but the same PID with a different start identity is stale.
it.skipIf(process.platform === "win32")("distinguishes a live guard from a reused PID", async () => {
	const directory = mkdtempSync(join(tmpdir(), "file-lock-"));
	const path = join(directory, "guard");
	try {
		const release = await acquireFileLock(path);
		await assert.rejects(acquireFileLock(path), /held/);
		const owner = JSON.parse(readFileSync(path, "utf8")) as { pid: number; start: string };
		release();
		writeFileSync(path, JSON.stringify({ ...owner, start: `${owner.start}-not-this-process` }));
		const recovered = await acquireFileLock(path);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), owner);
		recovered();
		assert.equal(existsSync(path), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

// pi#244: untrusted/malformed guard contents and symlinks do not establish a stale owner.
it.skipIf(process.platform === "win32")("refuses malformed and symlink guards without changing them", async () => {
	const directory = mkdtempSync(join(tmpdir(), "file-lock-"));
	const path = join(directory, "guard");
	const target = join(directory, "target");
	try {
		for (const content of ["", "null", '{"pid":0,"start":"fake"}', "x".repeat(4097)]) {
			writeFileSync(path, content);
			await assert.rejects(acquireFileLock(path), /held/);
			assert.equal(readFileSync(path, "utf8"), content);
		}
		rmSync(path);
		writeFileSync(target, "keep");
		symlinkSync(target, path);
		await assert.rejects(acquireFileLock(path), /held/);
		assert.equal(readFileSync(target, "utf8"), "keep");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

// pi#244: killing the recovery winner before its stale rename must not strand the recovery fence.
it.skipIf(process.platform === "win32")("recovers after the recovery winner itself crashes", async () => {
	const directory = mkdtempSync(join(tmpdir(), "recovery-crash-"));
	const name = `recovery-crash-${process.pid}`;
	const key = createHash("sha256").update(name).digest("hex").slice(0, 32);
	const address = join(directory, `chord2-${key}.sock`);
	const entry = fileURLToPath(new URL("./fixtures/socket-lock.ts", import.meta.url));
	const spawn = (mode: string) =>
		fork(entry, [mode, name], { cwd: directory, env: { ...process.env, TMPDIR: "." }, execArgv: [], stdio: "pipe" });
	const children = [spawn("crash")];
	try {
		assert.equal((await once(children[0]!, "message"))[0], "held");
		let exited = once(children[0]!, "exit");
		children[0]!.kill("SIGKILL");
		await exited;
		const recoverer = spawn("recover-crash");
		children.push(recoverer);
		assert.equal((await once(recoverer, "message"))[0], "stale");
		exited = once(recoverer, "exit");
		recoverer.kill("SIGKILL");
		await exited;
		assert.ok(existsSync(`${address}.lock`));
		const replacement = spawn("acquire");
		children.push(replacement);
		assert.equal((await once(replacement, "message"))[0], "held");
	} finally {
		await Promise.all(
			children.map(async (child) => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				const exited = once(child, "exit");
				if (child.connected) child.send("release");
				await exited;
			}),
		);
		rmSync(directory, { recursive: true, force: true });
	}
});
