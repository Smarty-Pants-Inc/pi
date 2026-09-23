import { createHash } from "node:crypto";
import { afterEach, test as baseTest, beforeEach, expect, vi } from "vitest";
import {
	createOperationalOutsideFinal,
	type OriginalOutsideFinalSelection,
} from "../src/core/ordinary-sc085-source/outside-final.ts";
import type * as OutsideData from "../src/core/ordinary-sc085-source/outside-final-data.ts";
import { canonicalPilotDecision } from "../src/core/ordinary-sc085-source/references/sense/src/adapters/codex/pilot-canonical.ts";

// UNRUN definitions for the REAL outside receiver. Kernel/clock/files and graph
// validators/consumers are inert ports; this tests orchestration, not physical
// custody, native enforcement or Sense predicates (separately supplied/retained).
const ports = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
	lstat: vi.fn(),
	fstat: vi.fn(),
	stat: vi.fn(),
	read: vi.fn(),
	file: vi.fn(),
	initial: vi.fn(),
	epoch: vi.fn(),
	decision: vi.fn(),
	receiving: vi.fn(),
	stage: vi.fn(),
	final: vi.fn(),
	sense: vi.fn(),
	terminal: vi.fn(),
}));
vi.mock("node:fs", () => ({
	constants: { O_RDONLY: 0, O_DIRECTORY: 1, O_NOFOLLOW: 2, O_NONBLOCK: 4 },
	openSync: ports.open,
	closeSync: ports.close,
	lstatSync: ports.lstat,
	fstatSync: ports.fstat,
	statSync: ports.stat,
	readSync: ports.read,
	readFileSync: ports.file,
}));
vi.mock("../src/core/ordinary-sc085-source/ci-authority.ts", () => ({
	OPERATIONAL_CONTROLLER_SHA256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	assertOriginalCINativeBinding: vi.fn(),
	// Fixture strings are ASCII; the real CI encoding has separate definitions.
	canonicalOriginalCIData: (value: unknown) => canonicalPilotDecision(value),
}));
vi.mock("../src/core/ordinary-sc085-source/operational-admission.ts", () => ({
	verifyOperationalInitialRetention: ports.initial,
	parseOperationalEpochSource: ports.epoch,
}));
vi.mock("../src/core/ordinary-owner-policy.ts", () => ({
	parseOrdinaryOwnerRecord: ports.decision,
	parseOrdinaryOwnerReceiving: ports.receiving,
}));
vi.mock("../src/core/ordinary-sc085-source/outside-final-data.ts", async () => ({
	...(await vi.importActual<typeof OutsideData>("../src/core/ordinary-sc085-source/outside-final-data.ts")),
	decodeOutsideStaged: ports.stage,
	decodeOutsideFinal: ports.final,
}));
vi.mock("../src/core/ordinary-sc085-source/references/sense/outside-final/operational-staging.ts", () => ({
	receiveOperationalFinalGraphData: ports.sense,
	receiveOperationalTerminalData: ports.terminal,
}));
// The production root receiver is Linux-only; do not fake a different platform.
const test = baseTest.runIf(process.platform === "linux");
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());
let jobSequence = 0;
function fixture(
	options: {
		initialRows?: number;
		initialBytes?: number;
		extraRowBytes?: number;
		maxBytes?: number;
		maxRecords?: number;
		badRoot?: boolean;
		oldAuthority?: boolean;
		constraintsCase?:
			| "missing-route"
			| "extra"
			| "null-route"
			| "malformed-route"
			| "substituted-route"
			| "missing-transport"
			| "invalid-transport"
			| "extra-transport"
			| "substituted-transport";
		routeCase?:
			| "owner"
			| "receiving"
			| "tuple"
			| "directory"
			| "validity"
			| "controller"
			| "sum"
			| "extra"
			| "missing-retained"
			| "changed-retained";
	} = {},
) {
	const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
	const state = "/var/lib/smarty-ci-candidate-stage-v1",
		job = `${state}/jobs/${(++jobSequence).toString(16).padStart(32, "0")}`;
	const owner = "synthetic.service",
		invocationId = "1".repeat(32),
		childPid = 98765;
	const releaseSha = "a".repeat(64),
		controller = {
			path: `/opt/smarty-ci-candidate/releases/${releaseSha}/candidate-run.py`,
			sha256: sha(Buffer.from("abc")),
		};
	const files = new Map<string, Buffer>(),
		inode = new Map<string, bigint>();
	let sequence = 100n;
	const putBytes = (path: string, body: Buffer) => {
		files.set(path, body);
		if (!inode.has(path)) inode.set(path, ++sequence);
		return { path, sha256: sha(body) };
	};
	const put = (path: string, body: unknown) => putBytes(path, canonicalPilotDecision(body));
	const opaque = (name: string) => put(`/fixture/${name}`, { synthetic: name });
	putBytes(controller.path, Buffer.from("abc"));
	const ownerRef = put("/fixture/owner", { controllerSource: controller }),
		limits = opaque("limits"),
		clockContract = opaque("clock-contract"),
		hostQualification = opaque("host-qualification");
	const host = put("/fixture/host", { qualification: hostQualification });
	const clockBasis = put("/fixture/basis", { contract: clockContract });
	const roster = put("/fixture/roster", {
		initialAt: { clockId: "synthetic", monotonicMs: 0, wallMs: 0, uncertaintyMs: 0, raw: clockBasis },
	});
	const scope = put("/fixture/scope", {
		owner: ownerRef,
		ownerEpoch: "epoch",
		limits,
		aggregate: { device: 1, inode: 1 },
	});
	const epochSourceRef = opaque("epoch-source"),
		epoch = put("/fixture/epoch", { source: epochSourceRef });
	const native = {
		decision: opaque("decision"),
		receiving: opaque("receiving"),
		profile: opaque("profile"),
		compiledReceiving: opaque("result"),
	};
	const producerContract = opaque("contract"),
		application = opaque("ordinary.js"),
		observer = opaque("observer"),
		accountingBinding = opaque("accounting");
	const admission = {
		owner: ownerRef,
		ownerEpoch: "epoch",
		admission: opaque("admission"),
		initial: opaque("initial-proof"),
		limits,
		survivor: opaque("survivor"),
		obligations: [{ id: "fd", kind: "fd-slot-final-proof" }],
	};
	const accounting = {
		binding: accountingBinding,
		owner: ownerRef,
		ownerEpoch: "epoch",
		observer,
		target: "target",
		watches: [{}],
	};
	const source2 = {
		entry: application,
		producerContract,
		evidence: [],
		agentDir: "/fixture/agent",
		...(options.oldAuthority ? { authority: {} } : {}),
	};
	const instruction = put("/fixture/instruction", {
		version: 1,
		operation: "sense-operational-pi",
		runId: "run",
		finalTail: admission,
		production: {
			source2,
			sourceAccounting: accounting,
			source: {
				workload: opaque("workload"),
				package: { document: opaque("package"), observer },
				target: "target",
				retention: opaque("retention"),
			},
			recorder: { root: "/records", maxBytes: options.maxBytes ?? 200000, maxRecords: options.maxRecords ?? 100 },
		},
	});
	const manifest = { input_sha256: instruction.sha256 };
	const expected = {
		repository_id: "1",
		run_id: "2",
		run_attempt: "1",
		source_sha: "b".repeat(40),
		source_tree: "c".repeat(40),
		control_sha: "d".repeat(40),
		workflow_sha: "e".repeat(40),
		recipe_sha256: "f".repeat(64),
		manifest_sha256: sha(canonicalPilotDecision(manifest)),
	};
	const allocation = { id: "allocation", session: "session" },
		phasePlan = opaque("phase-plan");
	const beforeBinding = {
		version: 1,
		namespace: "sense-operational-pi",
		producer_schema: "ops-bindings-17-source-diagnostics",
		producer_contract: producerContract,
		instruction,
		operational_run_id: "run",
		native,
		producers: {},
		allowed_operations: ["preflight"],
	};
	const validity = { startNs: "0", endNs: "25" };
	const derivation = put("/fixture/clock-route-derivation", {
		version: 1,
		kind: "original-ci-clock-evidence-derivation/1",
		controllerSource: options.routeCase === "controller" ? { ...controller, sha256: "0".repeat(64) } : controller,
		validity,
		stages: Object.fromEntries(
			["initial", "guardPairs", "coverage", "failureRetention"].map((name) => [name, { records: 1, bytes: 1 }]),
		),
	});
	const { manifest_sha256: _manifest, ...clockTuple } = expected;
	const routeValue = {
		version: 1,
		kind: "original-ci-clock-evidence-route/1",
		owner: options.routeCase === "owner" ? opaque("foreign-owner") : ownerRef,
		receiving: options.routeCase === "receiving" ? opaque("foreign-receiving") : native.receiving,
		reservation: {
			...clockTuple,
			...(options.routeCase === "tuple" ? { run_id: "3" } : {}),
			allocation,
			resourceEpoch: "epoch",
		},
		directory: { device: "1", inode: options.routeCase === "directory" ? "2" : "1" },
		validity: options.routeCase === "validity" ? { ...validity, endNs: "26" } : validity,
		records: 4,
		bytes: options.routeCase === "sum" ? 5 : 4,
		route: derivation,
		...(options.routeCase === "extra" ? { qualification: true } : {}),
	};
	const clockRoute = put("/fixture/clock-route", routeValue);
	if (options.routeCase === "changed-retained")
		files.set(clockRoute.path, canonicalPilotDecision({ ...routeValue, records: 5 }));
	const constraints: Record<string, unknown> = {
		N: 2,
		T: 1,
		budget: 2,
		epochSource: epochSourceRef,
		otherResources: {},
		clockEvidenceRoute: clockRoute,
		transport: { records: 5, bytes: 65536 }, // Synthetic DATA, never a source lease.
	};
	if (options.constraintsCase === "missing-transport") delete constraints.transport;
	if (options.constraintsCase === "invalid-transport") constraints.transport = { records: 0, bytes: 65536 };
	if (options.constraintsCase === "extra-transport") constraints.transport = { records: 5, bytes: 65536, grant: true };
	if (options.constraintsCase === "missing-route") delete constraints.clockEvidenceRoute;
	if (options.constraintsCase === "extra") constraints.clockLimits = { records: 4, bytes: 4 };
	if (options.constraintsCase === "null-route") constraints.clockEvidenceRoute = null;
	if (options.constraintsCase === "malformed-route") constraints.clockEvidenceRoute = { path: clockRoute.path };
	const prelaunch = {
		version: 1,
		kind: "original-ci-operational-selection",
		phasePlan,
		allocation,
		resourceEpoch: "epoch",
		receiving: native.receiving,
		execution: {},
		constraints,
		operationalBinding: beforeBinding,
	};
	const prelaunchPolicy = put("/fixture/prelaunch-policy", { operational_prelaunch: prelaunch });
	const finalPrelaunch = structuredClone(prelaunch);
	if (options.constraintsCase === "substituted-route")
		finalPrelaunch.constraints.clockEvidenceRoute = opaque("replacement-route");
	if (options.constraintsCase === "substituted-transport")
		finalPrelaunch.constraints.transport = { records: 6, bytes: 65536 };
	const policy = put("/fixture/policy", { operational_prelaunch: finalPrelaunch });
	const preflight = { N: 2, T: 1, budget: 2, scope, epoch, proofs: { initialFdRoster: roster } };
	const binding = { ...beforeBinding, policy, fd_slot_bound: preflight };
	const authorization = {
		repository_id: expected.repository_id,
		run_id: expected.run_id,
		run_attempt: expected.run_attempt,
		source_sha: expected.source_sha,
		source_tree: expected.source_tree,
		control_sha: expected.control_sha,
		workflow_sha: expected.workflow_sha,
		recipe_sha256: expected.recipe_sha256,
		release_sha256: releaseSha,
		manifest,
		operational_binding: binding,
	};
	const authorizationId = sha(canonicalPilotDecision(authorization));
	const authRef = put(`${state}/authorizations/${authorizationId}.json`, authorization);
	const intent = put(`/run/smarty-ci-candidate-delivery/1/2/1.intent.json`, {
		authorization_id: authorizationId,
		manifest_sha256: expected.manifest_sha256,
		binding: expected,
	});
	put(`${job}/execution-context.json`, {
		issuer: {
			authorization_id: authorizationId,
			authorization,
			issuer_intent_sha256: intent.sha256,
			issuer_binding: expected,
		},
		inputs: {},
	});
	put(`${state}/active.json`, { job, owner, mounts: ["synthetic"] });
	const clock = {
		clock: "CLOCK_MONOTONIC",
		timeNamespace: { device: "1", inode: "1" },
		bootId: "synthetic",
		startedNs: "0",
		runnerJoinDeadlineNs: "10",
		workloadDeadlineNs: "20",
		reportingDeadlineNs: "30",
		captureReleaseDeadlineNs: "25",
	};
	const reservation = put("/fixture/reservation", {
		policy: prelaunchPolicy,
		selectedRelease: { sha256: releaseSha, controlSha: expected.control_sha },
		clock,
	});
	const capture = put("/fixture/capture", {
		controller: { serviceUnit: owner, invocationId, pid: String(process.pid), startTicks: "1" },
		child: { pid: String(childPid), startTicks: "1" },
	});
	const entry = put("/fixture/ordinary-operational-entry.json", {
		controllerSource: controller,
		binding: expected,
		directory: { device: "1", inode: "1" },
	});
	const link = put(`${state}/management/operational-link-${authorizationId}.json`, {
		reservation,
		capture,
		prelaunchPolicy,
	});
	const enforcement = opaque("enforcement");
	const rows = [...files]
		.filter(
			([path]) =>
				path !== controller.path && !(options.routeCase === "missing-retained" && path === clockRoute.path),
		)
		.map(([path, bytes]) => ({ raw: { path, sha256: sha(bytes) }, base64: bytes.toString("base64") }));
	if (options.initialRows !== undefined)
		while (rows.length < options.initialRows) {
			const body = Buffer.from("{}");
			rows.push({
				raw: { path: `/fixture/extra-${rows.length}`, sha256: sha(body) },
				base64: body.toString("base64"),
			});
		}
	let total = rows.reduce((size, row) => size + Buffer.from(row.base64, "base64").length, 0);
	const append = (size: number) => {
		const body = Buffer.alloc(size, 32);
		rows.push({
			raw: { path: `/fixture/padding-${rows.length}`, sha256: sha(body) },
			base64: body.toString("base64"),
		});
		total += size;
	};
	while (options.initialBytes !== undefined && total < options.initialBytes)
		append(Math.min(65536, options.initialBytes - total));
	if (options.extraRowBytes !== undefined) append(options.extraRowBytes);
	const initial = putBytes(
		"/fixture/ordinary-resource-initial.json",
		Buffer.from(`${JSON.stringify({ records: rows, original: { scope, epoch, enforcement, initialFd: roster } })}\n`),
	);
	const initialRelease = put("/fixture/ordinary-operational-release.json", {
		version: 1,
		kind: "original-ci-operational-release",
		entry,
		captureSha256: capture.sha256,
		initial,
		authorizationId,
		wrapper: {
			version: 1,
			kind: "original-ci-operational-authorization",
			authorization_id: authorizationId,
			release_sha256: releaseSha,
			authorization,
			manifest_sha256: expected.manifest_sha256,
		},
		issuanceLink: link,
		releasedNs: "1",
		releasedWallSeconds: 1,
	});
	const selection: OriginalOutsideFinalSelection = {
		job,
		owner,
		authority: { controller, authorizationId, releaseSha256: releaseSha, expected },
		initialRelease,
	};
	ports.epoch.mockReturnValue({
		owner: ownerRef,
		repositoryId: "1",
		runId: "2",
		attempt: "1",
		controlSha: expected.control_sha,
		workflowSha: expected.workflow_sha,
		allocation,
		resourceEpoch: "epoch",
		receiving: native.receiving,
		phasePlan,
		clockContract,
		host,
		initialConditions: {},
	});
	const nativeRecord = {
		application,
		source: {},
		package: {},
		profileSha256: native.profile.sha256,
		decisionSha256: native.decision.sha256,
	};
	ports.decision.mockReturnValue(nativeRecord);
	ports.receiving.mockReturnValue(nativeRecord);
	let now = 1n;
	vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
	vi.spyOn(process, "geteuid").mockReturnValue(0);
	const descriptors = new Map<number, string>();
	let fdSequence = 10;
	const resolve = (path: string): string => {
		const match = /^\/proc\/self\/fd\/(\d+)(.*)$/.exec(path);
		return match ? `${descriptors.get(Number(match[1]))}${match[2]}` : path === `/proc/${childPid}/root` ? "" : path;
	};
	const info = (path: string) => {
		path = resolve(path);
		const file = files.has(path),
			recorder = path.startsWith("/records/");
		return {
			dev: 1n,
			ino: path === `${job}/root` ? (options.badRoot ? 2n : 1n) : (inode.get(path) ?? 1n),
			uid: recorder || path === "/records" ? 1000n : 0n,
			gid: 0n,
			mode: recorder ? 0o600n : path === "/records" ? 0o700n : file ? 0o444n : 0o555n,
			size: BigInt(files.get(path)?.length ?? 0),
			nlink: 1n,
			mtimeNs: 0n,
			ctimeNs: 0n,
			isFile: () => file,
			isDirectory: () => !file,
		};
	};
	ports.open.mockImplementation((path: string) => {
		const fd = fdSequence++;
		descriptors.set(fd, resolve(path));
		return fd;
	});
	ports.close.mockImplementation((fd: number) => {
		expect(descriptors.delete(fd)).toBe(true);
	});
	ports.fstat.mockImplementation((fd: number) => info(descriptors.get(fd)!));
	ports.lstat.mockImplementation(info);
	ports.stat.mockReturnValue({ dev: 1n, ino: 1n });
	ports.read.mockImplementation((fd: number, target: Buffer, offset: number, length: number, position: number) => {
		const body = files.get(descriptors.get(fd)!)!;
		expect(body).toBeDefined();
		return body.copy(target, offset, position, position + length);
	});
	ports.file.mockImplementation((path: string) => {
		if (path === "/proc/sys/kernel/random/boot_id") return "synthetic\n";
		if (path.endsWith("/stat")) return `1 (synthetic) S ${Array(18).fill("0").join(" ")} 1`;
		if (path.endsWith("/status")) return "Uid:\t1000\t1000\t1000\t1000\n";
		if (path.endsWith("/cgroup")) return `0::/${owner}\n`;
		if (path.endsWith("/environ")) return `INVOCATION_ID=${invocationId}\0`;
		throw new Error(`unexpected fixture read: ${path}`);
	});
	const stage = put("/records/record-0.bin", { synthetic: "stage" });
	const stageBody = files.get(stage.path)!;
	const manifestRow = {
		file: "record-0.bin",
		logicalPath: stage.path,
		device: "1",
		inode: String(inode.get(stage.path)),
		size: stageBody.length,
		sha256: stage.sha256,
	};
	putBytes("/records/manifest.jsonl", Buffer.from(`${JSON.stringify(manifestRow)}\n`));
	const staged = {
		owner: { staged: stage, owner: ownerRef, ownerEpoch: "epoch", binding: accountingBinding },
		terminal: opaque("terminal"),
		billing: { status: "data", basis: opaque("billing") },
		admission,
		status: "pending-finalization",
		failures: [],
		refusals: [],
		award: null,
	};
	ports.stage.mockReturnValue(staged);
	ports.terminal.mockReturnValue({});
	const call = { path: `${job}/operational/fd-slot-final-call.json`, sha256: sha(Buffer.from("{}\n")) },
		returned = { path: `${job}/operational/fd-slot-final-return.json`, sha256: sha(Buffer.from("{}\n")) };
	const decoded = {
		kind: "original-outside-final-data",
		graph: { synthetic: "graph" },
		result: { releaseClockCoverage: { synthetic: "release" } },
		award: null,
	};
	const sense = {
		graph: {
			releaseClockCoverage: decoded.result.releaseClockCoverage,
			award: null,
			remaining: ["synthetic-obligation"],
		},
	};
	ports.final.mockReturnValue(decoded);
	ports.sense.mockReturnValue(sense);
	return {
		selection,
		clockRoute,
		authRef,
		stage,
		staged,
		call,
		returned,
		decoded,
		sense,
		files,
		descriptors,
		manifestRow,
		put,
		putBytes,
		setNow: (value: bigint) => {
			now = value;
		},
		bind: () => createOperationalOutsideFinal(selection),
		offer: { version: 1, kind: "sense-operational-staged", stage },
		// Synthetic stand-in for Resource's OWN test of actual finalize publication.
		publishFinal: () => {
			putBytes(call.path, Buffer.from("{}\n"));
			putBytes(returned.path, Buffer.from("{}\n"));
		},
	};
}

