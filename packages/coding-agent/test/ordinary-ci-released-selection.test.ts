import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	assertOriginalCINativeBinding,
	canonicalOriginalCIData,
	OPERATIONAL_CONTROLLER_SHA256,
	type ReceivedCIData,
} from "../src/core/ordinary-sc085-source/ci-authority.ts";
import {
	joinReleasedCISelection,
	readReleasedCISelection,
} from "../src/core/ordinary-sc085-source/ci-released-selection.ts";
import { canonicalPilotDecision } from "../src/core/ordinary-sc085-source/references/sense/src/adapters/codex/pilot-canonical.ts";

// UNRUN synthetic DATA/custody definitions. No OS permissions or helper/native
// effects are exercised. Factory/helper call count is tested separately.
const io = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
	stat: vi.fn(),
	lstat: vi.fn(),
	fstat: vi.fn(),
	read: vi.fn(),
	file: vi.fn(),
}));
vi.mock("node:fs", () => ({
	constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 },
	openSync: io.open,
	closeSync: io.close,
	statSync: io.stat,
	lstatSync: io.lstat,
	fstatSync: io.fstat,
	readSync: io.read,
	readFileSync: io.file,
}));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
	const ref = (path: string, value: unknown) => ({ path, sha256: hash(canonicalPilotDecision(value)) });
	const native = {
		decision: ref("/fixture/decision", {}),
		receiving: ref("/fixture/receiving", {}),
		profile: ref("/fixture/profile", {}),
	};
	// Construction order is acyclic even when BOTH input and recipe select the
	// instruction: static Source2 -> instruction -> manifest/recipe -> auth -> release.
	const source2 = {
		entry: ref("/fixture/ordinary.js", {}),
		producerContract: ref("/fixture/contract", {}),
		evidence: [],
		agentDir: "/fixture/agent",
	};
	const instruction = ref("/fixture/instruction", { production: { source2 } });
	const manifest = { input_sha256: instruction.sha256 };
	const recipe = hash(Buffer.from(`consume ${instruction.path} ${instruction.sha256}\n`));
	const expected = {
		repository_id: "1",
		run_id: "2",
		run_attempt: "1",
		source_sha: "a".repeat(40),
		source_tree: "b".repeat(40),
		control_sha: "c".repeat(40),
		workflow_sha: "d".repeat(40),
		recipe_sha256: recipe,
		manifest_sha256: hash(canonicalPilotDecision(manifest)),
	};
	const releaseSha = "e".repeat(64);
	const auth = {
		repository_id: expected.repository_id,
		run_id: expected.run_id,
		run_attempt: expected.run_attempt,
		source_sha: expected.source_sha,
		source_tree: expected.source_tree,
		control_sha: expected.control_sha,
		workflow_sha: expected.workflow_sha,
		recipe_sha256: recipe,
		release_sha256: releaseSha,
		issued_at: 1,
		expires_at: 2,
		manifest,
		operational_binding: {
			version: 1,
			namespace: "sense-operational-pi",
			instruction,
			native,
			operational_run_id: "run",
			fd_slot_bound: { synthetic: true },
		},
	};
	const controllerSource = {
		path: `/opt/smarty-ci-candidate/releases/${releaseSha}/candidate-run.py`,
		sha256: OPERATIONAL_CONTROLLER_SHA256,
	};
	const entry = {
		version: 1,
		kind: "original-ci-operational-entry",
		receiving: native.receiving,
		reservation: ref("/fixture/reservation", {}),
		controllerSource,
		selectedRelease: { sha256: releaseSha, controlSha: expected.control_sha },
		child: {},
		execution: {},
		clock: {
			clock: "CLOCK_MONOTONIC",
			bootId: "synthetic",
			timeNamespace: { device: "1", inode: "1" },
			startedNs: "0",
			workloadDeadlineNs: "10",
			bodyDeadlineNs: "9",
		},
		runId: "run",
		resourceEpoch: "epoch",
		allocation: {},
		profileSha256: native.profile.sha256,
		aggregate: {},
		directory: { device: "1", inode: "1" },
		binding: { ...expected },
	};
	const entryRef = ref("/fixture/ordinary-operational-entry.json", entry);
	const authorizationId = hash(canonicalPilotDecision(auth));
	const release = {
		version: 1,
		kind: "original-ci-operational-release",
		entry: entryRef,
		captureSha256: "f".repeat(64),
		initial: ref("/fixture/initial", {}),
		authorizationId,
		wrapper: {
			version: 1,
			kind: "original-ci-operational-authorization",
			authorization_id: authorizationId,
			release_sha256: releaseSha,
			authorization: auth,
			manifest_sha256: expected.manifest_sha256,
		},
		issuanceLink: ref("/fixture/link", {}),
		releasedNs: "1",
		releasedWallSeconds: 1,
	};
	const releaseRef = ref("/fixture/ordinary-operational-release.json", release);
	const context = {
		version: 1,
		kind: "original-ci-operational-context",
		receiving: native.receiving,
		entry: entryRef,
		release: releaseRef,
		controller: {},
		clock: entry.clock,
		directory: entry.directory,
	};
	const contextRef = ref("/fixture/ordinary-operational-context.json", context);
	const selected = { instruction: structuredClone(instruction), native: structuredClone(native) };
	const records = [
		{ raw: contextRef, value: context },
		{ raw: entryRef, value: entry },
		{ raw: releaseRef, value: release },
	] as const;
	const bodies = new Map(records.map((record) => [record.raw.path, canonicalPilotDecision(record.value)]));
	let mode = 0o444n,
		now = 1n,
		ino = 1n;
	const info = (file: boolean, size = 0) => ({
		dev: 1n,
		ino,
		uid: 0n,
		gid: 0n,
		mode: file ? mode : 0o555n,
		nlink: 1n,
		size: BigInt(size),
		mtimeNs: 0n,
		ctimeNs: 0n,
		isFile: () => file,
		isDirectory: () => !file,
	});
	const opened = new Map<number, string>();
	let next = 3;
	io.open.mockImplementation((path: string) => {
		expect(bodies.has(path)).toBe(true);
		const fd = next++;
		opened.set(fd, path);
		return fd;
	});
	io.close.mockImplementation((fd: number) => {
		expect(opened.delete(fd)).toBe(true);
	});
	io.lstat.mockImplementation((path: string) => info(bodies.has(path), bodies.get(path)?.length));
	io.fstat.mockImplementation((fd: number) => info(true, bodies.get(opened.get(fd)!)!.length));
	io.stat.mockReturnValue(info(false));
	io.file.mockReturnValue("synthetic\n");
	io.read.mockImplementation((fd: number, target: Buffer, offset: number, length: number, position: number) => {
		const body = bodies.get(opened.get(fd)!)!;
		return body.copy(target, offset, position, position + length);
	});
	vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
	const join = () => joinReleasedCISelection(selected, ...records);
	return {
		selected,
		source2,
		expected,
		auth,
		entry,
		release,
		context,
		records,
		bodies,
		opened,
		join,
		setNow: (value: bigint) => {
			now = value;
		},
		setMode: (value: bigint) => {
			mode = value;
		},
		setInode: () => {
			ino++;
		},
	};
}

