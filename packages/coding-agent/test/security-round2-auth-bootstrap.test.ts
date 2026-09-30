import { fork } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";

const serverUrl = "https://fake-bootstrap.example/mcp";
const fakeGrant = {
	[serverUrl]: {
		serverUrl,
		tokens: { access_token: "fake-access-B", refresh_token: "fake-refresh-B", token_type: "Bearer" },
		grantRevision: "fake-revision-B",
		authorizationAttempt: "fake-attempt-B",
	},
};
const committedBytes = `${JSON.stringify(fakeGrant, null, 2)}\n`;

describe("credential file bootstrap", () => {
	let directory: string;
	let path: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(join(tmpdir(), "pi-auth-bootstrap-"));
		path = join(directory, "mcp-auth.json");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	// #2241: successful wx open publishes an empty inode; only the storage lock protects its first write.
	test.each(["sync", "async"] as const)(
		"successful %s creator orders its first write before B's commit",
		async (kind) => {
			const children: ReturnType<typeof fork>[] = [];
			const exits: Promise<number | null>[] = [];
			const child = (role: "A" | "B") => {
				const home = join(directory, `home-${role}`);
				fs.mkdirSync(home);
				const process = fork(
					new URL("./fixtures/security-round2-auth-bootstrap-process.ts", import.meta.url),
					[directory, role, kind, committedBytes],
					{
						execArgv: ["--conditions=source"],
						env: { HOME: home, TMPDIR: home, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1" },
						stdio: ["ignore", "ignore", "pipe", "ipc"],
						timeout: 15_000,
						killSignal: "SIGKILL",
					},
				);
				children.push(process);
				let stderr = "";
				process.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				exits.push(
					new Promise((resolve, reject) => {
						process.once("error", reject);
						process.once("exit", (code) => {
							if (code === 0) resolve(code);
							else reject(new Error(`Bootstrap ${role} exited ${code}: ${stderr}`));
						});
					}),
				);
				// Retain early child failures until the gate waiter can report them.
				void exits[exits.length - 1].catch(() => undefined);
			};
			const waitFor = async (...names: string[]) => {
				const deadline = Date.now() + 10_000;
				while (!names.some((name) => fs.existsSync(join(directory, name)))) {
					for (const role of ["A", "B"]) {
						const error = join(directory, `${role}-error`);
						if (fs.existsSync(error)) throw new Error(fs.readFileSync(error, "utf8"));
					}
					if (children.some((process) => process.exitCode !== null && process.exitCode !== 0))
						await Promise.all(exits);
					if (Date.now() >= deadline) throw new Error(`Bootstrap gate timed out: ${names.join(", ")}`);
					await sleep(5);
				}
			};
			let contended = false;
			let committedWhilePaused = false;
			let ownedInitialization = false;
			try {
				child("A");
				await waitFor("opened");
				const opened = JSON.parse(fs.readFileSync(join(directory, "opened"), "utf8")) as {
					inode: number;
					locked: boolean;
				};
				ownedInitialization = opened.locked;
				expect(fs.readFileSync(path, "utf8")).toBe("");
				child("B");
				// Native ELOCKED or a completed real commit decides the interleaving, not a timing guess.
				await waitFor("B-contended", "B-done");
				contended = fs.existsSync(join(directory, "B-contended"));
				committedWhilePaused = fs.existsSync(join(directory, "B-done"));
				if (committedWhilePaused) expect(fs.readFileSync(path, "utf8")).toBe(committedBytes);
				fs.writeFileSync(join(directory, "resume-A"), "resume");
				await Promise.all(exits);
				const initialized = JSON.parse(fs.readFileSync(join(directory, "initialized"), "utf8")) as {
					bytes: string;
					inode: number;
				};
				const committed = JSON.parse(fs.readFileSync(join(directory, "B-done"), "utf8")) as { inode: number };
				expect(initialized.inode).toBe(opened.inode);
				expect(committed.inode).toBe(opened.inode);
				if (committedWhilePaused) {
					// Baseline evidence: A overwrites B's pretty JSON prefix through the already-open fd.
					expect(initialized.bytes).toBe(`{}${committedBytes.slice(2)}`);
					expect(() => JSON.parse(initialized.bytes)).toThrow();
					console.error(
						`BEFORE-EFFECT ${kind}: B committed on inode ${opened.inode}; A resumed and corrupted JSON to ${JSON.stringify(initialized.bytes.slice(0, 64))}`,
					);
				}
				expect({ ownedInitialization, contended, committedWhilePaused }).toEqual({
					ownedInitialization: true,
					contended: true,
					committedWhilePaused: false,
				});
				expect(initialized.bytes).toBe("{}");
				expect(JSON.parse(fs.readFileSync(join(directory, "B-acquired"), "utf8"))).toEqual({ initialized: true });
				expect(JSON.parse(fs.readFileSync(join(directory, "B-callback"), "utf8"))).toEqual({
					current: "{}",
					inode: opened.inode,
					locked: true,
				});
				expect(fs.readFileSync(path, "utf8")).toBe(committedBytes);
				expect(JSON.parse(fs.readFileSync(path, "utf8"))[serverUrl]).toEqual(fakeGrant[serverUrl]);
				expect(fs.existsSync(`${path}.lock`)).toBe(false);
			} finally {
				fs.writeFileSync(join(directory, "resume-A"), "resume");
				for (const process of children) {
					if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
				}
				await Promise.allSettled(exits);
			}
		},
	);

	// #2241: B commits before A acquires ownership; a stale absence still takes wx/EEXIST, never truncation.
	test.each(["sync", "async"] as const)("stale first %s opener cannot erase B's grant", async (kind) => {
		const openerA = new FileAuthStorageBackend(path);
		const openerB = new FileAuthStorageBackend(path);
		const exists = fs.existsSync;
		let committed = false;
		let commitFinished = false;
		let staleObservation = false;
		let collision = false;
		const commitB = () => {
			if (committed) return;
			committed = true;
			openerB.withLock(() => ({ result: undefined, next: committedBytes }));
			commitFinished = true;
		};
		const lockSync = lockfile.lockSync;
		const lockAsync = lockfile.lock;
		if (kind === "sync")
			vi.spyOn(lockfile, "lockSync").mockImplementation((file, options) => {
				commitB();
				return lockSync(file, options);
			});
		else
			vi.spyOn(lockfile, "lock").mockImplementation((file, options) => {
				commitB();
				return lockAsync(file, options);
			});
		vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
			if (candidate === path && commitFinished && exists(path) && !staleObservation) {
				staleObservation = true;
				return false;
			}
			return exists(candidate);
		});
		const write = fs.writeFileSync;
		vi.spyOn(fs, "writeFileSync").mockImplementation((candidate, data, options) => {
			try {
				return write(candidate, data, options);
			} catch (error) {
				if (candidate === path && (error as NodeJS.ErrnoException).code === "EEXIST") collision = true;
				throw error;
			}
		});
		syncBuiltinESMExports();
		const read = (current: string | undefined) => {
			expect(exists(`${path}.lock`)).toBe(true);
			expect(current).toBe(committedBytes);
			return { result: current };
		};
		if (kind === "sync") expect(openerA.withLock(read)).toBe(committedBytes);
		else expect(await openerA.withLockAsync(async (current) => read(current))).toBe(committedBytes);
		expect(staleObservation).toBe(true);
		expect(collision).toBe(true);
		expect(fs.readFileSync(path, "utf8")).toBe(committedBytes);
	});

	// #2241: first creation stays private even with the usual permissive process umask.
	test.skipIf(process.platform === "win32").each(["sync", "async"] as const)(
		"creates a private %s file under umask 022",
		async (kind) => {
			const previous = process.umask(0o022);
			try {
				const nestedPath = join(directory, "new-private-parent", "auth.json");
				const backend = new FileAuthStorageBackend(nestedPath);
				const read = (current: string | undefined) => {
					expect(current).toBe("{}");
					expect(fs.existsSync(`${nestedPath}.lock`)).toBe(true);
					return { result: undefined };
				};
				if (kind === "sync") backend.withLock(read);
				else await backend.withLockAsync(async (current) => read(current));
				expect(fs.statSync(nestedPath).mode & 0o777).toBe(0o600);
				expect(fs.statSync(join(directory, "new-private-parent")).mode & 0o777).toBe(0o700);
			} finally {
				process.umask(previous);
			}
		},
	);

	// #2241: bootstrap must not reset administrator-managed modes or modify existing bytes.
	test.skipIf(process.platform === "win32")(
		"preserves existing data and modes through opening and locked updates",
		async () => {
			fs.writeFileSync(path, committedBytes);
			fs.chmodSync(path, 0o640);
			const backend = new FileAuthStorageBackend(path);
			backend.withLock((current) => ({ result: expect(current).toBe(committedBytes) }));
			await backend.withLockAsync(async (current) => ({ result: expect(current).toBe(committedBytes) }));
			expect(fs.readFileSync(path, "utf8")).toBe(committedBytes);
			expect(fs.statSync(path).mode & 0o777).toBe(0o640);
			backend.withLock(() => {
				expect(fs.existsSync(`${path}.lock`)).toBe(true);
				return { result: undefined, next: '{"fake-sync-update":true}' };
			});
			expect(fs.readFileSync(path, "utf8")).toBe('{"fake-sync-update":true}');
			await backend.withLockAsync(async (current) => {
				expect(current).toBe('{"fake-sync-update":true}');
				expect(fs.existsSync(`${path}.lock`)).toBe(true);
				return { result: undefined, next: '{"fake-update":true}' };
			});
			expect(fs.readFileSync(path, "utf8")).toBe('{"fake-update":true}');
			expect(fs.statSync(path).mode & 0o777).toBe(0o640);
		},
	);

	// #2241: only EEXIST is recoverable; real creation failures must not reach storage callbacks.
	test.each(["sync", "async"] as const)("propagates non-EEXIST creation failure for %s operations", async (kind) => {
		const failure = Object.assign(new Error("fake disk full"), { code: "ENOSPC" });
		vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
			expect(fs.existsSync(`${path}.lock`)).toBe(true);
			throw failure;
		});
		syncBuiltinESMExports();
		const callback = vi.fn(() => ({ result: undefined }));
		const backend = new FileAuthStorageBackend(path);
		if (kind === "sync") expect(() => backend.withLock(callback)).toThrow(failure);
		else await expect(backend.withLockAsync(async () => callback())).rejects.toBe(failure);
		expect(callback).not.toHaveBeenCalled();
		expect(fs.existsSync(path)).toBe(false);
		expect(fs.existsSync(`${path}.lock`)).toBe(false);
	});

	// #2241: an acquisition failure must not publish even an empty credential file.
	test.each(["sync", "async"] as const)("does not initialize after %s lock acquisition failure", async (kind) => {
		const failure = new Error("fake lock failure");
		if (kind === "sync")
			vi.spyOn(lockfile, "lockSync").mockImplementation(() => {
				throw failure;
			});
		else vi.spyOn(lockfile, "lock").mockRejectedValue(failure);
		const backend = new FileAuthStorageBackend(path);
		const callback = vi.fn(() => ({ result: undefined }));
		if (kind === "sync") expect(() => backend.withLock(callback)).toThrow(failure);
		else await expect(backend.withLockAsync(async () => callback())).rejects.toBe(failure);
		expect(callback).not.toHaveBeenCalled();
		expect(fs.existsSync(path)).toBe(false);
	});

	// #2241: checks after acquisition precede initialization, and release still runs on rejection.
	test.each(["aborted", "compromised"] as const)("does not initialize a newly %s async lock", async (kind) => {
		const controller = new AbortController();
		const failure = new Error(`fake ${kind}`);
		const release = vi.fn(async () => {});
		vi.spyOn(lockfile, "lock").mockImplementation(async (_file, options) => {
			if (kind === "aborted") controller.abort(failure);
			else options?.onCompromised?.(failure);
			return release;
		});
		const callback = vi.fn(async () => ({ result: undefined }));
		const backend = new FileAuthStorageBackend(path);
		await expect(backend.withLockAsync(callback, { signal: controller.signal })).rejects.toBe(failure);
		expect(callback).not.toHaveBeenCalled();
		expect(fs.existsSync(path)).toBe(false);
		expect(release).toHaveBeenCalledTimes(1);
	});

	// #2241: errors inside ownership release the real lock so a later writer can recover normally.
	test.each(["sync", "async"] as const)("releases after %s callback failure", async (kind) => {
		const backend = new FileAuthStorageBackend(path);
		const failure = new Error("fake callback failure");
		const callback = () => {
			throw failure;
		};
		if (kind === "sync") expect(() => backend.withLock(callback)).toThrow(failure);
		else await expect(backend.withLockAsync(async () => callback())).rejects.toBe(failure);
		expect(fs.readFileSync(path, "utf8")).toBe("{}");
		expect(fs.existsSync(`${path}.lock`)).toBe(false);
		backend.withLock(() => ({ result: undefined, next: committedBytes }));
		expect(fs.readFileSync(path, "utf8")).toBe(committedBytes);
	});
});