test("prebind captures original authorization/root before stage; no retired child proc reopening", () => {
	const f = fixture(),
		receiver = f.bind();
	expect(receiver.original.authorization).toEqual(f.authRef);
	expect(ports.stage).not.toHaveBeenCalled();
	const rootOpens = ports.open.mock.calls.filter(([path]) => /\/proc\/\d+\/root$/.test(String(path)));
	expect(rootOpens).toHaveLength(1);
	receiver.receiveStaged(f.offer);
	receiver.close();
	expect(ports.open.mock.calls.filter(([path]) => /\/proc\/\d+\/root$/.test(String(path)))).toHaveLength(1);
	expect(f.descriptors.size).toBe(0);
});

test("original selected clock route stays retained and joined before child-root prebind", () => {
	const f = fixture(),
		receiver = f.bind();
	expect(receiver.retained.get(f.clockRoute.path)).toEqual(f.files.get(f.clockRoute.path));
	expect(ports.stage).not.toHaveBeenCalled();
	receiver.close();
});

test.each([
	"missing-route",
	"extra",
	"null-route",
	"malformed-route",
	"substituted-route",
	"missing-transport",
	"invalid-transport",
	"extra-transport",
	"substituted-transport",
] as const)("original closed constraints refuse %s before child-root prebind", (constraintsCase) => {
	const f = fixture({ constraintsCase });
	const expected = constraintsCase.startsWith("substituted-")
		? "OPS_OUTSIDE_ORIGINAL_PRELAUNCH"
		: constraintsCase === "invalid-transport"
			? "OPS_OUTSIDE_TRANSPORT_BOUND"
			: "OPS_OUTSIDE_FIELDS";
	expect(f.bind).toThrow(expected);
	expect(ports.stage).not.toHaveBeenCalled();
	expect(ports.open.mock.calls.some(([path]) => /\/proc\/\d+\/root$/.test(String(path)))).toBe(false);
	expect(f.descriptors.size).toBe(0);
});