test("CI digest encoding is Python ASCII canonical data, not Pilot UTF-8 raw bytes", () => {
	const value = { text: "\u007fé𐀀" };
	expect(canonicalOriginalCIData(value).toString()).toBe('{"text":"\\u007f\\u00e9\\ud800\\udc00"}\n');
	expect(canonicalOriginalCIData(value)).not.toEqual(canonicalPilotDecision(value));
	expect(canonicalOriginalCIData({ 𐀀: 1, "\ue000": 2 }).toString()).toBe('{"\\ue000":2,"\\ud800\\udc00":1}\n');
	expect(() => canonicalOriginalCIData({ text: "é".repeat(12000) })).toThrow("OPS_CI_CANONICAL_BOUND");
});

test("actual full selection follows an acyclic instruction/input/recipe construction, without static authority", () => {
	const f = fixture();
	expect(Object.keys(f.source2).sort()).toEqual(["agentDir", "entry", "evidence", "producerContract"]);
	expect(f.join()).toEqual({
		controller: f.entry.controllerSource,
		expected: f.expected,
		authorizationId: f.release.authorizationId,
		releaseSha256: f.entry.selectedRelease.sha256,
	});
});

test.each([
	"repository_id",
	"run_id",
	"run_attempt",
	"source_sha",
	"source_tree",
	"control_sha",
	"workflow_sha",
	"recipe_sha256",
	"manifest_sha256",
] as const)("all original tuple members remain checked: %s", (key) => {
	const f = fixture();
	f.entry.binding[key] = "foreign";
	expect(f.join).toThrow("OPS_CI_RELEASED_TUPLE");
});

test.each(["instruction", "decision", "receiving", "profile"] as const)(
	"readonly released selection cannot substitute held %s",
	(key) => {
		const f = fixture();
		if (key === "instruction") f.selected.instruction = { ...f.selected.instruction, sha256: "0".repeat(64) };
		else f.selected.native[key] = { ...f.selected.native[key], sha256: "0".repeat(64) };
		expect(f.join).toThrow(/OPS_CI_RELEASED_(INSTRUCTION|NATIVE|RECEIVING)/);
	},
);

