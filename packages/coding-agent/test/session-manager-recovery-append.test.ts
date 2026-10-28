import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnedJournal, OwnerHost } from "../src/core/owner-effects.ts";
import type { OwnerHostProfile } from "../src/core/owner-profile.ts";
import { appendOwnedTerminalEntry, SessionManager } from "../src/core/session-manager.ts";
import { SessionOwnership } from "../src/core/session-ownership.ts";
import { nativeRecoveryAppend, withSessionPersistenceScope } from "../src/core/session-recovery-persistence.ts";

// smarty-dev#16188: data safety and real native serializer boundaries. The ordinary
// cases use the actual filesystem. Owned cases use the REAL JS journal adapter with
// a recorded native port; they do not execute/qualify the C addon or power-loss.
// KEEP ALL TRACES: no afterEach fixture removal, truncation, or unlink.
const ports = vi.hoisted(() => {
	const state = {
		bytes: Buffer.alloc(0),
		trustedBytes: Buffer.alloc(0),
		flushAbi: 1 as number | undefined,
		flushAvailable: true,
		stale: false,
		fd: 100000,
		paths: new Map<number, string>(),
		fail: false,
		shortWrite: false,
		release: undefined as (() => void) | undefined,
		started: undefined as (() => void) | undefined,
	};
	const append = (_lease: object, _name: string, length: number, suffix: Buffer) => {
		if (state.fail) throw new Error("native fsync failed");
		if (length !== state.bytes.length || !suffix.length) throw new Error("invalid append");
		state.bytes = Buffer.concat([state.bytes, suffix]);
		state.trustedBytes = Buffer.from(state.bytes);
		return state.bytes.length;
	};
	const verify = (_lease: object, _name: string, length: number) => {
		if (state.stale) throw new Error("STALE_OWNER");
		if (length !== state.bytes.length || !state.bytes.equals(state.trustedBytes)) throw new Error("stale prefix");
		return length;
	};
	const flush = vi.fn((_lease: object, _name: string, length: number) => {
		if (state.fail) throw new Error("native fsync failed");
		return verify(_lease, _name, length);
	});
	const native = {
		abi: 3,
		get journalFlushAbi() {
			return state.flushAbi;
		},
		get flushJournal() {
			return state.flushAvailable ? flush : undefined;
		},
		validateHost: () => ({}),
		closeHost() {},
		acquire: () => ({}),
		recoveryStatus: () => ({ needed: false }),
		recoverOwner: () => true,
		issueAdmission: () => ({}),
		activateOwner() {},
		claimAllocation() {},
		spendAutomaticTurn() {},
		stopAutomaticTurns() {},
		receiveCredential: () => Buffer.alloc(0),
		checkCredential() {},
		check() {
			if (state.stale) throw new Error("STALE_OWNER");
		},
		beginClose() {},
		cancelLifecycle() {},
		seal: () => ({
			ready: Promise.resolve(),
			remaining: () => 30000,
			complete: () => ({ next: null, value: undefined }),
		}),
		quarantine: vi.fn(() => undefined),
		readJournal: () => {
			state.trustedBytes = Buffer.from(state.bytes);
			return Buffer.from(state.bytes);
		},
		commitJournal: vi.fn((_lease: object, _name: string, previous: Buffer, next: Buffer) => {
			if (!previous.equals(state.bytes)) throw new Error("prefix");
			return append(_lease, _name, previous.length, next.subarray(previous.length));
		}),
		appendJournal: vi.fn(append),
		appendTerminalJournal: vi.fn(append),
		verifyJournal: vi.fn(verify),
		appendTerminalJournalAsync: vi.fn((_lease: object, _name: string, length: number, suffix: Buffer) => ({
			ready: new Promise<void>((resolve) => {
				state.release = resolve;
				state.started?.();
			}),
			remaining: () => 30000,
			complete: () => ({ next: null, value: append(_lease, _name, length, suffix) }),
		})),
		commitTerminalJournal: vi.fn(),
		commitTerminalJournalAsync: vi.fn(),
		prepareLaunch: () => ({}),
		dispatchLaunch: () => 1,
		requestStopLaunch() {},
		stopLaunch: vi.fn(),
		pollLaunch: vi.fn(),
		writeLaunchStdin: () => 0,
		retireLaunch: vi.fn(),
		beginOperation: () => ({}),
		checkOperation() {},
		connectProvider() {},
		takeProviderSocket: () => null,
		retireProvider() {},
		readFile: () => Buffer.alloc(0),
		writeFile() {},
		listDirectories: () => [],
		readTree: () => [],
		createSnapshot: () => "fixed",
		removeSnapshot() {},
		associateLaunch() {},
		completeOperation: vi.fn(),
		releaseOwner: vi.fn(),
	};
	return { state, native, flush };
});
const artifact = Buffer.from("recorded-native-port-not-an-addon");
const digest = createHash("sha256").update(artifact).digest("hex");
const profile: OwnerHostProfile = {
	version: 1,
	id: "recovery-test",
	runtime: { kind: "node", architecture: "x64", version: process.versions.node, libc: "glibc" },
	host: { uid: 1000, gid: 1000, unit: "fixture.service", cgroup: "/fixture.slice/test.service" },
	artifacts: {
		addon: { path: "/fixture/addon", sha256: digest },
		bubblewrap: { path: "/fixture/sandbox", sha256: digest },
		runtime: { path: "/fixture/runtime", sha256: digest },
		closure: [],
	},
	storage: { root: "/fixture/state", journalBytes: 1048576 },
	limits: {
		owners: 2,
		launchesPerOwner: 1,
		operationsPerOwner: 4,
		recordBytes: 4096,
		argvBytes: 1024,
		outputBytes: 1024,
		closeTimeoutMs: 30000,
		processTimeoutMs: 1000,
		memoryBytes: 67108864,
		pids: 4,
		cpuQuotaMicros: 1000,
		cpuPeriodMicros: 1000,
		fileDescriptors: 32,
		diskBytes: 1048576,
		inodes: 16,
	},
	sandbox: { kind: "file-observer-v1", toolRoot: "/fixture/tools", fileRoots: [] },
};
vi.mock("node:module", () => ({ createRequire: () => Object.assign(() => ports.native, { cache: {} }) }));
vi.mock("../src/core/owner-profile.ts", () => ({
	OWNER_NATIVE_ABI: 3,
	parseOwnerHostProfile: () => profile,
	ownerProfileDigest: () => digest,
}));
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof fs>();
	return {
		...actual,
		fsyncSync: vi.fn(actual.fsyncSync),
		writeSync: vi.fn((fd: number, data: Uint8Array, offset: number, length: number, position: number) =>
			actual.writeSync(fd, data, offset, ports.state.shortWrite ? Math.min(length, 7) : length, position),
		),
		appendFileSync: vi.fn(actual.appendFileSync),
		openSync: vi.fn((...args: Parameters<typeof fs.openSync>) => {
			if (
				String(args[0]).startsWith("/fixture/") ||
				args[0] === "/sys/fs/cgroup/fixture.slice/test.service" ||
				args[0] === "/proc/self/exe"
			) {
				const fd = ++ports.state.fd;
				ports.state.paths.set(fd, String(args[0]));
				return fd;
			}
			return actual.openSync(...args);
		}),
		closeSync: (fd: number) => {
			if (ports.state.paths.has(fd)) ports.state.paths.delete(fd);
			else actual.closeSync(fd);
		},
		lstatSync: (...args: Parameters<typeof fs.lstatSync>) =>
			String(args[0]).startsWith("/fixture")
				? { isDirectory: () => true, uid: 0, mode: 0o555 }
				: actual.lstatSync(...args),
		fstatSync: (fd: number) =>
			ports.state.paths.has(fd)
				? {
						isFile: () => true,
						uid: 0,
						nlink: 1,
						mode: 0o444,
						size: artifact.length,
						mtimeMs: 1,
						ctimeMs: 1,
						dev: 1,
						ino: ["/proc/self/exe", "/fixture/runtime"].includes(ports.state.paths.get(fd)!) ? 1 : 2,
					}
				: actual.fstatSync(fd),
		readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
			typeof args[0] === "number" && ports.state.paths.has(args[0]) ? artifact : actual.readFileSync(...args),
	};
});