test.each([
	"owner",
	"receiving",
	"tuple",
	"directory",
	"validity",
	"controller",
	"sum",
	"extra",
	"missing-retained",
	"changed-retained",
] as const)("selected clock-route correspondence refuses %s", (routeCase) => {
	const f = fixture({ routeCase });
	expect(f.bind).toThrow(/OPS_OUTSIDE_(CLOCK_ROUTE|FIELDS|RETAINED_PIN)/);
	expect(ports.stage).not.toHaveBeenCalled();
	expect(ports.open.mock.calls.some(([path]) => /\/proc\/\d+\/root$/.test(String(path)))).toBe(false);
	expect(f.descriptors.size).toBe(0);
});

test.each(["early-final", "duplicate-stage"])("%s latches first order failure without another receive", (kind) => {
	const f = fixture(),
		receiver = f.bind();
	if (kind === "duplicate-stage") receiver.receiveStaged(f.offer);
	let first: unknown;
	try {
		if (kind === "early-final") receiver.receiveFinal({ call: f.call, returned: f.returned });
		else receiver.receiveStaged(f.offer);
	} catch (error) {
		first = error;
	}
	expect(first).toBeInstanceOf(Error);
	for (const call of [
		() => receiver.receiveStaged(f.offer),
		() => receiver.receiveFinal({ call: f.call, returned: f.returned }),
	])
		expect(call).toThrow(first as Error);
	expect(ports.final).not.toHaveBeenCalled();
	receiver.close();
});

