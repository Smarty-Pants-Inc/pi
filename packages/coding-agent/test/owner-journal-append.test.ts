import { createHash } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import { OwnedJournal, OwnerHost } from "../src/core/owner-effects.ts";
import type { OwnerHostProfile } from "../src/core/owner-profile.ts";
import type { SessionHeader } from "../src/core/session-manager.ts";

// MOCK: JS custody/hash/scope behavior only. Actual disk checks belong to the
// C storage regression; no provider, native grant, or host qualification here.
const ports = vi.hoisted(() => {
	const state = { bytes: Buffer.alloc(0), tampered: false, paths: new Map<number, string>(), fd: 10 };
	const native = {
		abi: 3,
		validateHost: () => ({}),
		closeHost() {},
		acquire: () => ({}),
		recoveryStatus: () => ({}),
		recoverOwner: () => true,
		issueAdmission: () => ({}),
		activateOwner() {},
		claimAllocation() {},
		spendAutomaticTurn() {},
		stopAutomaticTurns() {},
		receiveCredential: () => Buffer.alloc(0),
		checkCredential() {},
		check() {},
		beginClose() {},
		cancelLifecycle: vi.fn(),
		seal: () => ({
			ready: Promise.resolve(),
			remaining: () => 30000,
			complete: () => ({ next: null, value: undefined }),
		}),
		quarantine: vi.fn(() => undefined),
		readJournal: () => state.bytes,
		commitJournal: vi.fn((_lease: object, _name: string, previous: Buffer, next: Buffer) => {
			if (!previous.equals(state.bytes)) throw new Error("PREFIX");
			state.bytes = Buffer.from(next);
			return next.length;
		}),
		appendJournal: vi.fn((_lease: object, _name: string, length: number, suffix: Buffer) => {
			if (length !== state.bytes.length) throw new Error("LENGTH");
			state.bytes = Buffer.concat([state.bytes, suffix]);
			return state.bytes.length;
		}),
		appendTerminalJournal: vi.fn((_lease: object, _name: string, length: number, suffix: Buffer) => {
			if (length !== state.bytes.length) throw new Error("LENGTH");
			state.bytes = Buffer.concat([state.bytes, suffix]);
			return state.bytes.length;
		}),
		verifyJournal: vi.fn((_lease: object, _name: string, length: number) => {
			if (state.tampered || length !== state.bytes.length) throw new Error("OWNER_JOURNAL_UNCERTAIN");
			return length;
		}),
		commitTerminalJournal: vi.fn(),
		commitTerminalJournalAsync: vi.fn(),
		appendTerminalJournalAsync: vi.fn(),
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
	return { state, native };
});
const artifact = Buffer.from("inert-addon-fixture");
const sha256 = createHash("sha256").update(artifact).digest("hex");
const profile: OwnerHostProfile = {
	version: 1,
	id: "mock-journal-host",
	runtime: { kind: "node", architecture: "x64", version: process.versions.node, libc: "glibc" },
	host: { uid: 1000, gid: 1000, unit: "mock.service", cgroup: "/fixture.slice/mock.service" },
	artifacts: {
		addon: { path: "/fixture/addon", sha256 },
		bubblewrap: { path: "/fixture/sandbox", sha256 },
		runtime: { path: "/fixture/runtime", sha256 },
		closure: [],
	},
	storage: { root: "/fixture/state", journalBytes: 4096 },
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
	ownerProfileDigest: () => sha256,
}));
vi.mock("node:fs", () => ({
	constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_DIRECTORY: 2 },
	lstatSync: () => ({ isDirectory: () => true, uid: 0, mode: 0o555 }),
	openSync: (path: string) => {
		const fd = ++ports.state.fd;
		ports.state.paths.set(fd, path);
		return fd;
	},
	closeSync: (fd: number) => {
		ports.state.paths.delete(fd);
	},
	readFileSync: () => artifact,
	fstatSync: (fd: number) => ({
		isFile: () => true,
		uid: 0,
		nlink: 1,
		mode: 0o444,
		size: artifact.length,
		mtimeMs: 1,
		ctimeMs: 1,
		dev: 1,
		ino: ["/proc/self/exe", "/fixture/runtime"].includes(ports.state.paths.get(fd) ?? "") ? 1 : 2,
	}),
}));

