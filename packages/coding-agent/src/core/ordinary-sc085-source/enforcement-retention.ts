import assert from "node:assert/strict";
import type { OperationalBinding } from "./ci-authority.ts";
import { operationalEnforcementMethodRefs, parseOperationalEnforcementMethod } from "./enforcement-method.ts";
import type { RawRef } from "./fd-slot-expectation.ts";
import { sc085RetainedBytes } from "./sc085-admission.ts";

function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "OPS_ENFORCEMENT_OBJECT");
	assert.deepEqual(Object.keys(value).sort(), names.split(" ").sort(), "OPS_ENFORCEMENT_FIELDS");
}

/** Initial DATA mapping for the selected CAPTURED.enforcement edge. An outside
 * final reader must reuse this with the original initial envelope, not final data.
 * The enclosing original receiver authenticates CAPTURED and selects the SAME
 * initial envelope. This decoder never chooses an outer Ref from a final bundle.
 * It checks retained correspondence, not physical enforcement or qualification.
 * `records` is the already checked initial-envelope inventory (96 records/2 MiB),
 * not a caller's extra map of records obtained after the original initial capture.
 */
export function verifyOperationalEnforcementRetention(
	initial: Record<string, unknown>,
	release: Record<string, unknown>,
	binding: OperationalBinding,
	records: ReadonlyMap<string, RawRef>,
	retained: ReadonlyMap<string, Uint8Array>,
): { outer: RawRef; source: RawRef; capture: RawRef; reservation: RawRef } {
	const preflight = binding.fd_slot_bound;
	assert(preflight, "OPS_ENFORCEMENT_PREFLIGHT_REQUIRED");
	const seen = new Map<string, RawRef>();
	const bytes = (value: unknown): Buffer => {
		fields(value, "path sha256");
		assert(typeof value.path === "string" && typeof value.sha256 === "string", "OPS_ENFORCEMENT_REF");
		const ref = { path: value.path, sha256: value.sha256 };
		assert.deepEqual(records.get(ref.path), ref, "OPS_ENFORCEMENT_INITIAL_RECORD_REQUIRED");
		const prior = seen.get(ref.path);
		assert(!prior || prior.sha256 === ref.sha256, "OPS_ENFORCEMENT_REF_REBOUND");
		seen.set(ref.path, ref);
		return sc085RetainedBytes(ref, retained);
	};
	const record = (ref: unknown): Record<string, unknown> => {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(ref)));
		assert(value !== null && typeof value === "object" && !Array.isArray(value), "OPS_ENFORCEMENT_OBJECT");
		return value as Record<string, unknown>;
	};
	const link = record(release.issuanceLink);
	fields(link, "version kind reservation prelaunchPolicy capture finalPolicy authorizationId");
	assert(link.version === 1 && link.kind === "original-ci-operational-issuance-link", "OPS_ENFORCEMENT_ISSUANCE_LINK");
	assert.equal(link.authorizationId, release.authorizationId, "OPS_ENFORCEMENT_AUTHORIZATION_ID");
	assert.deepEqual(link.finalPolicy, binding.policy, "OPS_ENFORCEMENT_ISSUED_POLICY");
	const reservation = record(link.reservation);
	fields(
		reservation,
		"version kind binding manifest selectedRelease policy request phasePlan allocation resourceEpoch receiving manager clock",
	);
	assert(
		reservation.version === 1 && reservation.kind === "original-ci-operational-prelaunch",
		"OPS_ENFORCEMENT_RESERVATION",
	);
	assert.deepEqual(reservation.policy, link.prelaunchPolicy, "OPS_ENFORCEMENT_RESERVED_POLICY");
	assert.deepEqual(reservation.receiving, binding.native.receiving, "OPS_ENFORCEMENT_RECEIVING");
	const entry = record(release.entry);
	fields(
		entry,
		"version kind receiving reservation controllerSource selectedRelease child execution clock runId resourceEpoch allocation profileSha256 aggregate directory binding",
	);
	assert(entry.version === 1 && entry.kind === "original-ci-operational-entry", "OPS_ENFORCEMENT_ENTRY");
	assert.deepEqual(entry.reservation, link.reservation, "OPS_ENFORCEMENT_ENTRY_RESERVATION");
	assert.equal(entry.runId, initial.runId, "OPS_ENFORCEMENT_ENTRY_RUN");
	assert.equal(entry.profileSha256, initial.profileSha256, "OPS_ENFORCEMENT_ENTRY_PROFILE");
	assert.deepEqual(entry.aggregate, initial.aggregate, "OPS_ENFORCEMENT_ENTRY_AGGREGATE");
	for (const key of ["receiving", "clock", "allocation", "resourceEpoch", "selectedRelease", "binding"])
		assert.deepEqual(entry[key], reservation[key], "OPS_ENFORCEMENT_ENTRY_SELECTION");
	const capture = record(link.capture);
	fields(
		capture,
		"version kind reservation controller child aggregate host capture initialRecords otherRecords capturedNs enforcement",
	);
	assert(capture.version === 1 && capture.kind === "original-ci-preexec-capture", "OPS_ENFORCEMENT_CAPTURE");
	assert.deepEqual(capture.reservation, link.reservation, "OPS_ENFORCEMENT_CAPTURE_RESERVATION");
	assert.deepEqual(capture.child, entry.child, "OPS_ENFORCEMENT_CAPTURE_CHILD");
	assert.deepEqual(capture.aggregate, preflight.scope, "OPS_ENFORCEMENT_CAPTURE_SCOPE");
	assert.deepEqual(capture.initialRecords, preflight.proofs, "OPS_ENFORCEMENT_CAPTURE_PROOFS");
	assert.deepEqual(
		capture.otherRecords,
		Object.fromEntries(Object.entries(preflight.otherResources).map(([name, value]) => [name, value.evidence])),
		"OPS_ENFORCEMENT_CAPTURE_RESOURCES",
	);
	fields(initial.preexec, "nofile initialFdAndTasks raw");
	assert.deepEqual(capture.capture, initial.preexec.raw, "OPS_ENFORCEMENT_CAPTURE_SNAPSHOT");
	fields(initial.original, "scope epoch enforcement initialFd");
	assert.deepEqual(capture.enforcement, initial.original.enforcement, "OPS_ENFORCEMENT_ORIGINAL_OUTER");
	assert.deepEqual(initial.original.scope, preflight.scope, "OPS_ENFORCEMENT_INITIAL_SCOPE");
	assert.deepEqual(initial.original.epoch, preflight.epoch, "OPS_ENFORCEMENT_INITIAL_EPOCH");
	const scope = record(preflight.scope);
	fields(scope, "version kind owner ownerEpoch aggregate subjects limits");
	assert(scope.version === 2 && scope.kind === "fd-slot-scope", "OPS_ENFORCEMENT_SCOPE_KIND");
	fields(scope.aggregate, "device inode");
	for (const value of [scope.aggregate.device, scope.aggregate.inode])
		assert(
			typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0),
			"OPS_ENFORCEMENT_AGGREGATE_INTEGER",
		);
	assert((scope.aggregate.inode as number) > 0, "OPS_ENFORCEMENT_AGGREGATE_INODE");
	assert.deepEqual(
		{ device: String(scope.aggregate.device), inode: String(scope.aggregate.inode) },
		entry.aggregate,
		"OPS_ENFORCEMENT_ORIGINAL_AGGREGATE",
	);
	const epoch = record(preflight.epoch);
	fields(epoch, "version kind scope owner ownerEpoch aggregate source");
	assert(epoch.version === 1 && epoch.kind === "fd-slot-epoch", "OPS_ENFORCEMENT_EPOCH_KIND");
	assert.deepEqual(epoch.scope, preflight.scope, "OPS_ENFORCEMENT_SCOPE");
	for (const key of ["owner", "ownerEpoch", "aggregate"])
		assert.deepEqual(epoch[key], scope[key], "OPS_ENFORCEMENT_EPOCH");
	const epochSource = record(epoch.source);
	assert.deepEqual(epochSource.owner, scope.owner, "OPS_ENFORCEMENT_SOURCE_OWNER");
	assert.deepEqual(epochSource.limits, scope.limits, "OPS_ENFORCEMENT_SOURCE_LIMITS");
	assert.equal(epochSource.resourceEpoch, initial.resourceEpoch, "OPS_ENFORCEMENT_RESOURCE_EPOCH");
	assert.equal(scope.ownerEpoch, initial.resourceEpoch, "OPS_ENFORCEMENT_OWNER_EPOCH");
	assert.deepEqual(
		epochSource.allocation,
		{ id: initial.allocationId, session: initial.sessionId },
		"OPS_ENFORCEMENT_ALLOCATION",
	);
	assert.deepEqual(epochSource.allocation, reservation.allocation, "OPS_ENFORCEMENT_RESERVED_ALLOCATION");
	assert.equal(epochSource.resourceEpoch, reservation.resourceEpoch, "OPS_ENFORCEMENT_RESERVED_EPOCH");

	const outer = record(initial.original.enforcement);
	fields(outer, "kind binding lifetime conditions otherResources source");
	assert(outer.kind === "original-immutable-resource-enforcement-tenure/1", "OPS_ENFORCEMENT_OUTER_KIND");
	assert.deepEqual(
		outer.binding,
		{
			scope: preflight.scope,
			epoch: preflight.epoch,
			owner: scope.owner,
			ownerEpoch: scope.ownerEpoch,
			aggregate: scope.aggregate,
		},
		"OPS_ENFORCEMENT_OUTER_BINDING",
	);
	assert.equal(outer.lifetime, "original-preexec-through-owner-release", "OPS_ENFORCEMENT_LIFETIME");
	assert.deepEqual(outer.conditions, preflight.proofs, "OPS_ENFORCEMENT_CONDITIONS");
	assert.deepEqual(outer.otherResources, preflight.otherResources, "OPS_ENFORCEMENT_OTHER_RESOURCES");
	const runtime = record(outer.source);
	fields(
		runtime,
		"version kind owner qualificationAuthority qualification source binding allocation resourceEpoch subject limits mechanisms validity guardRules",
	);
	assert(
		runtime.version === 1 && runtime.kind === "original-ci-operational-enforcement-source/1",
		"OPS_ENFORCEMENT_SOURCE_KIND",
	);
	const method = parseOperationalEnforcementMethod(epochSource.enforcementMethod);
	for (const key of Object.keys(method) as (keyof typeof method)[])
		assert.deepEqual(runtime[key], method[key], "OPS_ENFORCEMENT_SELECTED_METHOD");
	for (const ref of operationalEnforcementMethodRefs(method)) {
		assert.notEqual(ref.path, (epoch.source as RawRef).path, "OPS_ENFORCEMENT_METHOD_CYCLE");
		bytes(ref);
	}
	assert.deepEqual(runtime.owner, scope.owner, "OPS_ENFORCEMENT_RUNTIME_OWNER");
	assert.deepEqual(runtime.binding, preflight.scope, "OPS_ENFORCEMENT_RUNTIME_SCOPE");
	assert.deepEqual(runtime.allocation, epochSource.allocation, "OPS_ENFORCEMENT_RUNTIME_ALLOCATION");
	assert.equal(runtime.resourceEpoch, initial.resourceEpoch, "OPS_ENFORCEMENT_RUNTIME_EPOCH");
	assert.deepEqual(runtime.limits, scope.limits, "OPS_ENFORCEMENT_RUNTIME_LIMITS");
	fields(runtime.subject, "kind pid startTicks");
	fields(initial.launcher, "pid startTicks executableSha256 argvSha256");
	assert(
		typeof initial.launcher.pid === "number" &&
			Number.isSafeInteger(initial.launcher.pid) &&
			initial.launcher.pid > 0 &&
			typeof initial.launcher.startTicks === "string" &&
			/^[1-9][0-9]{0,19}$/.test(initial.launcher.startTicks),
		"OPS_ENFORCEMENT_ORIGINAL_CHILD",
	);
	const child = { pid: String(initial.launcher.pid), startTicks: initial.launcher.startTicks };
	assert.deepEqual(capture.child, child, "OPS_ENFORCEMENT_INITIAL_CHILD");
	const snapshot = record(capture.capture);
	assert.equal(snapshot.kind, "original-same-pid-preexec-capture/1", "OPS_ENFORCEMENT_SNAPSHOT_KIND");
	assert.deepEqual(
		snapshot.launcher,
		{ pid: initial.launcher.pid, startTicks: child.startTicks },
		"OPS_ENFORCEMENT_SNAPSHOT_CHILD",
	);
	assert.deepEqual(initial.preexec.nofile, snapshot.nofile, "OPS_ENFORCEMENT_SNAPSHOT_NOFILE");
	assert.deepEqual(
		runtime.subject,
		{ kind: "original-preexec-through-owner-release/1", ...child },
		"OPS_ENFORCEMENT_RUNTIME_SUBJECT",
	);
	fields(runtime.validity, "startNs endNs");
	assert(
		reservation.clock &&
			typeof reservation.clock === "object" &&
			"startedNs" in reservation.clock &&
			"managerDeadlineNs" in reservation.clock &&
			"captureReleaseDeadlineNs" in reservation.clock,
		"OPS_ENFORCEMENT_ORIGINAL_CLOCK",
	);
	const interval = [
		runtime.validity.startNs,
		reservation.clock.startedNs,
		reservation.clock.captureReleaseDeadlineNs,
		runtime.validity.endNs,
	];
	for (const edge of [...interval, reservation.clock.managerDeadlineNs, capture.capturedNs])
		assert(typeof edge === "string" && /^(0|[1-9][0-9]{0,19})$/.test(edge), "OPS_ENFORCEMENT_VALIDITY");
	const [start, originalStart, originalEnd, end] = interval.map((edge) => BigInt(edge as string));
	assert(start <= originalStart && originalStart < originalEnd && originalEnd <= end, "OPS_ENFORCEMENT_VALIDITY");
	assert(
		originalStart <= BigInt(capture.capturedNs as string) &&
			BigInt(capture.capturedNs as string) < BigInt(reservation.clock.managerDeadlineNs as string),
		"OPS_ENFORCEMENT_CAPTURE_DEADLINE",
	);
	fields(runtime.guardRules, "kind invariants source");
	assert(
		runtime.guardRules.kind === "original-ci-enforcement-guards/1" &&
			Array.isArray(runtime.guardRules.invariants) &&
			runtime.guardRules.invariants.length > 0,
		"OPS_ENFORCEMENT_GUARDS",
	);
	assert(Array.isArray(runtime.mechanisms) && runtime.mechanisms.length > 0, "OPS_ENFORCEMENT_MECHANISMS");
	// Explicit edges only. Evidence may be source/artifact bytes, not JSON. The
	// original initial inventory already enforces count and aggregate byte caps.
	for (const ref of [
		runtime.qualificationAuthority,
		runtime.qualification,
		runtime.source,
		...runtime.mechanisms,
		runtime.guardRules.source,
	])
		bytes(ref);
	for (const ref of seen.values()) sc085RetainedBytes(ref, retained);
	return {
		outer: { ...records.get((initial.original.enforcement as RawRef).path)! },
		source: { ...records.get((outer.source as RawRef).path)! },
		capture: { ...records.get((link.capture as RawRef).path)! },
		reservation: { ...records.get((link.reservation as RawRef).path)! },
	};
}