test("actual final refs must exist before intake; failure cannot be retried after later publication", () => {
	const f = fixture(),
		receiver = f.bind();
	receiver.receiveStaged(f.offer);
	expect(() => receiver.receiveFinal({ call: f.call, returned: f.returned })).toThrow();
	f.publishFinal();
	expect(() => receiver.receiveFinal({ call: f.call, returned: f.returned })).toThrow();
	expect(ports.final).not.toHaveBeenCalled();
	receiver.close();
});

test("same receiver reads published call/return then passes selected graph to Sense and returns its DATA", () => {
	const f = fixture(),
		receiver = f.bind();
	receiver.receiveStaged(f.offer);
	f.publishFinal();
	const value = receiver.receiveFinal({ call: f.call, returned: f.returned });
	expect(ports.final).toHaveBeenCalledTimes(1);
	expect(ports.sense).toHaveBeenCalledTimes(1);
	expect(ports.final.mock.invocationCallOrder[0]).toBeLessThan(ports.sense.mock.invocationCallOrder[0]);
	expect(ports.sense.mock.calls[0][0]).toEqual(f.stage);
	expect(ports.sense.mock.calls[0][1]).toEqual(f.decoded.graph);
	expect(value.sense).toEqual(f.sense);
	expect(value.award).toBeNull();
	expect(() => receiver.receiveFinal({ call: f.call, returned: f.returned })).toThrow("OPS_OUTSIDE_FINAL_ORDER");
	receiver.close();
});

