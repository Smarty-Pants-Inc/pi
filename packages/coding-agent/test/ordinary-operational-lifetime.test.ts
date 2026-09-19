import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
	type OriginalCISelection,
	receiveOriginalCIAuthorization,
} from "../src/core/ordinary-sc085-source/ci-authority.ts";
import {
	assertOperationalAdmissionTime,
	parseOperationalEpochSource,
	selectSc085PrimaryWatch,
} from "../src/core/ordinary-sc085-source/operational-admission.ts";
import {
	canonicalPilotDecision,
	parseCanonicalPilotDecision,
} from "../src/core/ordinary-sc085-source/references/sense/src/adapters/codex/pilot-canonical.ts";
import type { Sc085AdmissionV1 } from "../src/core/ordinary-sc085-source/sc085-admission.ts";

// Numeric source regressions only. No CI helper, native owner, permission, or
// continued custody is supplied by these data fixtures or by the exported check.
const start = 1_800_000_000_000;
const authorization = Object.freeze({ issued_at: start / 1000, expires_at: start / 1000 + 300 });
const allocation = Object.freeze({ notBeforeMs: start, expiresMs: start + 21_600_000 });
const workloadEnd = start + 19_800_000;
function clock(elapsed: number) {
	return {
		firstWall: start,
		firstMono: 100,
		lastWall: start,
		lastMono: 100,
		now: start + elapsed,
		mono: 100 + elapsed,
	};
}

describe("closed epoch-source data decoder, not parent-role authority", () => {
	const ref = { path: "/original/selected", sha256: "a".repeat(64) };
	const epoch = {
		version: 1,
		kind: "original-ci-operational-epoch-source",
		repositoryId: "1",
		runId: "2",
		attempt: "1",
		controlSha: "a".repeat(40),
		workflowSha: "b".repeat(40),
		allocation: {
			id: "raw-allocation",
			session: `allocation-${createHash("sha256").update("raw-allocation").digest("hex")}`,
		},
		resourceEpoch: "parent-epoch",
		ownerEpoch: "parent-epoch",
		ownerUid: "61184",
		owner: ref,
		limits: ref,
		receiving: ref,
		phasePlan: ref,
		clockContract: ref,
		initialConditions: Object.fromEntries(
			[
				"inheritedHardLimit",
				"initialFdRoster",
				"aggregateTasksMembership",
				"noForeignTableSharers",
				"noMigrationOrEscape",
				"noLimitRaiseOrExternalMutation",
				"targetAllocationSemantics",
			].map((name) => [name, ref]),
		),
	};
	test("preserves declared parent epoch and separate workload UID as data only", () => {
		expect(parseOperationalEpochSource(canonicalPilotDecision(epoch))).toEqual(epoch);
	});
	test.each([
		{ repositoryId: "01" },
		{ repositoryId: "1".repeat(21) },
		{ ownerUid: "0" },
		{ ownerUid: "2147483648" },
		{ resourceEpoch: "parent epoch", ownerEpoch: "parent epoch" },
		{ owner: { ...ref, path: "/original/../selected" } },
		{ owner: { ...ref, path: "/original//selected" } },
		{ owner: { ...ref, path: "/original/selected\n" } },
		{ attempt: "0" },
		{ ownerUid: "061184" },
		{ ownerEpoch: "child-native-grant" },
		{ controlSha: "a".repeat(64) },
		{ allocation: { id: "raw-allocation", session: "raw-allocation" } },
		{ owner: { ...ref, role: "parent" } },
		{ initialConditions: { ...epoch.initialConditions, retirementTail: ref } },
		{ initialConditions: { inheritedHardLimit: ref } },
		{ parentRole: true },
	])("rejects malformed tuple/role shortcuts %j", (changed) => {
		expect(() => parseOperationalEpochSource(canonicalPilotDecision({ ...epoch, ...changed }))).toThrow();
	});
});