beforeEach(() => {
	vi.clearAllMocks();
	ports.state.bytes = Buffer.alloc(0);
	ports.state.tampered = false;
	profile.runtime.architecture = process.arch === "arm64" ? "arm64" : "x64";
	profile.runtime.kind = process.versions.bun ? "bun" : "node";
	profile.runtime.version = process.versions.bun ?? process.versions.node;
});
function journal() {
	return OwnedJournal.acquire(OwnerHost.loadNative("/fixture/profile"), "synthetic", "now_synthetic.jsonl", false, {
		id: "synthetic",
	} as SessionHeader);
}

test("normal appends submit only suffixes, do not digest, and retain exact running receipt", () => {
	const owned = journal();
	owned.commit(Buffer.from("header\n"));
	const digest = vi.spyOn(Object.getPrototypeOf(createHash("sha256")), "digest");
	const expected = [Buffer.from("header\n")];
	try {
		for (const line of ["first\n", "second\n", "third\n"]) {
			const suffix = Buffer.from(line);
			expected.push(Buffer.from(suffix));
			owned.append(suffix);
			suffix.fill(0);
		}
		expect(digest).not.toHaveBeenCalled();
		expect(ports.native.commitJournal).toHaveBeenCalledTimes(1);
		expect(ports.native.appendJournal.mock.calls.map((call) => call[3].toString())).toEqual([
			"first\n",
			"second\n",
			"third\n",
		]);
		expect(owned.read()).toEqual(Buffer.concat(expected));
		const receipt = owned.currentReceipt();
		expect(receipt).toEqual({
			bytes: Buffer.concat(expected).length,
			sha256: createHash("sha256").update(Buffer.concat(expected)).digest("hex"),
		});
	} finally {
		digest.mockRestore();
	}
});

test("explicit receipt verifies native prefix every time and quarantines after tamper", () => {
	const owned = journal();
	owned.append(Buffer.from("trusted\n"));
	owned.currentReceipt();
	owned.currentReceipt();
	expect(ports.native.verifyJournal).toHaveBeenCalledTimes(2);
	ports.state.tampered = true;
	expect(() => owned.currentReceipt()).toThrow("OWNER_JOURNAL_UNCERTAIN");
	expect(ports.native.quarantine).toHaveBeenCalledTimes(1);
	expect(() => owned.append(Buffer.from("later\n"))).toThrow("QUARANTINED");
});

test("synchronous suffix append is allowed only inside original active terminal scope", async () => {
	const owned = journal();
	owned.append(Buffer.from("header\n"));
	await owned.seal();
	expect(() => owned.append(Buffer.from("outside\n"))).toThrow("QUARANTINED");
	await owned.terminal(() => {
		owned.append(Buffer.from("terminal\n"));
		expect(owned.currentReceipt().bytes).toBe(16);
	});
	expect(ports.native.appendTerminalJournal).toHaveBeenCalledTimes(1);
	expect(ports.native.appendJournal).toHaveBeenCalledTimes(1);
	expect(() => owned.append(Buffer.from("after\n"))).toThrow("QUARANTINED");
});

test("terminal async path copies only suffix before native lifecycle receipt acceptance", async () => {
	const owned = journal();
	owned.append(Buffer.from("header\n"));
	await owned.seal();
	ports.native.appendTerminalJournalAsync.mockImplementation(
		(_lease: object, _name: string, previousLength: number, suffix: Buffer) => {
			expect(previousLength).toBe(7);
			expect(suffix.toString()).toBe("terminal\n");
			return {
				ready: Promise.resolve(),
				remaining: () => 30000,
				complete: () => {
					ports.state.bytes = Buffer.concat([ports.state.bytes, suffix]);
					return { next: null, value: ports.state.bytes.length };
				},
			};
		},
	);
	await owned.terminal(async () => {
		await owned.appendTerminalAsync(Buffer.from("terminal\n"));
		expect(owned.currentReceipt().bytes).toBe(16);
	});
	expect(ports.native.commitTerminalJournalAsync).not.toHaveBeenCalled();
});