test.each(["missing", "changed"])("selected recorder %s byte refuses without arbitrary host fallback", (mode) => {
	const f = fixture(),
		receiver = f.bind();
	if (mode === "missing") f.files.delete(f.stage.path);
	else f.files.set(f.stage.path, Buffer.from("changed"));
	expect(() => receiver.receiveStaged(f.offer)).toThrow();
	expect(ports.stage).not.toHaveBeenCalled();
	receiver.close();
});

test("missing logical retained edge never falls back to an existing host file", () => {
	const f = fixture(),
		receiver = f.bind(),
		foreign = f.put("/fixture/foreign-after-bind", {});
	ports.stage.mockImplementationOnce((_stage, _admission, _accounting, records: OutsideData.OutsideRecords) => {
		records.bytes(foreign);
		return f.staged;
	});
	expect(() => receiver.receiveStaged(f.offer)).toThrow("OPS_OUTSIDE_ORIGINAL_RECORD_NOT_RETAINED");
	receiver.close();
});

test.each([{ initialRows: 97 }, { maxBytes: 1 }, { maxRecords: 1 }, { badRoot: true }, { oldAuthority: true }])(
	"original cap/root/static authority refusal %j happens before staged decoding",
	(options) => {
		const f = fixture(options);
		expect(f.bind).toThrow();
		expect(ports.stage).not.toHaveBeenCalled();
		expect(f.descriptors.size).toBe(0);
	},
);