describe("original selected cohort DATA correspondence", () => {
	function cohort() {
		const controls = Array.from({ length: 8 }, (_, index) => ({
			op: "watch",
			id: index === 7 ? "ops-primary" : `ops-passive-${index + 1}`,
			source: "build-status",
			input: { path: "/original/target" },
			every: "1s",
			wake: index === 7 ? "change" : "never",
		}));
		const checkpoint = {
			change: 1000,
			sourceSha256: "a".repeat(64),
			sourceBytes: 1,
			watches: controls.map((watch) => ({
				watchId: watch.id,
				executionKey: `key-${watch.id}`,
				stateNamespace: { kind: "original-setup" as const },
				outcome: "OK" as const,
				body: "body",
				diagnostic: null,
			})),
		};
		const checkpoints: Sc085AdmissionV1["checkpoints"] = [
			checkpoint,
			structuredClone(checkpoint),
			structuredClone(checkpoint),
			structuredClone(checkpoint),
			structuredClone(checkpoint),
		];
		return { controls, checkpoints };
	}
	test("primary LAST and independently permuted expectations preserve all eight peers", () => {
		const { controls, checkpoints } = cohort();
		checkpoints[2].watches.reverse();
		expect(selectSc085PrimaryWatch(controls, checkpoints)).toBe("ops-primary");
	});
	test("old one-watch shape remains accepted", () => {
		const { controls, checkpoints } = cohort();
		for (const checkpoint of checkpoints)
			checkpoint.watches = checkpoint.watches.filter((watch) => watch.watchId === "ops-primary");
		expect(
			selectSc085PrimaryWatch(
				controls.filter((watch) => watch.id === "ops-primary"),
				checkpoints,
			),
		).toBe("ops-primary");
	});
	test.each([
		"duplicate",
		"two-primary",
		"no-primary",
		"slow-peer",
		"missing-peer",
		"foreign-source",
		"foreign-input",
		"missing-expectation",
		"foreign-expectation",
	])("refuses %s without reducing work", (mode) => {
		const { controls, checkpoints } = cohort();
		if (mode === "duplicate") controls[0].id = controls[1].id;
		if (mode === "two-primary") controls[0].wake = "change";
		if (mode === "no-primary") controls[7].wake = "never";
		if (mode === "slow-peer") controls[0].every = "2s";
		if (mode === "missing-peer") controls.pop();
		if (mode === "foreign-source") controls[0].source = "other";
		if (mode === "foreign-input") controls[0].input.path = "/other";
		if (mode === "missing-expectation") checkpoints[3].watches.pop();
		if (mode === "foreign-expectation") checkpoints[4].watches[0].watchId = "foreign";
		expect(() => selectSc085PrimaryWatch(controls, checkpoints)).toThrow();
	});
});

describe("continued-authority transport input refusal", () => {
	// Deliberately inert selection: these tests must refuse before even opening
	// its nonexistent controller. They do not exercise or qualify the transport.
	const selection: OriginalCISelection = {
		controller: { path: "/nonexistent/controller", sha256: "0".repeat(64) },
		authorizationId: "0".repeat(64),
		releaseSha256: "0".repeat(64),
		expected: {
			repository_id: "0",
			run_id: "0",
			run_attempt: "0",
			source_sha: "0",
			source_tree: "0",
			control_sha: "0",
			workflow_sha: "0",
			recipe_sha256: "0",
			manifest_sha256: "0",
		},
	};
	const receiving = { path: "/original/job/receiving.json", sha256: "a".repeat(64) };
	test.each(["cleanup", "request\n", ""])("refuses non-original operation %j", (operation) => {
		expect(() =>
			receiveOriginalCIAuthorization(
				selection,
				receiving,
				operation as Parameters<typeof receiveOriginalCIAuthorization>[2],
			),
		).toThrow("OPS_CI_OPERATION");
	});
	test.each([
		{ ...receiving, path: "relative/receiving.json" },
		{ ...receiving, path: "/original/receiving\0.json" },
		{ ...receiving, sha256: "A".repeat(64) },
		{ ...receiving, sha256: "a".repeat(63) },
	])("refuses malformed selected receiving ref %j", (ref) => {
		expect(() => receiveOriginalCIAuthorization(selection, ref, "preflight")).toThrow("OPS_CI_NATIVE_RECEIVING");
	});
});

