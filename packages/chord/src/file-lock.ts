import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";

type Owner = { pid: number; start: string };
type Snapshot = { owner: Owner; dev: number; ino: number };

function startIdentity(pid: number): string | undefined {
	try {
		// Field 22, after the parenthesized comm field (which itself may contain spaces or ')').
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const start = stat
			.slice(stat.lastIndexOf(")") + 2)
			.trim()
			.split(/\s+/)[19];
		const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		return start === undefined ? undefined : `${boot}:${start}`;
	} catch {
		try {
			return (
				execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim() ||
				undefined
			);
		} catch {
			return undefined;
		}
	}
}

function alive(owner: Owner): boolean {
	const identity = startIdentity(owner.pid);
	if (identity !== undefined) return identity === owner.start;
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function snapshot(path: string): Snapshot | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 4096) return undefined;
		const owner: unknown = JSON.parse(readFileSync(fd, "utf8"));
		if (
			owner === null ||
			typeof owner !== "object" ||
			!("pid" in owner) ||
			!("start" in owner) ||
			typeof owner.pid !== "number" ||
			!Number.isSafeInteger(owner.pid) ||
			owner.pid <= 0 ||
			typeof owner.start !== "string" ||
			owner.start.length === 0
		)
			return undefined;
		return { owner: { pid: owner.pid, start: owner.start }, dev: stat.dev, ino: stat.ino };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function createGuard(path: string, payload: string): number {
	const candidate = `${path}.owner-${process.pid}-${randomUUID()}`;
	const fd = openSync(candidate, "wx", 0o600);
	try {
		writeFileSync(fd, payload);
		// Publish an initialized owner atomically, with exclusive-create semantics. A crash between open and
		// write must not strand an empty guard with no recoverable identity.
		linkSync(candidate, path);
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	} finally {
		unlinkSync(candidate);
	}
}

/**
 * Acquire a filesystem guard. Only an established dead/reused-PID owner can be recovered.
 * Recovery directories are immutable, nonempty generation fences: rename cannot replace one.
 * Keep them after recovery, so a contender paused before publication cannot rename a fresh guard.
 * A crashed recoverer is superseded by publishing its successor inside the fence, never deleting it.
 */
export async function acquireFileLock(path: string): Promise<() => void> {
	const start = startIdentity(process.pid);
	if (start === undefined) throw new Error("cannot establish process start identity");
	const payload = JSON.stringify({ pid: process.pid, start });
	let fd: number;
	try {
		fd = createGuard(path, payload);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const original = snapshot(path);
		if (original === undefined || alive(original.owner)) throw new Error(`lock ${path} is held`);

		const generation = createHash("sha256").update(JSON.stringify(original)).digest("hex").slice(0, 32);
		let fence = `${path}.recovery-${generation}`;
		for (;;) {
			// Publish a fully initialized nonempty directory, not mkdir followed by a racy owner write.
			const candidate = `${path}.candidate-${process.pid}-${randomUUID()}`;
			await mkdir(candidate, { mode: 0o700 });
			await writeFile(`${candidate}/owner`, payload, { mode: 0o600 });
			try {
				await rename(candidate, fence);
				break;
			} catch (publishError) {
				unlinkSync(`${candidate}/owner`);
				rmdirSync(candidate);
				if (!["EEXIST", "ENOTEMPTY"].includes((publishError as NodeJS.ErrnoException).code ?? ""))
					throw publishError;
				const current = snapshot(`${fence}/owner`);
				if (current === undefined || alive(current.owner)) throw new Error(`lock ${path} recovery is held`);
				// The owner record never changes. All successors contend for this same next generation.
				fence = `${fence}/next`;
			}
		}
		const current = snapshot(path);
		if (
			current === undefined ||
			current.dev !== original.dev ||
			current.ino !== original.ino ||
			current.owner.pid !== original.owner.pid ||
			current.owner.start !== original.owner.start ||
			alive(current.owner)
		)
			throw new Error(`lock ${path} changed during recovery`);
		// Only the published fence owner may move this generation. No check-then-unlink by path.
		await rename(path, `${fence}/stale-${randomUUID()}`);
		fd = createGuard(path, payload);
	}
	const owned = fstatSync(fd);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			const current = lstatSync(path);
			if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		} finally {
			closeSync(fd);
		}
	};
}