test.each(["authorizationId", "wrapper", "entry", "release"])("foreign %s correspondence refuses", (field) => {
	const f = fixture();
	if (field === "authorizationId") f.release.authorizationId = "0".repeat(64);
	if (field === "wrapper") f.auth.manifest.input_sha256 = "0".repeat(64);
	if (field === "entry") f.context.entry = { ...f.context.entry, sha256: "0".repeat(64) };
	if (field === "release") f.context.release = { ...f.context.release, sha256: "0".repeat(64) };
	expect(f.join).toThrow(/OPS_CI_RELEASED_/);
});

test("actual protected-directory reader captures DATA without leaving descriptors open", () => {
	const f = fixture(),
		selected = readReleasedCISelection(f.selected);
	expect(selected.selection).toEqual(f.join());
	expect(f.opened.size).toBe(0);
	expect([...io.open.mock.calls].every(([path]) => String(path).startsWith("/fixture/ordinary-operational-"))).toBe(
		true,
	);
	f.setInode();
	expect(() => selected.check()).toThrow("OPS_CI_RELEASED_DIRECTORY_CHANGED");
});

test("same selected path cannot rebind retained context bytes after initial selection", () => {
	const f = fixture(),
		selected = readReleasedCISelection(f.selected);
	f.bodies.set(f.records[0].raw.path, Buffer.from("{}"));
	expect(() => selected.check()).toThrow("OPS_CI_RELEASED_REBOUND");
	expect(f.opened.size).toBe(0);
});

test("original deadline expiry is checked, not renewed by another receive", () => {
	const f = fixture(),
		selected = readReleasedCISelection(f.selected);
	f.setNow(9n);
	expect(() => selected.check(undefined, "boundary")).toThrow("OPS_CI_RELEASED_DEADLINE");
	expect(() => selected.check()).not.toThrow();
	f.setNow(10n);
	expect(() => selected.check()).toThrow("OPS_CI_RELEASED_DEADLINE");
	f.setNow(11n);
	expect(() => readReleasedCISelection(f.selected)).toThrow("OPS_CI_RELEASED_DEADLINE");
});

test.each([0o644n, 0o400n])("unsealed or wrong-mode context refuses before authority use: %s", (mode) => {
	const f = fixture();
	f.setMode(mode);
	expect(() => readReleasedCISelection(f.selected)).toThrow("OPS_CI_RELEASED_FILE");
	expect(io.close).toHaveBeenCalledTimes(1);
});

test("read failure and uncertain close are preserved, without retry", () => {
	const f = fixture(),
		first = new Error("read"),
		closing = new Error("close");
	io.read.mockImplementationOnce(() => {
		throw first;
	});
	io.close.mockImplementationOnce(() => {
		throw closing;
	});
	expect(() => readReleasedCISelection(f.selected)).toThrow(
		expect.objectContaining({ message: "OPS_CI_RELEASED_READ_CLOSE", cause: first, errors: [first, closing] }),
	);
	expect(io.open).toHaveBeenCalledTimes(1);
	expect(io.close).toHaveBeenCalledTimes(1);
});

test("full helper wrapper must equal the captured wrapper, including any fourth native edge", () => {
	const f = fixture(),
		selected = readReleasedCISelection(f.selected);
	expect(() => selected.check(f.release.wrapper as unknown as ReceivedCIData)).not.toThrow();
	const foreign = structuredClone(f.release.wrapper);
	Object.assign(foreign.authorization.operational_binding.native, {
		compiledReceiving: { path: "/foreign/result.json", sha256: "0".repeat(64) },
	});
	expect(() => selected.check(foreign as unknown as ReceivedCIData)).toThrow("OPS_CI_RELEASED_WRAPPER");
});

test("closed native schema preserves historical three refs but outside bootstrap requires selected fourth", () => {
	const f = fixture();
	expect(() => assertOriginalCINativeBinding(f.selected.native)).not.toThrow();
	expect(() => assertOriginalCINativeBinding(f.selected.native, true)).toThrow(
		"OPS_OUTSIDE_COMPILED_CLOSURE_BOOTSTRAP_SOURCE_REQUIRED",
	);
	const compiled = {
		...f.selected.native,
		compiledReceiving: { path: "/fixture/result.json", sha256: "a".repeat(64) },
	};
	expect(() => assertOriginalCINativeBinding(compiled, true)).not.toThrow();
	for (const bad of [
		{ ...compiled, extra: true },
		{ ...compiled, compiledReceiving: null },
		{ compiledReceiving: compiled.compiledReceiving },
	])
		expect(() => assertOriginalCINativeBinding(bad)).toThrow();
});
