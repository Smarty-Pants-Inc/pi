import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listenSocket } from "./issues/socket.ts";

// pi#244: TRIAGE_SOCKET must not delete regular files, including paths reached through symlinks.
test("triage refuses non-socket paths without changing them", { skip: process.platform === "win32" }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "triage-"));
	const file = join(directory, "data");
	const link = join(directory, "link");
	writeFileSync(file, "keep me");
	symlinkSync(file, link);
	try {
		await assert.rejects(listenSocket(createServer(), file), /not a socket/);
		await assert.rejects(listenSocket(createServer(), link), /not a socket/);
		assert.equal(readFileSync(file, "utf8"), "keep me");
		assert.ok(existsSync(link));
		await assert.rejects(listenSocket(createServer(), directory), /not a socket/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

// pi#244: restarting triage may only remove a socket after proving that it no longer accepts connections.
test("triage preserves active sockets and removes stale sockets", { skip: process.platform === "win32" }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "triage-"));
	const path = join(directory, "s");
	const stale = join(directory, "stale");
	const server = createServer((socket) => socket.end());
	const replacement = createServer((socket) => socket.end());
	const fresh = createServer((socket) => socket.end());
	try {
		server.listen(path);
		await once(server, "listening");
		await assert.rejects(listenSocket(createServer(), path), /in use/);
		const probe = connect(path);
		await once(probe, "connect");
		probe.destroy();
		// Closing unlinks the original name, not the renamed inode. The renamed path is now a real stale socket.
		renameSync(path, stale);
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		assert.ok(existsSync(stale));
		await listenSocket(replacement, stale);
		assert.ok(replacement.listening);
		await new Promise<void>((resolve) => replacement.close(() => resolve()));
		assert.ok(!existsSync(stale));
		assert.ok(!existsSync(`${stale}.lock`));
		await listenSocket(fresh, path); // An absent path needs no cleanup.
	} finally {
		for (const current of [server, replacement, fresh]) {
			if (current.listening) await new Promise<void>((resolve) => current.close(() => resolve()));
		}
		rmSync(directory, { recursive: true, force: true });
	}
});

// pi#244 / SECURITY delta round 1: pause both starters after their inode check, then interleave unlink and bind.
test("triage admits one concurrent stale-socket starter", { skip: process.platform === "win32" }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "triage-"));
	const path = join(directory, "s");
	const original = join(directory, "original");
	const seed = createServer();
	seed.listen(original);
	await once(seed, "listening");
	renameSync(original, path);
	await new Promise<void>((resolve) => seed.close(() => resolve()));
	const fixture = join(directory, "starter.mjs");
	const module = fileURLToPath(new URL("./issues/socket.ts", import.meta.url));
	writeFileSync(fixture, `
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { listenSocket } from ${JSON.stringify(module)};
const path = process.argv[2];
const unlink = fs.unlink;
fs.unlink = async (file) => {
    if (file === path) {
        process.send("checked");
        await new Promise((resolve) => process.once("message", resolve));
    }
    return unlink(file);
};
syncBuiltinESMExports();
const server = createServer((socket) => socket.end());
try {
    await listenSocket(server, path);
    process.send("held");
    process.once("message", () => server.close(() => process.exit(0)));
} catch (error) {
    process.send("blocked");
    process.exit(0);
}
`);
	const children = [
		fork(fixture, [path], { execArgv: [], stdio: "pipe" }),
		fork(fixture, [path], { execArgv: [], stdio: "pipe" }),
	];
	try {
		const first = await Promise.all(children.map(async (child) => (await once(child, "message"))[0]));
		const results: unknown[] = [];
		for (const [i, child] of children.entries()) {
			if (first[i] === "checked") {
				const result = once(child, "message");
				child.send("unlink");
				results.push((await result)[0]);
			} else {
				results.push(first[i]);
			}
		}
		assert.equal(results.filter((result) => result === "held").length, 1);
		assert.equal(results.filter((result) => result === "blocked").length, 1);
	} finally {
		await Promise.all(children.map(async (child) => {
			if (child.exitCode !== null) return;
			const exited = once(child, "exit");
			if (child.connected) child.send("close");
			await exited;
		}));
		rmSync(directory, { recursive: true, force: true });
	}
});

// pi#244: crash-stale startup guards must recover, including competing recoverers delayed before publication.
for (const concurrent of [false, true]) {
	test(`triage recovers a killed owner${concurrent ? " with one concurrent winner" : ""}`, { skip: process.platform === "win32" }, async () => {
		const directory = mkdtempSync(join(tmpdir(), "triage-crash-"));
		const path = join(directory, "s");
		const entry = fileURLToPath(new URL("./fixtures/issues-socket-child.ts", import.meta.url));
		const owner = fork(entry, [path, "hold"], { execArgv: [], stdio: "pipe" });
		assert.equal((await once(owner, "message"))[0], "held");
		const dead = once(owner, "exit");
		owner.kill("SIGKILL");
		await dead;
		const children = Array.from({ length: concurrent ? 2 : 1 }, () => fork(entry, [path, concurrent ? "recover-race" : "hold"], { execArgv: [], stdio: "pipe" }));
		try {
			const first = await Promise.all(children.map(async (child) => (await once(child, "message"))[0]));
			const results: unknown[] = [];
			for (const [i, child] of children.entries()) {
				if (first[i] === "stale") {
					const next = once(child, "message");
					child.send("recover");
					results.push((await next)[0]);
				} else results.push(first[i]);
			}
			assert.equal(results.filter((result) => result === "held").length, 1);
			assert.equal(results.filter((result) => result === "blocked").length, concurrent ? 1 : 0);
		} finally {
			await Promise.all(children.map(async (child) => {
				if (child.exitCode !== null) return;
				const exited = once(child, "exit");
				if (child.connected) child.send("close");
				await exited;
			}));
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
