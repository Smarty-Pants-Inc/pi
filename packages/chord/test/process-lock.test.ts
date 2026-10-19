import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

const entry = fileURLToPath(new URL("./fixtures/socket-lock.ts", import.meta.url));

type ChildExit = readonly [number | null, NodeJS.Signals | null];

function waitForChildExit(child: ChildProcess): Promise<ChildExit> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve([child.exitCode, child.signalCode] as const);
	}
	return new Promise<ChildExit>((resolve, reject) => {
		let failure: Error | undefined;
		const cleanup = (): void => {
			child.removeListener("exit", onExit);
			child.removeListener("error", onError);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			cleanup();
			if (failure !== undefined) reject(failure);
			else resolve([code, signal]);
		};
		const onError = (error: Error): void => {
			if (child.pid === undefined) {
				cleanup();
				reject(error);
				return;
			}
			failure ??= error;
			if (!child.killed) child.kill("SIGKILL");
		};
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

async function waitForChildMessage(child: ChildProcess): Promise<unknown> {
	const result = await Promise.race([
		once(child, "message").then(([message]) => ({ message })),
		waitForChildExit(child).then(([code, signal]) => ({ exit: { code, signal } })),
	]);
	if ("exit" in result) {
		throw new Error(
			`child exited before sending an IPC message (code ${result.exit.code}, signal ${result.exit.signal})`,
		);
	}
	return result.message;
}

function sendChildMessage(child: ChildProcess, message: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		try {
			child.send(message, (error) => {
				if (error) reject(error);
				else resolve();
			});
		} catch (error) {
			reject(error);
		}
	});
}

async function killAndWait(child: ChildProcess): Promise<ChildExit> {
	if (child.pid === undefined && child.exitCode === null && child.signalCode === null) {
		return [child.exitCode, child.signalCode];
	}
	const exited = waitForChildExit(child);
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	return exited;
}

function isReportedChildError(outcome: unknown): outcome is { readonly type: "error"; readonly message: string } {
	return (
		typeof outcome === "object" &&
		outcome !== null &&
		"type" in outcome &&
		outcome.type === "error" &&
		"message" in outcome &&
		typeof outcome.message === "string"
	);
}

async function finishChild(child: ChildProcess, outcome: unknown): Promise<void> {
	if (child.pid === undefined && child.exitCode === null && child.signalCode === null) return;
	const exited = waitForChildExit(child);
	if (outcome === "held") {
		if (child.exitCode !== null || child.signalCode !== null) {
			const [code, signal] = await exited;
			assert.fail(`held child exited before release (code ${code}, signal ${signal})`);
		}
		if (!child.connected) {
			await killAndWait(child);
			assert.fail("held child disconnected before release");
		}
		try {
			await sendChildMessage(child, "release");
		} catch (error) {
			await killAndWait(child);
			throw error;
		}
	} else if (outcome !== "locked" && !isReportedChildError(outcome)) {
		await killAndWait(child);
		return;
	}

	const [code, signal] = await exited;
	assert.equal(code, isReportedChildError(outcome) ? 1 : 0);
	assert.equal(signal, null);
}

async function finishChildren(children: readonly ChildProcess[], outcomes: readonly unknown[]): Promise<void> {
	const results = await Promise.allSettled(children.map((child, index) => finishChild(child, outcomes[index])));
	const errors: unknown[] = [];
	for (const result of results) {
		if (result.status === "rejected") errors.push(result.reason);
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "failed to finish process-lock children");
}

it("reports unexpected fixture failures separately from lock contention", async () => {
	const child = fork(entry, ["fail", `unexpected-lock-${process.pid}`], { execArgv: [], stdio: "pipe" });
	let outcome: unknown;
	try {
		outcome = await waitForChildMessage(child);
		assert.deepEqual(outcome, { type: "error", message: "synthetic process-lock failure" });
	} finally {
		await finishChild(child, outcome);
	}
});

// pi#244: two stale probes can unlink each other's newly bound socket without an exclusive guard.
it.skipIf(process.platform === "win32")("admits exactly one concurrent owner of a stale socket file", async () => {
	const name = `stale-socket-${process.pid}`;
	const key = createHash("sha256").update(name).digest("hex").slice(0, 32);
	const address = join(tmpdir(), `chord2-${key}.sock`);
	const spawn = (mode: string, value: string) => fork(entry, [mode, value], { execArgv: [], stdio: "pipe" });
	const stale = spawn("stale", address);
	const [staleCode, staleSignal] = await waitForChildExit(stale);
	assert.equal(staleCode, 0);
	assert.equal(staleSignal, null);
	assert.ok(existsSync(address));
	const children = [spawn("race", name), spawn("race", name)];
	const outcomes: unknown[] = [];
	try {
		const first = await Promise.all(children.map((child) => waitForChildMessage(child)));
		const results: unknown[] = [];
		for (const [i, child] of children.entries()) {
			let outcome = first[i];
			if (outcome === "stale") {
				await sendChildMessage(child, "unlink");
				outcome = await waitForChildMessage(child);
			}
			outcomes[i] = outcome;
			results.push(outcome);
		}
		assert.equal(results.filter((result) => result === "held").length, 1);
		assert.equal(results.filter((result) => result === "locked").length, 1);
	} finally {
		await finishChildren(children, outcomes);
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
		assert.equal(await waitForChildMessage(child), "held");
		const [code, signal] = await killAndWait(child);
		assert.equal(code, null);
		assert.equal(signal, "SIGKILL");
		const replacement = spawn("acquire");
		let outcome: unknown;
		try {
			outcome = await waitForChildMessage(replacement);
			assert.equal(outcome, "held");
		} finally {
			await finishChild(replacement, outcome);
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) await killAndWait(child);
	}
});

// pi#244: a recoverer delayed after the stale check must never move the winner's fresh guard.
it.skipIf(process.platform === "win32")("admits one owner when two processes recover one stale lock", async () => {
	const name = `concurrent-stale-lock-${process.pid}`;
	const spawn = () => fork(entry, ["recover-race", name], { execArgv: [], stdio: "pipe" });
	const owner = fork(entry, ["crash", name], { execArgv: [], stdio: "pipe" });
	try {
		assert.equal(await waitForChildMessage(owner), "held");
		const [code, signal] = await killAndWait(owner);
		assert.equal(code, null);
		assert.equal(signal, "SIGKILL");
	} finally {
		if (owner.exitCode === null && owner.signalCode === null) await killAndWait(owner);
	}
	const children = [spawn(), spawn()];
	const outcomes: unknown[] = [];
	try {
		const first = await Promise.all(children.map((child) => waitForChildMessage(child)));
		const results: unknown[] = [];
		for (const [i, child] of children.entries()) {
			let outcome = first[i];
			if (outcome === "stale") {
				await sendChildMessage(child, "recover");
				outcome = await waitForChildMessage(child);
			}
			outcomes[i] = outcome;
			results.push(outcome);
		}
		assert.equal(results.filter((result) => result === "held").length, 1);
		assert.equal(results.filter((result) => result === "locked").length, 1);
	} finally {
		await finishChildren(children, outcomes);
	}
});
