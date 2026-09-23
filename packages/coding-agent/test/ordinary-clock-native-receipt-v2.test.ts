import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { OriginalClockObservation } from "../src/core/ordinary-clock-evidence.ts";
import type { OwnerAdmissionPolicy } from "../src/core/owner-effects.ts";
import { OwnedJournal, OwnerHost } from "../src/core/owner-effects.ts";
import { OWNER_NATIVE_ABI, type OwnerHostProfile } from "../src/core/owner-profile.ts";
import type { SessionHeader } from "../src/core/session-manager.ts";

// MOCK: actual owner-effects receipt loop and profile decoder; modeled filesystem,
// addon and clock ports. No genuine native allocation, addon load or qualification.
// Native failure selection/attempt observation remain unresolved. Required later
// runs: SAME definitions under Node 24 and Bun; currently UNRUN.
const ports = vi.hoisted(() => {
	const state = {
		events: [] as string[],
		fd: 10,
		paths: new Map<number, string>(),
		files: new Map<string, Buffer>(),
		closed: [] as number[],
		beforeFailure: undefined as { cause: unknown } | undefined,
		afterFailure: undefined as { cause: unknown } | undefined,
		first: undefined as { cause: unknown } | undefined,
		start: vi.fn(),
		seal: vi.fn(),
		cancel: vi.fn(),
	};
	const observation = {
		local: { monotonicMs: 10, wallMs: 20 },
		sequence: "1",
		eventMeaning: "native-operation-completion",
		parent: {
			version: 1,
			kind: "original-native-clock-witness",
			before: { monotonicNs: "100", bootId: "mock-boot", timeNamespace: { device: "1", inode: "2" }, pid: 1 },
			after: { monotonicNs: "101", bootId: "mock-boot", timeNamespace: { device: "1", inode: "2" }, pid: 1 },
		},
	} satisfies OriginalClockObservation;
	const native = {
		abi: 3,
		validateHost: vi.fn(() => ({})),
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
		seal: state.seal,
		quarantine: () => undefined,
		cancelLifecycle: state.cancel,
		beginClose() {},
		readJournal: () => Buffer.alloc(0),
		commitJournal: () => 0,
		commitTerminalJournal: () => 0,
		commitTerminalJournalAsync: state.start,
		prepareLaunch: () => ({}),
		dispatchLaunch: () => 1,
		requestStopLaunch() {},
		stopLaunch: state.start,
		pollLaunch: state.start,
		writeLaunchStdin: () => 0,
		retireLaunch: state.start,
		beginOperation: vi.fn(() => ({})),
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
		completeOperation: state.start,
		releaseOwner: state.start,
	};
	return { state, native, observation };
});
const content = Buffer.from("inert-original-addon-fixture");
const hash = createHash("sha256").update(content).digest("hex");
if (process.arch !== "x64" && process.arch !== "arm64") throw new Error("MOCK_RUNTIME_ARCHITECTURE");
const profile = {
	version: 1,
	id: "mock-receipt-host",
	runtime: {
		kind: process.versions.bun ? "bun" : "node",
		architecture: process.arch,
		version: process.versions.bun ?? process.versions.node,
		libc: "glibc",
	},
	host: { uid: 1000, gid: 1000, unit: "mock.service", cgroup: "/fixture.slice/mock.service" },
	artifacts: {
		addon: { path: "/fixture/addon", sha256: hash },
		bubblewrap: { path: "/fixture/sandbox", sha256: hash },
		runtime: { path: "/fixture/runtime", sha256: hash },
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
} satisfies OwnerHostProfile;
const profileBytes = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`);
vi.mock("node:module", () => ({
	createRequire: () => Object.assign(() => ports.native, { cache: {} }),
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
		if (!ports.state.paths.delete(fd)) throw new Error("MOCK_DESCRIPTOR_CLOSE_ONCE");
		ports.state.closed.push(fd);
	},
	readFileSync: (fd: number) => {
		const bytes = ports.state.files.get(ports.state.paths.get(fd)!);
		if (!bytes) throw new Error("MOCK_FILE_REQUIRED");
		return Buffer.from(bytes);
	},
	fstatSync: (fd: number) => {
		const path = ports.state.paths.get(fd);
		if (!path) throw new Error("MOCK_DESCRIPTOR_REQUIRED");
		const bytes = ports.state.files.get(path);
		return {
			isFile: () => bytes !== undefined,
			isDirectory: () => bytes === undefined,
			uid: 0,
			nlink: 1,
			mode: bytes ? 0o444 : 0o555,
			size: bytes?.length ?? 0,
			mtimeMs: 1,
			ctimeMs: 1,
			dev: 1,
			ino: path === "/proc/self/exe" || path === "/fixture/runtime" ? 1 : 2,
		};
	},
}));
vi.mock("../src/core/ordinary-clock.ts", () => ({
	beginOrdinaryClockOperation: () => {
		ports.state.events.push("before");
		if (ports.state.beforeFailure) throw ports.state.beforeFailure.cause;
		return {};
	},
	commitOrdinaryClockOperation: () => {
		ports.state.events.push("after");
		if (ports.state.afterFailure) throw ports.state.afterFailure.cause;
		return ports.observation;
	},
	failOrdinaryClockOperation: (cause: unknown) => {
		ports.state.first ??= { cause };
		throw ports.state.first.cause;
	},
}));

beforeEach(() => {
	ports.state.events.length = 0;
	ports.state.closed.length = 0;
	ports.state.files.clear();
	ports.state.files.set("/fixture/profile", profileBytes);
	for (const path of ["/fixture/addon", "/fixture/sandbox", "/fixture/runtime", "/proc/self/exe"])
		ports.state.files.set(path, content);
	ports.state.beforeFailure = ports.state.afterFailure = ports.state.first = undefined;
	ports.state.start.mockReset();
	ports.state.seal.mockReset();
	ports.state.cancel.mockReset();
	ports.native.validateHost.mockClear();
	ports.native.beginOperation.mockClear();
});
afterEach(() => {
	expect(ports.state.paths.size).toBe(0);
	expect(new Set(ports.state.closed).size).toBe(ports.state.closed.length);
});
function operation() {
	expect(ports.native.abi).toBe(OWNER_NATIVE_ABI);
	const host = OwnerHost.loadNative("/fixture/profile");
	expect(host.profile).toEqual(profile);
	expect(ports.native.validateHost).toHaveBeenCalledTimes(1);
	expect(ports.native.validateHost).toHaveBeenCalledWith(
		profile,
		expect.objectContaining({
			profileDigest: createHash("sha256").update(profileBytes).digest("hex"),
			cgroupRoot: expect.any(Number),
			storageRoot: expect.any(Number),
			toolRoot: expect.any(Number),
			fileRoots: [],
			bubblewrapFile: expect.any(Number),
			artifactFiles: [expect.any(Number)],
		}),
	);
	const journal = OwnedJournal.acquire(host, "synthetic", "now_synthetic.jsonl", false, {
		id: "synthetic",
	} as SessionHeader);
	journal.activate(host.admit(journal, {} as OwnerAdmissionPolicy));
	return { journal, effect: journal.beginOperation({ kind: "worker" }) };
}
interface ModeledReceipt {
	ready: Promise<void>;
	remaining(): number;
	complete(): { next: ModeledReceipt | null; value: undefined };
}
function receipt(complete: ModeledReceipt["complete"], ready = Promise.resolve()): ModeledReceipt {
	return { ready, remaining: vi.fn(() => 30000), complete };
}

test("readiness precedes the one actual completion, observation is returned DATA", async () => {
	let ready!: () => void;
	const pending = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const complete = vi.fn(() => {
		ports.state.events.push("complete");
		return { next: null, value: undefined };
	});
	const retained = receipt(complete, pending);
	ports.state.start.mockReturnValue(retained);
	const { effect } = operation();
	const settled = effect.complete(false, true);
	await Promise.resolve();
	expect(ports.state.events).toEqual([]);
	expect(ports.state.start).toHaveBeenCalledTimes(1);
	expect(complete).not.toHaveBeenCalled();
	ready();
	const observation = await settled;
	expect(ports.state.events).toEqual(["before", "complete", "after"]);
	expect(complete).toHaveBeenCalledTimes(1);
	expect(observation?.eventMeaning).toBe("native-operation-completion");
	expect(observation).toBe(ports.observation);
	expect(complete.mock.contexts).toEqual([retained]);
	expect(retained.remaining).toHaveBeenCalledTimes(1);
	expect(ports.state.start).toHaveBeenCalledTimes(1);
	expect(ports.state.start).toHaveBeenCalledWith(ports.native.beginOperation.mock.results[0].value, false);
	expect(ports.state.cancel).not.toHaveBeenCalled();
});

test.each(["before", "after"] as const)(
	"%s failure completes the SAME retained receipt once, then rejects",
	async (edge) => {
		const failure = new Error(edge);
		if (edge === "before") ports.state.beforeFailure = { cause: failure };
		else ports.state.afterFailure = { cause: failure };
		const complete = vi.fn(() => {
			ports.state.events.push("complete");
			return { next: null, value: undefined };
		});
		const retained = receipt(complete);
		ports.state.start.mockReturnValue(retained);
		const { effect, journal } = operation();
		await expect(effect.complete(false, true)).rejects.toBe(failure);
		await expect(effect.complete(false, true)).rejects.toBe(failure);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(ports.state.events).toEqual(edge === "before" ? ["before", "complete"] : ["before", "complete", "after"]);
		expect(() => journal.assertActive()).toThrow("QUARANTINED");
		expect(complete.mock.contexts).toEqual([retained]);
		expect(retained.remaining).toHaveBeenCalledTimes(1);
		expect(ports.state.start).toHaveBeenCalledTimes(1);
		expect(ports.state.cancel).not.toHaveBeenCalled();
	},
);

test("throw undefined from original complete stays failed, with no after edge or retry", async () => {
	const complete = vi.fn(() => {
		ports.state.events.push("complete");
		throw undefined;
	});
	const retained = receipt(complete);
	ports.state.start.mockReturnValue(retained);
	const { effect, journal } = operation();
	await expect(effect.complete(false, true)).rejects.toBeUndefined();
	expect(ports.state.events).toEqual(["before", "complete"]);
	expect(complete).toHaveBeenCalledTimes(1);
	// The rejected serialization tail propagates the SAME undefined cause; the
	// later seal body cannot run and manufacture OWNER_LIFECYCLE_UNKNOWN instead.
	await expect(journal.seal()).rejects.toBeUndefined();
	expect(complete.mock.contexts).toEqual([retained]);
	expect(ports.state.start).toHaveBeenCalledTimes(1);
	expect(ports.state.seal).not.toHaveBeenCalled();
	expect(complete).toHaveBeenCalledTimes(1);
	expect(ports.state.cancel).not.toHaveBeenCalled();
});

test("before failure plus uncertain cleanup retains primary and cleanup; never retries", async () => {
	const primary = new Error("before"),
		cleanup = new Error("uncertain receipt");
	ports.state.beforeFailure = { cause: primary };
	const complete = vi.fn(() => {
		throw cleanup;
	});
	const retained = receipt(complete);
	ports.state.start.mockReturnValue(retained);
	const { effect } = operation();
	let failure: unknown;
	try {
		await effect.complete(false, true);
	} catch (cause) {
		failure = cause;
	}
	expect(failure).toMatchObject({ cause: primary, errors: [primary, cleanup] });
	expect(failure).toBeInstanceOf(AggregateError);
	expect((failure as AggregateError).cause).toBe(primary);
	expect((failure as AggregateError).errors[0]).toBe(primary);
	expect((failure as AggregateError).errors[1]).toBe(cleanup);
	await expect(effect.complete(false, true)).rejects.toBe(failure);
	expect(complete).toHaveBeenCalledTimes(1);
	expect(complete.mock.contexts).toEqual([retained]);
	expect(ports.state.events).toEqual(["before"]);
	expect(ports.state.start).toHaveBeenCalledTimes(1);
	expect(ports.state.cancel).not.toHaveBeenCalled();
});

test("legacy acknowledgement supplier is rejected before invocation or native start", async () => {
	const unsupported = vi.fn(() => {
		throw new Error("must not run");
	});
	const { effect } = operation();
	await expect(Reflect.apply(effect.complete, effect, [false, unsupported])).rejects.toThrow("CALLBACK_UNSUPPORTED");
	expect(unsupported).not.toHaveBeenCalled();
	expect(ports.state.start).not.toHaveBeenCalled();
});
