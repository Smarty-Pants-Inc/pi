import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type { RawRef } from "../src/core/ordinary-sc085-source/fd-slot-expectation.ts";
import { receiveOriginalFinalGraphData } from "../src/core/ordinary-sc085-source/references/sense/outside-final/measurement.ts";
import { receiveOperationalFinalGraphData } from "../src/core/ordinary-sc085-source/references/sense/outside-final/operational-staging.ts";

// UNRUN. Reuse Sense2468 tests/ops/measurement.test.ts's originalFinalGraphFixture
// (whole file SHA256 93ef9cf207ee33c9af0e185ecbaca2d6e0d31a2ceec8e23102fdb72dfadf4bf3).
// Only unused mutation callback removed and put's parameter narrowed to unknown;
// formatting/imports adapted for Pi. This deliberately incomplete physical DATA
// fixture cannot award native/clock/retirement or billing qualification.
function originalFinalGraphFixture() {
	const retained = new Map<string, Uint8Array>();
	const put = (name: string, value: unknown): RawRef => {
		const bytes = Buffer.from(JSON.stringify(value));
		const ref = { path: `/MOCK-final/${name}`, sha256: createHash("sha256").update(bytes).digest("hex") };
		retained.set(ref.path, bytes);
		return ref;
	};
	const owner = put("owner", { MOCK: true }),
		limits = put("limits", { MOCK: true });
	const names =
		"inheritedHardLimit initialFdRoster aggregateTasksMembership noForeignTableSharers noMigrationOrEscape noLimitRaiseOrExternalMutation targetAllocationSemantics".split(
			" ",
		);
	const initialConditions = Object.fromEntries(names.map((name) => [name, put(`source-${name}`, { MOCK: true })]));
	const epochSource = put("source", { owner, ownerEpoch: "MOCK-epoch", limits, initialConditions });
	const aggregate = { device: 1, inode: 2 };
	const scope = put("scope", {
		version: 2,
		kind: "fd-slot-scope",
		owner,
		ownerEpoch: "MOCK-epoch",
		aggregate,
		subjects: ["bun", "native", "observers"],
		limits,
	});
	const epoch = put("epoch", {
		version: 1,
		kind: "fd-slot-epoch",
		scope,
		owner,
		ownerEpoch: "MOCK-epoch",
		aggregate,
		source: epochSource,
	});
	const binding = { scope, epoch, owner, ownerEpoch: "MOCK-epoch", aggregate };
	const controller = { pid: "7", startTicks: "1", serviceUnit: "MOCK", invocationId: "MOCK" };
	const calibration = put("calibration", {
		version: 1,
		kind: "original-ci-clock-sample",
		sequence: "0",
		errors: [],
		controller,
		monotonicBeforeNs: "99",
		monotonicAfterNs: "100",
	});
	const common = {
		binding,
		resourceEpoch: "MOCK-epoch",
		clockId: "MOCK-clock",
		allocation: { id: "MOCK", session: "MOCK" },
		contract: limits,
		adapter: { producer: limits },
		boot: "MOCK",
		timeNamespace: { device: "0", inode: "1" },
	};
	const clockBasis = put("basis", { version: 1, kind: "original-ci-clock-initial-basis", ...common, calibration });
	const guard = (sequence: string, before: string, after: string, prior: RawRef) => {
		const sample = put(`sample-${sequence}`, {
			version: 1,
			kind: "original-ci-clock-sample",
			sequence,
			errors: [],
			controller,
			monotonicBeforeNs: before,
			monotonicAfterNs: after,
		});
		return put(`guard-${sequence}`, {
			version: 1,
			kind: "original-ci-clock-guard",
			...common,
			sequence,
			prior,
			sample,
		});
	};
	const initialAt = { clockId: "MOCK-clock", monotonicMs: 0.0001, wallMs: 1, uncertaintyMs: 0, raw: clockBasis };
	const proofs = Object.fromEntries(
		names.map((name) => [
			name,
			put(name, {
				version: 1,
				kind: "fd-slot-initial-condition",
				binding,
				initialAt,
				source: initialConditions[name],
				name,
				...(name === "inheritedHardLimit"
					? { soft: 4, hard: 4 }
					: name === "initialFdRoster"
						? { tasks: [], tables: [] }
						: name === "aggregateTasksMembership"
							? { ceiling: 2, initialTaskIds: ["7"] }
							: {}),
			}),
		]),
	);
	const quantities = {
		openFileDescriptions: "open-file-descriptions",
		queuedOrInFlightReferences: "queued-or-inflight-references",
		ioUringFixedFiles: "io-uring-fixed-files",
		logicalHandles: "runtime-logical-handles",
	};
	const otherResources = Object.fromEntries(
		Object.entries(quantities).map(([name, quantity]) => {
			const source = put(`other-source-${name}`, { MOCK: true });
			return [
				name,
				{
					kind: "admitted-exclusion",
					evidence: put(name, {
						version: 1,
						kind: "fd-slot-initial-other-resource",
						binding,
						initialAt,
						source,
						quantity,
						disposition: "admitted-exclusion",
						restriction: source,
					}),
				},
			];
		}),
	);
	const base = {
		quantity: "live-fd-table-slots",
		semantics: "CONSERVATIVE_UPPER_BOUND",
		N: 4,
		T: 2,
		budget: 8,
		scope,
		epoch,
		proofs,
		otherResources,
	};
	const initial = put("initial", { version: 2, kind: "admitted-live-fd-slot-preflight", ...base });
	const finalReadGuard = guard("1", "310", "320", clockBasis),
		releaseGuard = guard("2", "410", "420", finalReadGuard);
	const coverage = {
		basis: clockBasis,
		query: { beforeNs: "100", afterNs: "300" },
		before: clockBasis,
		after: finalReadGuard,
		head: finalReadGuard,
	};
	const releaseClockCoverage = {
		basis: clockBasis,
		query: { beforeNs: "350", afterNs: "400" },
		before: finalReadGuard,
		after: releaseGuard,
		head: releaseGuard,
	};
	const wholeWindow = put("window", {
		version: 1,
		kind: "fd-slot-window",
		binding: scope,
		startNs: "100",
		endNs: "300",
		clockCoverage: coverage,
	});
	const parent = { path: "/MOCK-parent", device: "1", inode: "2" };
	const finalSnapshot = put("snapshot", {
		aggregate: parent,
		started_monotonic_ns: "250",
		finished_monotonic_ns: "300",
	});
	const releaseReceipt = put("release", {
		version: 1,
		kind: "original-ci-resource-release/1",
		binding: scope,
		outcome: "released",
		aggregate: parent,
		releasedNs: "350",
	});
	const retirement = put("retirement", {
		version: 1,
		kind: "fd-slot-retirement",
		binding: scope,
		wholeWindow,
		retiredAt: "200",
		snapshotAt: "300",
		releasedAt: "400",
		descendantReceipt: { retiredNs: "200" },
		finalSnapshot,
		releaseReceipt,
	});
	const tails = Object.fromEntries(
		["uninterruptedBoundaryCustody", "retirementTail"].map((name) => [
			name,
			put(name, {
				version: 1,
				kind: "fd-slot-condition",
				binding: scope,
				name,
				wholeWindow,
				retirement,
				coverageStart: wholeWindow.path,
				coverageEnd: releaseReceipt.path,
				initialProofs: proofs,
				otherResources,
				finalSnapshot,
				releaseReceipt,
				releaseClockCoverage,
			}),
		]),
	);
	const final = put("final", {
		...base,
		version: 1,
		kind: "enforced-live-fd-slots",
		proofs: { ...proofs, ...tails },
		wholeWindow,
		retirement,
	});
	return {
		retained,
		put,
		selection: { initial, final, owner, ownerEpoch: "MOCK-epoch", epochSource, limits, aggregate, clockBasis },
	};
}

