import assert from "node:assert/strict";
import { isAbsolute, normalize } from "node:path";
import type { IndependentlyAdmittedFdSlotExpectation, RawRef } from "./fd-slot-expectation.ts";
import type { receiveOperationalFinalGraphData } from "./references/sense/outside-final/operational-staging.ts";
import type { OperationalFinalTailAdmission, OperationalSourceAccountingInput } from "./source-contracts.ts";

export function outsideFields(value: unknown, names: string): asserts value is Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "OPS_OUTSIDE_FIELDS");
	assert.deepEqual(Object.keys(value).sort(), names.split(" ").sort(), "OPS_OUTSIDE_FIELDS");
}
export function outsideRef(value: unknown): asserts value is RawRef {
	outsideFields(value, "path sha256");
	assert(
		typeof value.path === "string" &&
			isAbsolute(value.path) &&
			normalize(value.path) === value.path &&
			value.path !== "/" &&
			value.path.length <= 4096 &&
			!/[\u0000-\u001f\u007f]/.test(value.path) &&
			typeof value.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(value.sha256),
		"OPS_OUTSIDE_REF",
	);
}
export function outsideNs(value: unknown): bigint {
	assert(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value), "OPS_OUTSIDE_NS");
	return BigInt(value);
}
export interface OriginalOutsideStagedData {
	owner: { staged: RawRef; owner: RawRef; ownerEpoch: string; binding: RawRef };
	terminal: RawRef | null;
	billing: { status: "unknown"; basis: null } | { status: "data"; basis: RawRef };
	admission: OperationalFinalTailAdmission;
	status: "pending-finalization" | "failed";
	failures: RawRef[];
	refusals: string[];
	award: null;
}
export interface OriginalOutsideClockCoverage {
	basis: RawRef;
	query: { beforeNs: string; afterNs: string };
	before: RawRef;
	after: RawRef;
	head: RawRef;
}
/** Exactly Resource's actual seven-key return; never reconstructed from tails. */
export interface OriginalOutsideFinalResult {
	final: IndependentlyAdmittedFdSlotExpectation;
	finalRef: RawRef;
	window: RawRef;
	retirement: RawRef;
	release: RawRef;
	clockCoverage: OriginalOutsideClockCoverage;
	releaseClockCoverage: OriginalOutsideClockCoverage;
}
/** Detached DATA, not another persisted carrier, grant or qualification award. */
export interface OriginalOutsideGraphSelection {
	initial: { authorization: RawRef };
	final: RawRef;
	owner: RawRef;
	ownerEpoch: string;
	epochSource: RawRef;
	limits: RawRef;
	aggregate: { device: number; inode: number };
	clockBasis: RawRef;
}
export interface OriginalOutsideTerminalSelection {
	owner: RawRef;
	ownerEpoch: string;
	binding: RawRef;
	clockBasis: RawRef;
	clockContract: RawRef;
	startedNs: string;
	captureReleaseDeadlineNs: string;
}
export interface OriginalOutsideFinalData {
	kind: "original-outside-final-data";
	graph: OriginalOutsideGraphSelection;
	sense: ReturnType<typeof receiveOperationalFinalGraphData>;
	call: RawRef;
	returned: RawRef;
	staged: OriginalOutsideStagedData;
	result: OriginalOutsideFinalResult;
	award: null;
}
export interface OutsideRecords {
	bytes(ref: RawRef): Uint8Array;
	record(ref: unknown): Record<string, unknown>;
}

/** Pure mapping; only the prebound original-root receiver supplies selection.
 * A stdout offer does not choose the owner, workload, recorder or billing. */