test("original 96-row initial ceiling is not widened", () => {
	const f = fixture({ initialRows: 96, maxRecords: 120 });
	const receiver = f.bind();
	receiver.close();
});

test("original runner-join deadline expires before child-root prebind", () => {
	const f = fixture();
	f.setNow(10n);
	expect(f.bind).toThrow("OPS_OUTSIDE_ORIGINAL_DEADLINE");
	expect(ports.stage).not.toHaveBeenCalled();
	expect(f.descriptors.size).toBe(0);
});

test("stage offer cannot select a different or non-last recorder record", () => {
	const f = fixture(),
		receiver = f.bind();
	expect(() => receiver.receiveStaged({ ...f.offer, stage: { ...f.stage, path: "/records/record-1.bin" } })).toThrow(
		"OPS_OUTSIDE_STAGE_NOT_FINAL_RECORD",
	);
	expect(ports.stage).not.toHaveBeenCalled();
	receiver.close();
});

test.each(["stage", "final"])("genuine %s deadline expiry latches without decode/retry", (phase) => {
	const f = fixture(),
		receiver = f.bind();
	if (phase === "stage") {
		f.setNow(20n);
		expect(() => receiver.receiveStaged(f.offer)).toThrow("OPS_OUTSIDE_ORIGINAL_DEADLINE");
	} else {
		receiver.receiveStaged(f.offer);
		f.publishFinal();
		f.setNow(30n);
		expect(() => receiver.receiveFinal({ call: f.call, returned: f.returned })).toThrow(
			"OPS_OUTSIDE_ORIGINAL_DEADLINE",
		);
	}
	expect(ports.final).not.toHaveBeenCalled();
	receiver.close();
});