test("same composed Sense graph consumes original authorization projection and actual selected final bytes", () => {
	const f = originalFinalGraphFixture(),
		expected = receiveOriginalFinalGraphData(f.selection, f.retained);
	const preflight: unknown = JSON.parse(Buffer.from(f.retained.get(f.selection.initial.path)!).toString("utf8"));
	const authorization = f.put("authorization", {
		operational_binding: { version: 1, namespace: "sense-operational-pi", fd_slot_bound: preflight },
	});
	const selection = { ...f.selection, initial: { authorization } };
	f.retained.delete(f.selection.initial.path);
	const stage = f.put("stage", {
		protocol: "sense-ops-final-tail/1",
		status: "failed",
		admission: { owner: selection.owner, ownerEpoch: selection.ownerEpoch },
		terminalSource: null,
		failures: [f.put("failure", { possibleEffect: true })],
	});
	const value = receiveOperationalFinalGraphData(stage, selection, f);
	expect(value.graph).toEqual(expected);
	expect(value.graph.final).toEqual(selection.final);
	expect(value.graph.award).toBeNull();
	expect(value.graph.remaining).toContain("qualified-release-and-tail-coverage");
	expect(value.graph.remaining).toContain("terminal-source-and-independent-billing");
	expect(value.status).toBe("failed");
	expect(value.failures).toHaveLength(1);
	// A same-shaped undesignated record cannot replace the selected final edge.
	const original = f.retained.get(selection.final.path)!;
	f.retained.delete(selection.final.path);
	f.retained.set("/MOCK-undesignated-final", original);
	expect(() => receiveOperationalFinalGraphData(stage, selection, f)).toThrow("OPS_FINAL_GRAPH_BYTES");
});

test.each(["authorization", "final", "clockBasis"] as const)(
	"composed graph rejects changed selected %s bytes without fallback",
	(edge) => {
		const f = originalFinalGraphFixture();
		const preflight: unknown = JSON.parse(Buffer.from(f.retained.get(f.selection.initial.path)!).toString("utf8"));
		const authorization = f.put("authorization", {
			operational_binding: { version: 1, namespace: "sense-operational-pi", fd_slot_bound: preflight },
		});
		const selection = { ...f.selection, initial: { authorization } };
		f.retained.delete(f.selection.initial.path);
		const stage = f.put("stage", {
			protocol: "sense-ops-final-tail/1",
			status: "failed",
			admission: { owner: selection.owner, ownerEpoch: selection.ownerEpoch },
			terminalSource: null,
			failures: [],
		});
		f.retained.set((edge === "authorization" ? authorization : selection[edge]).path, Buffer.from("{}"));
		expect(() => receiveOperationalFinalGraphData(stage, selection, f)).toThrow("OPS_FINAL_GRAPH_BYTES");
	},
);