export function decodeOutsideStaged(
	stage: RawRef,
	admission: OperationalFinalTailAdmission,
	accounting: OperationalSourceAccountingInput,
	records: OutsideRecords,
): OriginalOutsideStagedData {
	const value = records.record(stage);
	outsideFields(value, "protocol status admission terminalSource phases failures");
	assert(
		value.protocol === "sense-ops-final-tail/1" &&
			(value.status === "pending-finalization" || value.status === "failed"),
		"OPS_OUTSIDE_STAGE_STATUS",
	);
	assert.deepEqual(value.admission, admission, "OPS_OUTSIDE_STAGE_ADMISSION");
	assert.deepEqual(admission.owner, accounting.owner, "OPS_OUTSIDE_SOURCE_OWNER");
	assert.equal(admission.ownerEpoch, accounting.ownerEpoch, "OPS_OUTSIDE_SOURCE_EPOCH");
	assert(Array.isArray(value.phases) && Array.isArray(value.failures), "OPS_OUTSIDE_STAGE_COLLECTION");
	const phases = value.phases.map((row: unknown) => {
		outsideFields(row, "phase raw");
		const phase = records.record(row.raw);
		assert(
			phase.kind === "phase-report" &&
				phase.value &&
				typeof phase.value === "object" &&
				"phase" in phase.value &&
				phase.value.phase === row.phase,
			"OPS_OUTSIDE_PHASE_BODY",
		);
		return row.phase;
	});
	for (const ref of value.failures) {
		outsideRef(ref);
		records.bytes(ref);
	}
	if (value.status === "pending-finalization") {
		assert.deepEqual(value.failures, [], "OPS_OUTSIDE_STAGE_FAILURE");
		assert.deepEqual(phases, ["context", "quiet", "burst", "soak"], "OPS_OUTSIDE_STAGE_PHASES");
	}
	for (const ref of [
		accounting.owner,
		accounting.binding,
		accounting.observer,
		admission.admission,
		admission.initial,
		admission.limits,
		admission.survivor,
	]) {
		outsideRef(ref);
		records.bytes(ref);
	}
	const result: OriginalOutsideStagedData = {
		owner: { staged: stage, owner: accounting.owner, ownerEpoch: accounting.ownerEpoch, binding: accounting.binding },
		terminal: null,
		billing: { status: "unknown", basis: null },
		admission,
		status: value.status,
		failures: value.failures as RawRef[],
		refusals: value.status === "failed" ? ["OPS_OUTSIDE_STAGE_FAILED"] : [],
		award: null,
	};
	if (value.terminalSource === null) {
		assert.equal(value.status, "failed", "OPS_OUTSIDE_TERMINAL_MISSING");
		result.refusals.push("OPS_OUTSIDE_TERMINAL_MISSING", "OPS_OUTSIDE_BILLING_UNKNOWN");
		return structuredClone(result);
	}
	outsideRef(value.terminalSource);
	result.terminal = value.terminalSource;
	const terminal = records.record(value.terminalSource),
		counters = ["invocations", "attemptedReads", "completedReads", "writerReadbacks", "billedRequests"];
	outsideFields(
		terminal,
		`protocol owner ownerEpoch binding window coverage sourceRequestsMetric sourceCost currency closure failures ${counters.join(" ")}${"sourceBilling" in terminal ? " sourceBilling" : ""}`,
	);
	assert(
		terminal.protocol === "sense-ops-terminal-source/1" && terminal.sourceRequestsMetric === "completed-source-reads",
		"OPS_OUTSIDE_TERMINAL_KIND",
	);
	for (const key of ["owner", "ownerEpoch", "binding"] as const)
		assert.deepEqual(terminal[key], accounting[key], "OPS_OUTSIDE_TERMINAL_SOURCE");
	outsideFields(terminal.closure, "outcome raw");
	records.record(terminal.closure.raw);
	assert(
		["closed", "failed", "unknown"].includes(String(terminal.closure.outcome)) && Array.isArray(terminal.failures),
		"OPS_OUTSIDE_TERMINAL_CLOSURE",
	);
	for (const ref of terminal.failures) {
		outsideRef(ref);
		records.bytes(ref);
	}
	if (terminal.closure.outcome !== "closed" || terminal.failures.length)
		result.refusals.push("OPS_OUTSIDE_TERMINAL_UNCLOSED");
	const coverage = records.record(terminal.coverage);
	outsideFields(
		coverage,
		"kind selected nativeEpoch window pending outstandingReadbacks ambiguousObserver ambiguousWriter closure",
	);
	assert.equal(coverage.kind, "ops-source-accounting-coverage", "OPS_OUTSIDE_SOURCE_COVERAGE");
	outsideFields(coverage.selected, "binding owner ownerEpoch observer target watches");
	const observedSelection = coverage.selected;
	for (const key of ["binding", "owner", "ownerEpoch", "target", "watches"] as const)
		assert.deepEqual(observedSelection[key], accounting[key], "OPS_OUTSIDE_SELECTED_ACCOUNTING");
	// The original host copies the selected observer with recorder.bytes before
	// constructing accounting. Compare its actual retained bytes, not its new key.
	outsideRef(observedSelection.observer);
	assert.equal(observedSelection.observer.sha256, accounting.observer.sha256, "OPS_OUTSIDE_OBSERVER_PIN");
	assert.deepEqual(
		records.bytes(observedSelection.observer),
		records.bytes(accounting.observer),
		"OPS_OUTSIDE_OBSERVER_BYTES",
	);
	assert.deepEqual(coverage.window, terminal.window, "OPS_OUTSIDE_SOURCE_WINDOW");
	assert.deepEqual(coverage.closure, terminal.closure.raw, "OPS_OUTSIDE_SOURCE_CLOSURE");
	if (
		!(
			coverage.pending === 0 &&
			coverage.outstandingReadbacks === 0 &&
			coverage.ambiguousObserver === false &&
			coverage.ambiguousWriter === false &&
			typeof coverage.nativeEpoch === "string" &&
			coverage.nativeEpoch.length > 0
		)
	)
		result.refusals.push("OPS_OUTSIDE_SOURCE_UNKNOWN");
	outsideFields(terminal.window, "start end");
	for (const stamp of [terminal.window.start, terminal.window.end]) {
		assert(stamp && typeof stamp === "object" && !Array.isArray(stamp), "OPS_OUTSIDE_STAMP");
		const row = stamp as Record<string, unknown>;
		for (const key of ["raw", "basis", "guard", "original", "qualification"])
			if (key in row) records.record(row[key]);
		if (!("monotonicNs" in row && "uncertaintyNs" in row)) result.refusals.push("OPS_OUTSIDE_CLOCK_UNQUALIFIED");
	}
	for (const name of [...counters, "sourceCost"]) {
		const fact = terminal[name];
		outsideFields(fact, "value raw unknown");
		records.record(fact.raw);
		if (fact.value === null) {
			assert(typeof fact.unknown === "string" && fact.unknown.length > 0, "OPS_OUTSIDE_TERMINAL_UNKNOWN_SHAPE");
			result.refusals.push(`OPS_OUTSIDE_TERMINAL_UNKNOWN:${name}`);
		} else
			assert(
				typeof fact.value === "number" &&
					Number.isFinite(fact.value) &&
					fact.value >= 0 &&
					fact.unknown === null &&
					(name === "sourceCost" || Number.isSafeInteger(fact.value)),
				"OPS_OUTSIDE_TERMINAL_FACT",
			);
	}
	if ("sourceBilling" in terminal) {
		const billing = terminal.sourceBilling;
		outsideFields(billing, "kind basis currency excludes");
		assert(
			billing.kind === "unbilled-local-source" &&
				billing.currency === "not-applicable" &&
				terminal.currency === null,
			"OPS_OUTSIDE_BILLING_KIND",
		);
		assert.deepEqual(billing.excludes, ["compute", "model"], "OPS_OUTSIDE_BILLING_SCOPE");
		outsideRef(billing.basis);
		records.record(billing.basis);
		assert(
			(terminal.sourceCost as Record<string, unknown>).value === 0 &&
				(terminal.billedRequests as Record<string, unknown>).value === 0,
			"OPS_OUTSIDE_BILLING_DISAGREEMENT",
		);
		result.billing = { status: "data", basis: billing.basis };
	} else result.refusals.push("OPS_OUTSIDE_BILLING_UNKNOWN");
	return structuredClone(result);
}

