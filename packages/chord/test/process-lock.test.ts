import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

const entry = fileURLToPath(new URL("./fixtures/socket-lock.ts", import.meta.url));

// pi#244: two stale probes can unlink each other's newly bound socket without an exclusive guard.
it.skipIf(process.platform === "win32")("admits exactly one concurrent owner of a stale socket file", async () => {
	const name = `stale-socket-${process.pid}`;
	const key = createHash("sha256").update(name).digest("hex").slice(0, 32);
	const address = join(tmpdir(), `chord2-${key}.sock`);
	const spawn = (mode: string, value: string) => fork(entry, [mode, value], { execArgv: [], stdio: "pipe" });
	const stale = spawn("stale", address);
	await once(stale, "exit");
	assert.ok(existsSync(address));
	const children = [spawn("race", name), spawn("race", name)];
	try {
		const first = await Promise.all(children.map(async (child) => (await once(child, "message"))[0]));
		const results: unknown[] = [];
		// Both probes happen before either unlink on the unfixed implementation. Delay the second unlink until the
		// first owner has bound, making the takeover race deterministic rather than relying on scheduling.
		for (const [i, child] of children.entries()) {
			if (first[i] === "stale") {
				const result = once(child, "message");
				child.send("unlink");
				results.push((await result)[0]);
			} else {
				results.push(first[i]);
			}
		}
		assert.equal(results.filter((result) => result === "held").length, 1);
		assert.equal(results.filter((result) => result === "locked").length, 1);
	} finally {
		await Promise.all(
			children.map(async (child) => {
				if (child.exitCode !== null) return;
				const exited = once(child, "exit");
				if (child.connected) child.send("release");
				await exited;
			}),
		);
		rmSync(address, { force: true });
		rmSync(`${address}.lock`, { force: true });
	}
});

// pi#244: an exclusive guard left by SIGKILL must not block restart forever.
it.skipIf(process.platform === "win32")("recovers a lock after its owner is killed", async () => {
	const name = `crashed-lock-${process.pid}`;
	const spawn = (mode: string) => fork(entry, [mode, name], { execArgv: [], stdio: "pipe" });
	const child = spawn("crash");
	try {
		assert.equal((await once(child, "message"))[0], "held");
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;

		const replacement = spawn("acquire");
		try {
			assert.equal((await once(replacement, "message"))[0], "held");
		} finally {
			if (replacement.exitCode === null) {
				const exited = once(replacement, "exit");
				if (replacement.connected) replacement.send("release");
				await exited;
			}
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
});

// pi#244: a recoverer delayed after the stale check must never move the winner's fresh guard.
it.skipIf(process.platform === "win32")("admits one owner when two processes recover one stale lock", async () => {
	const name = `concurrent-stale-lock-${process.pid}`;
	const spawn = () => fork(entry, ["recover-race", name], { execArgv: [], stdio: "pipe" });
	const owner = fork(entry, ["crash", name], { execArgv: [], stdio: "pipe" });
	assert.equal((await once(owner, "message"))[0], "held");
	const exited = once(owner, "exit");
	owner.kill("SIGKILL");
	await exited;

	const children = [spawn(), spawn()];
	try {
		const first = await Promise.all(children.map(async (child) => (await once(child, "message"))[0]));
		const results: unknown[] = [];
		for (const [i, child] of children.entries()) {
			if (first[i] === "stale") {
				const next = once(child, "message");
				child.send("recover");
				results.push((await next)[0]);
			} else {
				results.push(first[i]);
			}
		}
		assert.equal(results.filter((result) => result === "held").length, 1);
		assert.equal(results.filter((result) => result === "locked").length, 1);
	} finally {
		await Promise.all(
			children.map(async (child) => {
				if (child.exitCode !== null) return;
				const exited = once(child, "exit");
				if (child.connected) child.send("release");
				await exited;
			}),
		);
	}
});