test("thrown undefined is a sticky failure, not replay permission", () => {
	const f = fixture(),
		receiver = f.bind();
	ports.stage.mockImplementationOnce(() => {
		throw undefined;
	});
	for (const call of [() => receiver.receiveStaged(f.offer), () => receiver.receiveStaged(f.offer)]) {
		let returned = false;
		try {
			call();
			returned = true;
		} catch (error) {
			expect(error).toBeUndefined();
		}
		expect(returned).toBe(false);
	}
	expect(ports.stage).toHaveBeenCalledTimes(1);
	expect(receiver.failure()).toEqual({ cause: undefined });
	receiver.close();
});

test("uncertain close consumes the descriptor once and preserves failure", () => {
	const f = fixture(),
		receiver = f.bind();
	const closing = new Error("synthetic close uncertainty");
	ports.close.mockImplementationOnce(() => {
		throw closing;
	});
	expect(() => receiver.close()).toThrow("OPS_OUTSIDE_CLOSE_UNKNOWN");
	const calls = ports.close.mock.calls.length;
	receiver.close();
	expect(ports.close).toHaveBeenCalledTimes(calls);
	expect(receiver.failure()).not.toBeUndefined();
});

test.each([2 * 1024 * 1024, 2 * 1024 * 1024 + 1])("initial semantic byte boundary stays 2 MiB: %s", (initialBytes) => {
	const f = fixture({ initialBytes, maxBytes: 8 * 1024 * 1024, maxRecords: 120 });
	if (initialBytes > 2 * 1024 * 1024) expect(f.bind).toThrow(/OPS_INITIAL_RECORD_/);
	else f.bind().close();
	expect(f.descriptors.size).toBe(0);
});