const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
let directory: string;
beforeEach(() => {
	vi.clearAllMocks();
	ports.state.bytes = Buffer.alloc(0);
	ports.state.trustedBytes = Buffer.alloc(0);
	ports.state.flushAbi = 1;
	ports.state.flushAvailable = true;
	ports.state.stale = false;
	ports.state.fail = false;
	ports.state.shortWrite = false;
	ports.state.release = undefined;
	ports.state.started = undefined;
	profile.runtime.architecture = process.arch === "arm64" ? "arm64" : "x64";
	profile.runtime.kind = process.versions.bun ? "bun" : "node";
	profile.runtime.version = process.versions.bun ?? process.versions.node;
	directory = fs.mkdtempSync(join(tmpdir(), "pi-recovery-retained-"));
});
afterEach(() => {
	if (ports.state.bytes.length)
		fs.writeFileSync(join(directory, "recorded-native-final.jsonl"), ports.state.bytes, { flag: "wx" });
});

function owned() {
	const host = OwnerHost.loadNative("/fixture/profile");
	const header = {
		type: "session" as const,
		version: 3,
		id: "owned",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/fixture/tools",
	};
	const journal = OwnedJournal.acquire(host, "owned", "now_owned.jsonl", false, header);
	const manager = SessionManager.openOwned(header.cwd, journal);
	manager.enableRecoveryPersistence();
	return { journal, manager };
}