export function decodeOutsideFinal(
	callRef: RawRef,
	returnedRef: RawRef,
	expected: {
		reservation: RawRef;
		graph: Omit<OriginalOutsideGraphSelection, "final">;
		selectedRelease: unknown;
		capture: Record<string, unknown>;
		preflight: Record<string, unknown>;
		enforcement: RawRef;
		host: RawRef;
		conditions: Record<string, RawRef>;
		staged: OriginalOutsideStagedData;
		directory: string;
	},
	records: OutsideRecords,
): Omit<OriginalOutsideFinalData, "sense"> {
	assert(
		!expected.staged.refusals.length && expected.staged.billing.status === "data" && expected.staged.terminal,
		"OPS_OUTSIDE_FINAL_STAGED_REFUSED",
	);
	const call = records.record(callRef),
		returned = records.record(returnedRef);
	outsideFields(
		call,
		"version kind reservation selectedRelease initial child host enforcement conditions terminal owner billing outputs",
	);
	outsideFields(returned, "version kind call reservation result");
	assert(
		call.version === 1 &&
			call.kind === "original-ci-operational-final-call/1" &&
			returned.version === 1 &&
			returned.kind === "original-ci-operational-final-return/1",
		"OPS_OUTSIDE_FINAL_KIND",
	);
	assert.equal(callRef.path, `${expected.directory}/fd-slot-final-call.json`, "OPS_OUTSIDE_FINAL_CALL_PATH");
	assert.equal(returnedRef.path, `${expected.directory}/fd-slot-final-return.json`, "OPS_OUTSIDE_FINAL_RETURN_PATH");
	assert.deepEqual(returned.call, callRef, "OPS_OUTSIDE_ACTUAL_CALL");
	for (const record of [call, returned])
		assert.deepEqual(record.reservation, expected.reservation, "OPS_OUTSIDE_FINAL_RESERVATION");
	assert.deepEqual(call.selectedRelease, expected.selectedRelease, "OPS_OUTSIDE_FINAL_RELEASE");
	assert.deepEqual(
		call.initial,
		{ capture: expected.capture, preflight: expected.preflight },
		"OPS_OUTSIDE_FINAL_INITIAL",
	);
	outsideFields(call.child, "pid startTicks unit invocationId");
	assert.deepEqual(
		{ pid: call.child.pid, startTicks: call.child.startTicks },
		expected.capture.child,
		"OPS_OUTSIDE_FINAL_CHILD",
	);
	assert.deepEqual(call.enforcement, expected.enforcement, "OPS_OUTSIDE_FINAL_ENFORCEMENT");
	assert.deepEqual(call.host, expected.host, "OPS_OUTSIDE_FINAL_HOST");
	assert.deepEqual(call.conditions, expected.conditions, "OPS_OUTSIDE_FINAL_CONDITIONS");
	assert.deepEqual(
		call.outputs,
		[
			"fd-slot-window",
			"fd-slot-final-snapshot",
			"fd-slot-release",
			"fd-slot-retirement",
			"fd-slot-uninterruptedBoundaryCustody",
			"fd-slot-retirementTail",
			"fd-slot-expectation",
		].map((name) => `${expected.directory}/${name}.json`),
		"OPS_OUTSIDE_FINAL_OUTPUTS",
	);
	assert.deepEqual(call.owner, expected.staged.owner, "OPS_OUTSIDE_FINAL_OWNER");
	assert.deepEqual(call.terminal, expected.staged.terminal, "OPS_OUTSIDE_FINAL_TERMINAL");
	assert.deepEqual(call.billing, expected.staged.billing.basis, "OPS_OUTSIDE_FINAL_BILLING");
	records.record(call.host);
	records.record(call.enforcement);
	assert(
		call.conditions && typeof call.conditions === "object" && !Array.isArray(call.conditions),
		"OPS_OUTSIDE_FINAL_CONDITIONS",
	);
	for (const ref of Object.values(call.conditions)) records.record(ref);
	const result = returned.result;
	outsideFields(result, "final finalRef window retirement release clockCoverage releaseClockCoverage");
	outsideRef(result.finalRef);
	assert.equal(result.finalRef.path, `${expected.directory}/fd-slot-expectation.json`, "OPS_OUTSIDE_FINAL_PATH");
	assert.deepEqual(records.record(result.finalRef), result.final, "OPS_OUTSIDE_ACTUAL_FINAL_BYTES");
	const final = result.final;
	outsideFields(
		final,
		"version kind quantity semantics N T budget scope epoch proofs otherResources wholeWindow retirement",
	);
	assert(final.version === 1 && final.kind === "enforced-live-fd-slots", "OPS_OUTSIDE_FINAL_EXPECTATION");
	for (const key of ["quantity", "semantics", "N", "T", "budget", "scope", "epoch", "otherResources"])
		assert.deepEqual(final[key], expected.preflight[key], "OPS_OUTSIDE_FINAL_PREFLIGHT");
	outsideFields(
		final.proofs,
		"inheritedHardLimit initialFdRoster aggregateTasksMembership noForeignTableSharers noMigrationOrEscape noLimitRaiseOrExternalMutation targetAllocationSemantics uninterruptedBoundaryCustody retirementTail",
	);
	const initialProofs = expected.preflight.proofs;
	assert(initialProofs && typeof initialProofs === "object", "OPS_OUTSIDE_INITIAL_PROOFS");
	for (const [key, reference] of Object.entries(initialProofs))
		assert.deepEqual(final.proofs[key], reference, "OPS_OUTSIDE_FINAL_INITIAL_PROOF");
	for (const reference of Object.values(final.proofs)) records.record(reference);
	assert.deepEqual(result.window, final.wholeWindow, "OPS_OUTSIDE_ACTUAL_WINDOW");
	assert.deepEqual(result.retirement, final.retirement, "OPS_OUTSIDE_ACTUAL_RETIREMENT");
	const window = records.record(result.window),
		retirement = records.record(result.retirement),
		release = records.record(result.release);
	outsideFields(window, "version kind binding startNs endNs clockCoverage");
	outsideFields(
		retirement,
		"version kind binding wholeWindow retiredAt snapshotAt releasedAt descendantReceipt finalSnapshot releaseReceipt",
	);
	outsideFields(release, "version kind binding outcome aggregate releasedNs");
	assert(
		window.version === 1 &&
			window.kind === "fd-slot-window" &&
			retirement.version === 1 &&
			retirement.kind === "fd-slot-retirement" &&
			release.version === 1 &&
			release.kind === "original-ci-resource-release/1" &&
			release.outcome === "released",
		"OPS_OUTSIDE_RETIREMENT_UNKNOWN",
	);
	const initialCondition = records.record((initialProofs as Record<string, unknown>).initialFdRoster);
	for (const row of [window, retirement, release])
		assert.deepEqual(row.binding, final.scope, "OPS_OUTSIDE_FINAL_SCOPE");
	assert.deepEqual(retirement.wholeWindow, result.window, "OPS_OUTSIDE_RETIREMENT_WINDOW");
	assert.deepEqual(retirement.releaseReceipt, result.release, "OPS_OUTSIDE_ACTUAL_RELEASE");
	outsideFields(retirement.descendantReceipt, "unit invocationId group retiredNs");
	assert.equal(retirement.descendantReceipt.unit, call.child.unit, "OPS_OUTSIDE_ORIGINAL_RETIRED_UNIT");
	assert.equal(
		retirement.descendantReceipt.invocationId,
		call.child.invocationId,
		"OPS_OUTSIDE_ORIGINAL_RETIRED_INVOCATION",
	);
	assert.equal(retirement.descendantReceipt.retiredNs, retirement.retiredAt, "OPS_OUTSIDE_ORIGINAL_RETIRED_AT");
	const snapshot = records.record(retirement.finalSnapshot);
	assert(
		outsideNs(window.startNs) <= outsideNs(retirement.retiredAt) &&
			outsideNs(retirement.retiredAt) <= outsideNs(snapshot.started_monotonic_ns) &&
			outsideNs(snapshot.started_monotonic_ns) <= outsideNs(snapshot.finished_monotonic_ns) &&
			outsideNs(snapshot.finished_monotonic_ns) <= outsideNs(release.releasedNs) &&
			outsideNs(release.releasedNs) <= outsideNs(retirement.releasedAt),
		"OPS_OUTSIDE_FINAL_ORDER",
	);
	assert.equal(window.endNs, snapshot.finished_monotonic_ns, "OPS_OUTSIDE_FINAL_WINDOW_END");
	assert.equal(retirement.snapshotAt, window.endNs, "OPS_OUTSIDE_FINAL_SNAPSHOT_AT");
	outsideFields(initialCondition.initialAt, "clockId monotonicMs wallMs uncertaintyMs raw");
	const initialAt = initialCondition.initialAt;
	const basis = records.record(initialAt.raw);
	const common = "binding allocation resourceEpoch contract adapter boot timeNamespace clockId";
	outsideFields(basis, `version kind ${common} calibration validity uncertainty`);
	assert(basis.version === 1 && basis.kind === "original-ci-clock-initial-basis", "OPS_OUTSIDE_CLOCK_BASIS");
	assert.deepEqual(basis.binding, initialCondition.binding, "OPS_OUTSIDE_CLOCK_BINDING");
	const contract = records.record(basis.contract);
	for (const key of ["source", "qualificationAuthority", "qualification"]) {
		outsideRef(contract[key]);
		records.bytes(contract[key]);
	}
	for (const [key, edges] of [
		["platform", ["raw"]],
		["adapter", ["producer", "implementation"]],
		["acquisition", ["method", "evidence"]],
		["reference", ["source"]],
		["guardRules", ["source"]],
	] as const) {
		const object = contract[key];
		assert(object && typeof object === "object" && !Array.isArray(object), "OPS_OUTSIDE_CLOCK_SOURCE");
		for (const edge of edges) {
			const ref = (object as Record<string, unknown>)[edge];
			outsideRef(ref);
			records.bytes(ref);
		}
	}
	const coverage = (value: unknown, before: unknown, after: unknown) => {
		outsideFields(value, "basis query before after head");
		assert.deepEqual(value.basis, initialAt.raw, "OPS_OUTSIDE_ORIGINAL_CLOCK_BASIS");
		assert.deepEqual(value.query, { beforeNs: before, afterNs: after }, "OPS_OUTSIDE_FINAL_CLOCK_QUERY");
		for (const key of ["basis", "before", "after", "head"]) outsideRef(value[key]);
		let cursor = value.head as RawRef,
			sequence: bigint | undefined;
		const chain = new Map<string, RawRef>();
		for (;;) {
			assert(!chain.has(cursor.path), "OPS_OUTSIDE_CLOCK_CYCLE");
			chain.set(cursor.path, cursor);
			const node = records.record(cursor),
				isBasis = cursor.path === (initialAt.raw as RawRef).path;
			if (isBasis) assert.deepEqual(cursor, initialAt.raw, "OPS_OUTSIDE_CLOCK_ORIGINAL_BASIS");
			else {
				outsideFields(node, `version kind ${common} sequence prior sample`);
				assert(node.version === 1 && node.kind === "original-ci-clock-guard", "OPS_OUTSIDE_CLOCK_GUARD");
				for (const key of common.split(" "))
					assert.deepEqual(node[key], basis[key], "OPS_OUTSIDE_CLOCK_ASSOCIATION");
			}
			const at = isBasis ? 0n : outsideNs(node.sequence);
			assert(sequence === undefined || at + 1n === sequence, "OPS_OUTSIDE_CLOCK_SEQUENCE");
			sequence = at;
			const sample = records.record(isBasis ? node.calibration : node.sample);
			outsideFields(
				sample,
				"version kind controller sequence errors monotonicBeforeNs monotonicAfterNs processBefore bootBefore timeNamespaceBefore clocksourceBefore processAfter bootAfter timeNamespaceAfter clocksourceAfter rawNs realtimeNs boottimeNs",
			);
			assert(
				sample.version === 1 && sample.kind === "original-ci-clock-sample" && outsideNs(sample.sequence) === at,
				"OPS_OUTSIDE_CLOCK_SAMPLE",
			);
			assert.deepEqual(sample.errors, [], "OPS_OUTSIDE_CLOCK_SAMPLE_FAILED");
			assert.deepEqual(sample.controller, expected.capture.controller, "OPS_OUTSIDE_CLOCK_CONTROLLER");
			assert(
				outsideNs(sample.monotonicBeforeNs) <= outsideNs(sample.monotonicAfterNs),
				"OPS_OUTSIDE_CLOCK_SAMPLE_ORDER",
			);
			if (isBasis) break;
			outsideRef(node.prior);
			cursor = node.prior;
		}
		for (const key of ["before", "after"]) {
			const ref = value[key] as RawRef;
			assert.deepEqual(chain.get(ref.path), ref, "OPS_OUTSIDE_CLOCK_COVERAGE_CHAIN");
		}
	};
	coverage(result.clockCoverage, snapshot.started_monotonic_ns, snapshot.finished_monotonic_ns);
	coverage(result.releaseClockCoverage, release.releasedNs, retirement.releasedAt);
	coverage(window.clockCoverage, window.startNs, window.endNs);
	for (const key of ["uninterruptedBoundaryCustody", "retirementTail"]) {
		const tail = records.record(final.proofs[key]);
		outsideFields(
			tail,
			"version kind binding name wholeWindow retirement coverageStart coverageEnd initialProofs otherResources finalSnapshot releaseReceipt releaseClockCoverage",
		);
		assert(tail.version === 1 && tail.kind === "fd-slot-condition" && tail.name === key, "OPS_OUTSIDE_TAIL_KIND");
		const tailJoins: Record<string, unknown> = {
			binding: final.scope,
			wholeWindow: result.window,
			retirement: result.retirement,
			initialProofs,
			otherResources: expected.preflight.otherResources,
			finalSnapshot: retirement.finalSnapshot,
			releaseReceipt: result.release,
			releaseClockCoverage: result.releaseClockCoverage,
			coverageStart: (result.window as RawRef).path,
			coverageEnd: (result.release as RawRef).path,
		};
		for (const [name, value] of Object.entries(tailJoins))
			assert.deepEqual(tail[name], value, "OPS_OUTSIDE_ACTUAL_TAIL_JOIN");
	}
	return structuredClone({
		kind: "original-outside-final-data",
		graph: { ...expected.graph, final: result.finalRef },
		call: callRef,
		returned: returnedRef,
		staged: expected.staged,
		result: result as unknown as OriginalOutsideFinalResult,
		award: null,
	});
}