test.each([65536, 65537])("semantic row boundary stays 64 KiB: %s", (extraRowBytes) => {
	const f = fixture({ extraRowBytes, maxBytes: 1024 * 1024 });
	if (extraRowBytes > 65536) expect(f.bind).toThrow("OPS_INITIAL_RECORD_RETENTION");
	else f.bind().close();
});

test("a recorder row cannot rebind the already retained original authorization key", () => {
	const f = fixture(),
		receiver = f.bind();
	f.putBytes(
		"/records/manifest.jsonl",
		Buffer.from(`${JSON.stringify({ ...f.manifestRow, logicalPath: f.authRef.path })}\n`),
	);
	expect(() => receiver.receiveStaged(f.offer)).toThrow("OPS_OUTSIDE_REBOUND");
	expect(ports.stage).not.toHaveBeenCalled();
	receiver.close();
});

test("swallowed synchronous close reentry remains sticky after decoder returns", () => {
	const f = fixture(),
		receiver = f.bind();
	ports.stage.mockImplementationOnce(() => {
		try {
			receiver.close();
		} catch {
			/* hostile swallowed failure */
		}
		return f.staged;
	});
	expect(() => receiver.receiveStaged(f.offer)).toThrow("OPS_OUTSIDE_REENTRY");
	expect(() => receiver.receiveStaged(f.offer)).toThrow("OPS_OUTSIDE_REENTRY");
	expect(ports.stage).toHaveBeenCalledTimes(1);
	receiver.close();
});