async function reopenOwned() {
	const journal = OwnedJournal.acquire(OwnerHost.loadNative("/fixture/profile"), "owned", "now_owned.jsonl", true);
	await journal.recover();
	const manager = SessionManager.openOwned("/fixture/tools", journal);
	manager.enableRecoveryPersistence();
	return { journal, manager };
}

describe("ordinary recovery persistence", () => {
	it("is opt-in; unchanged ordinary persistence performs no fsync or capture", () => {
		const manager = SessionManager.create(directory, directory);
		manager.appendMessage(user("ordinary"));
		expect(fs.fsyncSync).not.toHaveBeenCalled();
		expect(() => manager.drainRecoveryAppends()).toThrow("NOT_ENABLED");
	});

	it("captures actual serialized UTF-8 JSON+LF, hashes, locations and successful file/directory flush", () => {
		const manager = SessionManager.create(directory, directory);
		manager.appendThinkingLevelChange("high");
		manager.enableRecoveryPersistence();
		const setup = manager.drainRecoveryAppends();
		expect(setup).toHaveLength(1);
		const id = manager.appendMessage(user("exact é\nline"));
		const [entry] = manager.drainRecoveryAppends();
		const bytes = fs.readFileSync(manager.getSessionFile()!);
		expect(Buffer.from(entry.bytes)).toEqual(bytes.subarray(entry.location.offset));
		expect(JSON.parse(Buffer.from(entry.bytes).toString())).toEqual(manager.getEntry(id));
		expect(entry).toMatchObject({
			sessionId: manager.getSessionId(),
			entryId: id,
			location: { length: entry.bytes.length - 1 },
			flushReceipt: {
				kind: "file-fsync",
				file: manager.getSessionFile(),
				bytesThrough: bytes.length,
				namespaceDurable: true,
			},
		});
		expect(entry.bytesSha256).toBe(createHash("sha256").update(entry.bytes).digest("hex"));
		expect(fs.fsyncSync).toHaveBeenCalled();
		expect(fs.appendFileSync).not.toHaveBeenCalled();
		entry.bytes.fill(0);
		expect(fs.readFileSync(manager.getSessionFile()!)).toEqual(bytes);
		expect(manager.drainRecoveryAppends()).toEqual([]);
	});

	it("refuses a missing required file without recreating it; preserves the renamed trace", () => {
		const manager = SessionManager.create(directory, directory);
		manager.enableRecoveryPersistence();
		const file = manager.getSessionFile()!;
		fs.renameSync(file, `${file}.retained`);
		expect(() => manager.appendMessage(user("must fail"))).toThrow();
		expect(fs.existsSync(file)).toBe(false);
		expect(manager.drainRecoveryAppends()).toEqual([]);
	});

	it("does not acknowledge a failed file fsync or allow later append to hide it", () => {
		const manager = SessionManager.create(directory, directory);
		manager.enableRecoveryPersistence();
		vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
			throw new Error("fsync failed");
		});
		expect(() => manager.appendMessage(user("not acknowledged"))).toThrow("fsync failed");
		expect(manager.drainRecoveryAppends()).toEqual([]);
		expect(() => manager.appendMessage(user("later"))).toThrow("PERSISTENCE_FAILED");
		expect(fs.readFileSync(manager.getSessionFile()!, "utf8")).toContain("not acknowledged");
	});

	it("handles short writes fully before flush and refuses failed namespace fsync", () => {
		const manager = SessionManager.create(directory, directory);
		manager.enableRecoveryPersistence();
		ports.state.shortWrite = true;
		manager.appendMessage(user("short write loops"));
		ports.state.shortWrite = false;
		expect(manager.drainRecoveryAppends()).toHaveLength(1);
		vi.mocked(fs.fsyncSync)
			.mockImplementationOnce(() => {})
			.mockImplementationOnce(() => {
				throw new Error("directory fsync failed");
			});
		expect(() => manager.appendMessage(user("namespace failure"))).toThrow("directory fsync failed");
		expect(manager.drainRecoveryAppends()).toEqual([]);
	});

	it("inspects all branches and re-emits retained exact entries after a real native flush", () => {
		const original = SessionManager.create(directory, directory);
		const root = original.appendMessage(user("root"));
		const abandoned = original.appendMessage(user("abandoned"));
		original.branch(root);
		const selected = original.appendMessage(user("selected"));
		const manager = SessionManager.openForRecovery(original.getSessionFile()!);
		expect(manager.drainRecoveryAppends()).toEqual([]);
		expect(() => manager.appendMessage(user("before scan"))).toThrow("SCAN_REQUIRED");
		const scan = manager.recoverRecoveryAppends();
		expect(scan.issues).toEqual([]);
		expect(scan.entries.map((entry) => entry.entryId)).toEqual([root, abandoned, selected]);
		expect(manager.drainRecoveryAppends().map((entry) => entry.entryId)).toEqual([root, abandoned, selected]);
	});

	it.each(["complete", "torn"])("preserves a %s final-noLF candidate without claiming absence", (kind) => {
		const original = SessionManager.create(directory, directory);
		const id = original.appendMessage(user("retained"));
		const prefix = fs.readFileSync(original.getSessionFile()!);
		const file = join(directory, `${kind}.jsonl`);
		const raw =
			kind === "complete"
				? prefix.subarray(0, -1)
				: Buffer.concat([prefix, Buffer.from('{"type":"message","id":"torn"')]);
		fs.writeFileSync(file, raw, { flag: "wx" });
		const manager = SessionManager.openForRecovery(file);
		expect(fs.readFileSync(file)).toEqual(raw);
		const scan = manager.inspectRecoveryEntries();
		expect(scan.entries.map((entry) => entry.entryId)).toEqual([id]);
		expect(scan.issues.map((issue) => issue.reason)).toContain("missing-final-lf");
		manager.recoverRecoveryAppends();
		if (kind === "complete") {
			expect(fs.readFileSync(file)).toEqual(Buffer.concat([raw, Buffer.from("\n")]));
			expect(manager.drainRecoveryAppends()).toHaveLength(1);
		} else {
			expect(fs.readFileSync(file)).toEqual(raw);
			expect(scan.issues.map((issue) => issue.reason)).toContain("invalid-entry");
			expect(manager.drainRecoveryAppends()).toEqual([]);
			expect(() => manager.appendMessage(user("blocked"))).toThrow("SCAN_REQUIRED");
		}
	});

	it.each(["unknown-type", "duplicate-id", "invalid-utf8"])(
		"retains %s ranges and refuses complete recovery acknowledgement",
		(kind) => {
			const original = SessionManager.create(directory, directory);
			const id = original.appendMessage(user("root"));
			const prefix = fs.readFileSync(original.getSessionFile()!);
			const entry = { ...original.getEntry(id), type: kind === "unknown-type" ? "future-native-type" : "message" };
			const tail = kind === "invalid-utf8" ? Buffer.from([0xff, 10]) : Buffer.from(`${JSON.stringify(entry)}\n`);
			const file = join(directory, `${kind}.jsonl`);
			const bytes = Buffer.concat([prefix, tail]);
			fs.writeFileSync(file, bytes, { flag: "wx" });
			const manager = SessionManager.openForRecovery(file);
			expect(manager.recoverRecoveryAppends().issues.length).toBeGreaterThan(0);
			expect(manager.drainRecoveryAppends()).toEqual([]);
			expect(fs.readFileSync(file)).toEqual(bytes);
		},
	);

	it("offers no promise/callback and rejects synchronous or microtask drain inside native persistence", async () => {
		const manager = SessionManager.create(directory, directory);
		manager.enableRecoveryPersistence();
		await withSessionPersistenceScope(manager, async () => {
			manager.appendMessage(user("persisted inside enclosing scope"));
			expect(() => manager.drainRecoveryAppends()).toThrow("NOT_RELEASED");
			await Promise.resolve();
			expect(() => manager.drainRecoveryAppends()).toThrow("NOT_RELEASED");
		});
		expect(manager.drainRecoveryAppends()).toHaveLength(1);
		expect(() => SessionManager.inMemory(directory).enableRecoveryPersistence()).toThrow("BACKING_FILE_REQUIRED");
	});
});