describe("same retained whole-policy encoding", () => {
	test("retains CI metadata and SC085 operands together in canonical Unicode bytes", () => {
		const policy = {
			protocol: "sense-ops-sc085-issued-policy/1",
			intent: { label: "café 😀", validity: { expiresWallMs: workloadEnd } },
			bootstrap: ["accounting", "native-receive"],
			cleanupReserveMs: 900_000,
			repository_id: "1351928206",
			operational_prelaunch: { phasePlan: { path: "/original/plan", sha256: "a".repeat(64) } },
			operational_permission: { namespace: "sense-operational-pi" },
		};
		const bytes = canonicalPilotDecision(policy);
		expect(parseCanonicalPilotDecision(bytes)).toEqual(policy);
		expect(bytes.toString("utf8")).toContain("café 😀");
		// Python's existing ASCII canonical verification digest is a separate
		// domain. Alternate escape spelling is not a valid raw Pilot document.
		const asciiEscaped = Buffer.from(bytes.toString("utf8").replace("é", "\\u00e9"));
		expect(JSON.parse(asciiEscaped.toString("utf8"))).toEqual(policy);
		expect(() => parseCanonicalPilotDecision(asciiEscaped)).toThrow("PILOT_CANONICAL_JSON");
	});

	test.each([-1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])(
		"does not drop invalid numeric CI metadata %s before whole-policy receiving",
		(value) => {
			expect(() => canonicalPilotDecision({ operational_prelaunch: { value } })).toThrow(
				"PILOT_SAFE_INTEGER_REQUIRED",
			);
		},
	);
});

describe("original bootstrap window versus operational time checks", () => {
	test("bootstrap remains live only before the unchanged 300-second edge", () => {
		expect(() => assertOperationalAdmissionTime(authorization, allocation, clock(299_999))).not.toThrow();
		expect(() => assertOperationalAdmissionTime(authorization, allocation, clock(300_000))).toThrow(
			"OPS_ADMISSION_EXPIRED_OR_CLOCK_REGRESSION",
		);
	});

	test("a separately authenticated operational deadline does not rewrite the public authorization", () => {
		const original = structuredClone(authorization);
		for (const elapsed of [300_000, 600_000, 19_799_999]) {
			expect(() =>
				assertOperationalAdmissionTime(authorization, allocation, clock(elapsed), workloadEnd),
			).not.toThrow();
		}
		expect(authorization).toEqual(original);
		// Omission still means bootstrap, not a cached or inferred continuation.
		expect(() => assertOperationalAdmissionTime(authorization, allocation, clock(600_000))).toThrow();
	});

	test("neither an operational deadline nor allocation expiry can extend the other", () => {
		for (const [nativeEnd, planEnd] of [
			[900_000, 19_800_000],
			[21_600_000, 900_000],
			[21_600_000, 19_800_000],
		]) {
			const end = Math.min(nativeEnd, planEnd);
			expect(() =>
				assertOperationalAdmissionTime(
					authorization,
					{ ...allocation, expiresMs: start + nativeEnd },
					clock(end),
					start + planEnd,
				),
			).toThrow();
		}
	});

	test("continuation preserves wall and monotonic regression checks and the first baseline", () => {
		const observed = clock(900_000);
		for (const changed of [
			{ ...observed, lastWall: observed.now + 1 },
			{ ...observed, lastMono: observed.mono + 1 },
			{ ...observed, mono: observed.firstMono + 21_600_000 },
			{ ...observed, firstWall: observed.lastWall + 1 },
			{ ...observed, firstMono: observed.lastMono + 1 },
		]) {
			expect(() =>
				assertOperationalAdmissionTime(authorization, allocation, changed, allocation.expiresMs),
			).toThrow();
		}
	});

	test("continuation does not waive original issue time, allocation start, or bootstrap ceiling", () => {
		expect(() =>
			assertOperationalAdmissionTime(authorization, allocation, clock(-1), allocation.expiresMs),
		).toThrow();
		expect(() =>
			assertOperationalAdmissionTime(
				authorization,
				{ ...allocation, notBeforeMs: start + 900_001 },
				clock(900_000),
				allocation.expiresMs,
			),
		).toThrow();
		expect(() =>
			assertOperationalAdmissionTime(
				{ ...authorization, expires_at: authorization.issued_at + 601 },
				allocation,
				clock(900_000),
				allocation.expiresMs,
			),
		).toThrow();
	});

	test.each([Number.NaN, Number.POSITIVE_INFINITY, start + 0.5])(
		"rejects invalid continued deadline %s",
		(deadline) => {
			expect(() => assertOperationalAdmissionTime(authorization, allocation, clock(900_000), deadline)).toThrow();
		},
	);
});