describe("owned committed append capture (recorded native port, NOT addon execution)", () => {
	it("uses one nonempty committed append and its actual prefix count/hash, with no extra native fsync/writer", () => {
		const { journal, manager } = owned();
		const id = manager.appendMessage(user("owned exact"));
		const [entry] = manager.drainRecoveryAppends();
		expect(entry.entryId).toBe(id);
		expect(Buffer.from(entry.bytes)).toEqual(ports.state.bytes.subarray(entry.location.offset));
		expect(entry.flushReceipt).toEqual({
			kind: "owned-journal-commit",
			file: journal.file,
			bytes: ports.state.bytes.length,
			sha256: createHash("sha256").update(ports.state.bytes).digest("hex"),
		});
		expect(ports.native.commitJournal).toHaveBeenCalledTimes(1);
		expect(ports.native.appendJournal).toHaveBeenCalledTimes(1);
		// Bootstrap's old commit API verifies custody once; capture must not verify/empty-append again.
		expect(ports.native.verifyJournal).toHaveBeenCalledTimes(1);
		expect(fs.fsyncSync).not.toHaveBeenCalled();
		expect(fs.writeSync).not.toHaveBeenCalled();
		expect(ports.flush).not.toHaveBeenCalled();
		// Recovery of a same-incarnation commit rechecks custody, not another fsync.
		expect(manager.recoverRecoveryAppends().issues).toEqual([]);
		expect(manager.drainRecoveryAppends()).toEqual([entry]);
		expect(ports.flush).not.toHaveBeenCalled();
	});

	it("retains owned terminal serialization and rejects early drain until enclosing scope releases", async () => {
		const { journal, manager } = owned();
		manager.appendMessage(user("start"));
		manager.drainRecoveryAppends();
		await journal.seal();
		const started = new Promise<void>((resolve) => {
			ports.state.started = resolve;
		});
		const pending = withSessionPersistenceScope(manager, () =>
			journal.terminal(async () => {
				const append = appendOwnedTerminalEntry(manager, "terminal", { value: "detached" });
				expect(() => manager.drainRecoveryAppends()).toThrow("NOT_RELEASED");
				await started;
				expect(() => manager.drainRecoveryAppends()).toThrow("NOT_RELEASED");
				ports.state.release!();
				const id = await append;
				expect(() => manager.drainRecoveryAppends()).toThrow("NOT_RELEASED");
				return id;
			}),
		);
		const id = await pending;
		const [entry] = manager.drainRecoveryAppends();
		expect(entry.entryId).toBe(id);
		expect(entry.flushReceipt).toMatchObject({ bytes: ports.state.bytes.length });
		expect(ports.native.appendTerminalJournalAsync).toHaveBeenCalledTimes(1);
		expect(ports.native.commitTerminalJournalAsync).not.toHaveBeenCalled();
		expect(fs.fsyncSync).not.toHaveBeenCalled();
	});

	it("wraps the actual SessionOwnership terminal callback until its enclosing promise releases", async () => {
		const owner = SessionOwnership.create(OwnerHost.loadNative("/fixture/profile"), "/fixture/tools");
		owner.activate(owner.admit({ roots: [], commands: [], effects: [], provider: null }));
		const manager = owner.manager;
		manager.enableRecoveryPersistence();
		expect(manager.recoverRecoveryAppends().issues).toEqual([]);
		manager.drainRecoveryAppends();
		await owner.terminal(async () => {
			manager.appendMessage(user("actual owner terminal"));
			expect(() => manager.drainRecoveryAppends()).toThrow("NOT_RELEASED");
			await Promise.resolve();
			expect(() => manager.drainRecoveryAppends()).toThrow("NOT_RELEASED");
		});
		expect(manager.drainRecoveryAppends()).toHaveLength(1);
		expect(ports.native.appendJournal).toHaveBeenCalledTimes(1);
	});

	it("rejects receipt requests on empty appends before entering the native writer", async () => {
		const { journal } = owned();
		expect(() => journal.append(Buffer.alloc(0), true)).toThrow("NONEMPTY_COMMIT_REQUIRED");
		await expect(journal.appendTerminalAsync(Buffer.alloc(0), true)).rejects.toThrow("NONEMPTY_COMMIT_REQUIRED");
		expect(ports.native.appendJournal).not.toHaveBeenCalled();
		expect(ports.native.appendTerminalJournalAsync).not.toHaveBeenCalled();
		expect(journal.committedAppendReceipt()).toBeUndefined();
	});

	// smarty-dev#16188 / NATIVE-APPEND-001: commit -> process loss -> no B6 registration.
	it("re-emits a committed unindexed carrier on restart BEFORE any new user append", async () => {
		const { journal, manager } = owned();
		const id = manager.appendMessage(user("retained"));
		const [original] = manager.drainRecoveryAppends();
		const retained = Buffer.from(ports.state.bytes);
		fs.writeFileSync(join(directory, "committed-before-registration.jsonl"), retained, { flag: "wx" });
		// The recorded successor port stands for a new owner; this is not process/C qualification.
		const other = OwnedJournal.acquire(OwnerHost.loadNative("/fixture/profile"), "owned", "now_owned.jsonl", true);
		await other.recover();
		const reopened = SessionManager.openOwned("/fixture/tools", other);
		reopened.enableRecoveryPersistence();
		expect(other.currentReceipt()).toEqual(journal.currentReceipt());
		expect(other.committedAppendReceipt()).toBeUndefined();
		expect(reopened.inspectRecoveryEntries().entries.map((entry) => entry.entryId)).toEqual([id]);
		expect(ports.flush).not.toHaveBeenCalled();
		expect(reopened.drainRecoveryAppends()).toEqual([]);
		expect(() => reopened.appendMessage(user("unauthorized replacement"))).toThrow("SCAN_REQUIRED");
		expect(reopened.recoverRecoveryAppends().issues).toEqual([]);
		expect(reopened.drainRecoveryAppends()).toEqual([original]);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual([id]);
		expect(ports.state.bytes).toEqual(retained);
		expect(ports.native.appendJournal).toHaveBeenCalledTimes(1);
		expect(ports.native.commitJournal).toHaveBeenCalledTimes(1);
		expect(ports.flush).toHaveBeenCalledExactlyOnceWith(expect.any(Object), "now_owned.jsonl", retained.length);
		expect(fs.fsyncSync).not.toHaveBeenCalled();
	});

	// smarty-dev#16188 / NATIVE-APPEND-001 allowed case: B6 already indexed the carrier.
	it("re-emits identical indexed descriptors on repeated recovery without duplicate native work", async () => {
		const { manager } = owned();
		manager.appendMessage(user("already indexed"));
		const [indexed] = manager.drainRecoveryAppends();
		const retained = Buffer.from(ports.state.bytes);
		// Recorded receiver only; this test does NOT execute B6's register/barrier/store.
		const registrations = new Map([[indexed.entryId, { seq: 7, descriptor: indexed }]]);
		const { manager: reopened } = await reopenOwned();
		for (let repeat = 0; repeat < 3; repeat++) {
			expect(reopened.recoverRecoveryAppends().issues).toEqual([]);
			const recovered = reopened.drainRecoveryAppends();
			expect(recovered).toEqual([indexed]);
			for (const descriptor of recovered) {
				const existing = registrations.get(descriptor.entryId)!;
				expect(existing).toEqual({ seq: 7, descriptor });
			}
			expect(reopened.drainRecoveryAppends()).toEqual([]);
		}
		expect(registrations.size).toBe(1);
		expect(ports.state.bytes).toEqual(retained);
		expect(ports.flush).toHaveBeenCalledTimes(1);
		const { manager: nextBoot } = await reopenOwned();
		expect(nextBoot.recoverRecoveryAppends().issues).toEqual([]);
		expect(nextBoot.drainRecoveryAppends()).toEqual([indexed]);
		expect(ports.flush).toHaveBeenCalledTimes(2);
		expect(ports.native.appendJournal).toHaveBeenCalledTimes(1);
		expect(ports.native.commitJournal).toHaveBeenCalledTimes(1);
		// A later authorized real append strengthens proof, but was NOT needed for recovery.
		nextBoot.appendMessage(user("later genuine append"));
		const [later] = nextBoot.drainRecoveryAppends();
		expect(nextBoot.recoverRecoveryAppends().issues).toEqual([]);
		const both = nextBoot.drainRecoveryAppends();
		expect(both.map((entry) => entry.entryId)).toEqual([indexed.entryId, later.entryId]);
		expect(both[0]).toMatchObject({
			location: indexed.location,
			bytes: indexed.bytes,
			bytesSha256: indexed.bytesSha256,
			flushReceipt: later.flushReceipt,
		});
		expect(ports.flush).toHaveBeenCalledTimes(2);
		expect(fs.fsyncSync).not.toHaveBeenCalled();
		expect(fs.writeSync).not.toHaveBeenCalled();
	});

	it("preserves normal nonempty owned append behavior with an older addon", () => {
		ports.state.flushAbi = undefined;
		ports.state.flushAvailable = false;
		const { manager } = owned();
		manager.appendMessage(user("normal old-addon append"));
		expect(manager.drainRecoveryAppends()).toHaveLength(1);
		expect(ports.flush).not.toHaveBeenCalled();
		expect(fs.fsyncSync).not.toHaveBeenCalled();
	});

	it.each(["old-abi", "wrong-abi", "missing-operation"])(
		"keeps %s custody-only and blocks replacement appends until native flush is available",
		async (kind) => {
			const { manager } = owned();
			manager.appendMessage(user("retained"));
			const [original] = manager.drainRecoveryAppends();
			ports.state.flushAbi = kind === "old-abi" ? undefined : kind === "wrong-abi" ? 2 : 1;
			ports.state.flushAvailable = kind !== "missing-operation";
			const { journal, manager: reopened } = await reopenOwned();
			expect(journal.currentReceipt()).toEqual(
				original.flushReceipt.kind === "owned-journal-commit"
					? { bytes: original.flushReceipt.bytes, sha256: original.flushReceipt.sha256 }
					: undefined,
			);
			expect(reopened.recoverRecoveryAppends().issues.map((issue) => issue.reason)).toEqual(["commit-unproven"]);
			expect(journal.committedAppendReceipt()).toBeUndefined();
			expect(reopened.drainRecoveryAppends()).toEqual([]);
			expect(() => reopened.appendMessage(user("not recovery"))).toThrow("SCAN_REQUIRED");
			expect(ports.flush).not.toHaveBeenCalled();
			ports.state.flushAbi = 1;
			ports.state.flushAvailable = true;
			expect(reopened.recoverRecoveryAppends().issues).toEqual([]);
			expect(reopened.drainRecoveryAppends()).toEqual([original]);
			expect(ports.native.appendJournal).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["throw", "wrong-count", "changed-count", "stale-prefix", "stale-owner"])(
		"emits no recovery descriptor on native %s and preserves all bytes",
		async (kind) => {
			const { manager } = owned();
			manager.appendMessage(user("retained"));
			manager.drainRecoveryAppends();
			fs.writeFileSync(join(directory, "before-recovery.jsonl"), ports.state.bytes, { flag: "wx" });
			const { journal, manager: reopened } = await reopenOwned();
			if (kind === "throw") ports.state.fail = true;
			if (kind === "wrong-count") ports.flush.mockReturnValueOnce(ports.state.bytes.length - 1);
			if (kind === "changed-count") ports.state.bytes = Buffer.concat([ports.state.bytes, Buffer.from("\n")]);
			if (kind === "stale-prefix") {
				ports.state.bytes = Buffer.from(ports.state.bytes);
				ports.state.bytes[0] = 0x20;
			}
			if (kind === "stale-owner") ports.state.stale = true;
			const retained = Buffer.from(ports.state.bytes);
			expect(() => reopened.recoverRecoveryAppends()).toThrow();
			expect(reopened.drainRecoveryAppends()).toEqual([]);
			expect(() => reopened.appendMessage(user("must not hide failure"))).toThrow("PERSISTENCE_FAILED");
			expect(ports.state.bytes).toEqual(retained);
			expect(ports.native.appendJournal).toHaveBeenCalledTimes(1);
			expect(fs.fsyncSync).not.toHaveBeenCalled();
			expect(() => journal.committedAppendReceipt()).toThrow();
		},
	);

	it("does not reuse cached flush proof after retained file bytes change", async () => {
		const { manager } = owned();
		manager.appendMessage(user("retained"));
		manager.drainRecoveryAppends();
		const { manager: reopened } = await reopenOwned();
		expect(reopened.recoverRecoveryAppends().issues).toEqual([]);
		reopened.drainRecoveryAppends();
		fs.writeFileSync(join(directory, "proven-prefix.jsonl"), ports.state.bytes, { flag: "wx" });
		ports.state.bytes = Buffer.from(ports.state.bytes);
		ports.state.bytes[0] = 0x20;
		expect(() => reopened.recoverRecoveryAppends()).toThrow("stale prefix");
		expect(reopened.drainRecoveryAppends()).toEqual([]);
		expect(ports.flush).toHaveBeenCalledTimes(1);
	});

	it.each(["torn", "unknown-type", "wrong-header", "duplicate-id"])(
		"retains %s owned input as uncertainty without flushing or rewriting",
		async (kind) => {
			const { manager } = owned();
			const id = manager.appendMessage(user("retained"));
			manager.drainRecoveryAppends();
			const prefix = Buffer.from(ports.state.bytes);
			fs.writeFileSync(join(directory, "valid-prefix.jsonl"), prefix, { flag: "wx" });
			if (kind === "torn") ports.state.bytes = prefix.subarray(0, -1);
			if (kind === "wrong-header")
				ports.state.bytes = Buffer.from(prefix.toString().replace('"id":"owned"', '"id":"other"'));
			if (kind === "unknown-type" || kind === "duplicate-id") {
				const entry = {
					...manager.getEntry(id),
					...(kind === "unknown-type" ? { type: "future-type", id: "future" } : {}),
				};
				ports.state.bytes = Buffer.concat([prefix, Buffer.from(`${JSON.stringify(entry)}\n`)]);
			}
			const retained = Buffer.from(ports.state.bytes);
			await expect(reopenOwned()).rejects.toThrow();
			expect(ports.state.bytes).toEqual(retained);
			expect(ports.flush).not.toHaveBeenCalled();
			expect(ports.native.appendJournal).toHaveBeenCalledTimes(1);
			expect(ports.native.quarantine).toHaveBeenCalled();
		},
	);

	it.each(["file", "count", "hash", "offset"])("refuses %s descriptor receipt coverage", (kind) => {
		const { manager } = owned();
		manager.appendMessage(user("retained"));
		const [entry] = manager.drainRecoveryAppends();
		if (entry.flushReceipt.kind !== "owned-journal-commit") throw new Error("owned receipt required");
		const receipt = {
			...entry.flushReceipt,
			...(kind === "file" ? { file: "wrong-file" } : {}),
			...(kind === "count" ? { bytes: entry.location.offset + entry.bytes.length - 1 } : {}),
			...(kind === "hash" ? { sha256: "not-a-hash" } : {}),
		};
		const location = { ...entry.location, ...(kind === "offset" ? { offset: -1 } : {}) };
		expect(() => nativeRecoveryAppend(entry.sessionId, entry.entryId, location, entry.bytes, receipt)).toThrow(
			"COVERAGE",
		);
	});

	it("does not acknowledge a native commit failure", () => {
		const { manager } = owned();
		manager.appendMessage(user("good"));
		manager.drainRecoveryAppends();
		ports.state.fail = true;
		expect(() => manager.appendMessage(user("not durable"))).toThrow("native fsync failed");
		expect(manager.drainRecoveryAppends()).toEqual([]);
		expect(ports.native.quarantine).toHaveBeenCalled();
	});

	it.skip("requires parent qualification with deployed native addon and physical power-off", () => {});
});
