import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { captureOrdinaryClockObservation, ordinaryClock, originalClockAssociation, originalClockInitialObservation } from "../ordinary-clock.ts";
import { OrdinaryOperationalAudit, type Sc085StampSelector } from "../ordinary-operational-audit.ts";
import { assertOrdinaryOwner, OrdinaryOwnerContext } from "../ordinary-owner-context.ts";
import {
	assertOriginalCINativeBinding,
	type OperationalBinding,
	type OriginalCIInitialProjection,
	type OriginalCISelection,
	type ReceivedCIData,
	receiveOriginalCIAuthorization,
} from "./ci-authority.ts";
import { type OriginalCIClockQuery, type ReceivedCIClock, retainOriginalCIClock } from "./ci-clock-receiving.ts";
import { readReleasedCISelection } from "./ci-released-selection.ts";
import { receiveClockParentAssociation, requireIndependentClockQualification } from "./clock-parent-association.ts";
import { receiveOriginalCompactionMethod } from "./compaction-selection.ts";
import { operationalEnforcementMethodRefs, type OperationalEnforcementMethod, parseOperationalEnforcementMethod } from "./enforcement-method.ts";
import { verifyOperationalEnforcementRetention } from "./enforcement-retention.ts";
import type { IndependentlyAdmittedFdSlotExpectation } from "./fd-slot-expectation.ts";
import type { IndependentlyAdmittedFdSlotPreflight } from "./fd-slot-preflight.ts";
import {
	canonicalSc085AuditClockQualification,
	joinSc085OriginalAssociation,
	parseSc085PreflightIntent,
	receiveSc085Admission,
	receiveSc085AuditClockQualification,
	receiveSc085PreflightIntent,
	type Sc085AdmissionV1,
	type Sc085AuditClockQualificationV2,
	type Sc085PreflightIntentV1,
	sc085RetainedBytes,
} from "./sc085-admission.ts";
import type {
	SourceOperationalInstruction as FoundationInstruction,
	HeldOperationalFile,
	SourceAdmissionPorts as OperationalHostProviders,
	OpsBinding as PreviousOpsBinding,
	Sc085Plan,
} from "./source-contracts.ts";

type OpsBinding = PreviousOpsBinding | "source-diagnostics";

import { parseOrdinaryOwnerReceiving, parseOrdinaryOwnerRecord } from "../ordinary-owner-policy.ts";
import { parseOwnerHostProfile } from "../owner-profile.ts";
import {
	canonicalPilotDecision,
	parseCanonicalPilotDecision,
} from "./references/sense/src/adapters/codex/pilot-canonical.ts";

type RawRef = FoundationInstruction["providerModule"];
const initialConditionNames = [
	"inheritedHardLimit",
	"initialFdRoster",
	"aggregateTasksMembership",
	"noForeignTableSharers",
	"noMigrationOrEscape",
	"noLimitRaiseOrExternalMutation",
	"targetAllocationSemantics",
] as const;
export interface OperationalEpochSource {
	version: 1;
	kind: "original-ci-operational-epoch-source";
	repositoryId: string;
	runId: string;
	attempt: string;
	controlSha: string;
	workflowSha: string;
	allocation: { id: string; session: string };
	resourceEpoch: string;
	owner: RawRef;
	ownerUid: string;
	ownerEpoch: string;
	limits: RawRef;
	receiving: RawRef;
	phasePlan: RawRef;
	clockContract: RawRef;
	host: RawRef;
	initialConditions: Record<(typeof initialConditionNames)[number], RawRef>;
	enforcementMethod: OperationalEnforcementMethod;
}
/** Closed DATA decoder only. Parent role/physical custody must additionally be
 * authenticated from the original selected declaration and graph, never inferred
 * from this document's owner Ref or its workload Host UID. */
export function parseOperationalEpochSource(raw: Uint8Array): OperationalEpochSource {
	const value = parseCanonicalPilotDecision(raw);
	fields(
		value,
		"version kind repositoryId runId attempt controlSha workflowSha allocation resourceEpoch owner ownerUid ownerEpoch limits receiving phasePlan clockContract initialConditions host enforcementMethod",
	);
	assert(value.version === 1 && value.kind === "original-ci-operational-epoch-source", "OPS_EPOCH_SOURCE_KIND");
	for (const key of ["repositoryId", "runId", "attempt"])
		assert(typeof value[key] === "string" && /^[1-9][0-9]{0,19}$/.test(value[key]), "OPS_EPOCH_SOURCE_TUPLE");
	for (const key of ["controlSha", "workflowSha"])
		assert(typeof value[key] === "string" && /^[a-f0-9]{40}$/.test(value[key]), "OPS_EPOCH_SOURCE_COMMIT");
	assert(
		typeof value.ownerUid === "string" &&
			/^[1-9][0-9]{0,19}$/.test(value.ownerUid) &&
			BigInt(value.ownerUid) <= 2147483647n,
		"OPS_EPOCH_SOURCE_HOST_UID",
	);
	assert(
		typeof value.resourceEpoch === "string" &&
			value.resourceEpoch.length > 0 &&
			[...value.resourceEpoch].length <= 256 &&
			![...value.resourceEpoch].some(
				(character) => /\s/u.test(character) || character.codePointAt(0)! < 32 || character === "\u007f",
			),
		"OPS_EPOCH_SOURCE_RESOURCE_EPOCH",
	);
	assert.equal(value.ownerEpoch, value.resourceEpoch, "OPS_EPOCH_SOURCE_PARENT_EPOCH");
	fields(value.allocation, "id session");
	assert(
		typeof value.allocation.id === "string" &&
			value.allocation.id.length > 0 &&
			[...value.allocation.id].length <= 256 &&
			![...value.allocation.id].some((character) => character.codePointAt(0)! < 32 || character === "\u007f"),
		"OPS_EPOCH_SOURCE_ALLOCATION",
	);
	assert.equal(
		value.allocation.session,
		`allocation-${createHash("sha256").update(value.allocation.id, "utf8").digest("hex")}`,
		"OPS_EPOCH_SOURCE_SESSION",
	);
	fields(value.initialConditions, initialConditionNames.join(" "));
	for (const ref of [
		value.owner,
		value.limits,
		value.receiving,
		value.phasePlan,
		value.clockContract,
		value.host,
		...Object.values(value.initialConditions),
	]) {
		fields(ref, "path sha256");
		assert(
			typeof ref.path === "string" &&
				ref.path.startsWith("/") &&
				ref.path.length <= 4096 &&
				!ref.path
					.split("/")
					.some(
						(part, index, parts) =>
							part === "." ||
							part === ".." ||
							(part === "" && index > 0 && !(parts.length === 2 && index === 1)),
					) &&
				![...ref.path].some((character) => character.codePointAt(0)! < 32) &&
				typeof ref.sha256 === "string" &&
				/^[a-f0-9]{64}$/.test(ref.sha256),
			"OPS_EPOCH_SOURCE_REF",
		);
	}
	parseOperationalEnforcementMethod(value.enforcementMethod);
	return structuredClone(value) as unknown as OperationalEpochSource;
}

export interface Sc085PreflightPlan {
	protocol: "sense-ops-sc085-plan/2";
	preflight: RawRef;
	finalExpectation: Sc085AdmissionV1["checkpoints"][0];
	failureExpectations: readonly Sc085AdmissionV1["checkpoints"][0][];
}
export type OperationalHostInstruction = Omit<FoundationInstruction, "sc085"> & {
	sc085?: FoundationInstruction["sc085"] | Sc085PreflightPlan;
};
type Operation = Parameters<OperationalHostProviders["admission"]["check"]>[0];
interface OriginalClockReceiving {
	query: OriginalCIClockQuery;
	recorder: OperationalHostProviders["recorder"];
	received?: ReceivedCIClock;
}
/** Existing93fa protected file handle, acquired by the trusted provider composition.
 * Caller retains/checks/closes these original handles; this supplier never reopens
 * these input paths, consumes a once instruction, issues or activates an allocation.
 * Initial receiving privately reads the existing readonly context/entry/release. */
export interface HeldOperationalRecord {
	readonly ref: RawRef;
	readonly held: HeldOperationalFile;
}
export interface OperationalAdmissionInputs {
	readonly producerContract: HeldOperationalRecord;
	readonly instruction: HeldOperationalRecord;
	readonly decision: HeldOperationalRecord;
	readonly receiving: HeldOperationalRecord;
	readonly profile: HeldOperationalRecord;
	readonly producers: ReadonlyMap<OpsBinding, HeldOperationalRecord>;
	readonly retained: OperationalHostProviders["recorder"]["retained"];
}
interface SelectedOperationalAdmissionInputs extends OperationalAdmissionInputs {
	readonly authority: OriginalCISelection;
}
// Explicit Source2 schema successor, NOT compatible with selected16-name f5ad.
// Exact reviewed17-name Core producerContract pin must be issued by original CI.
export const producerNames: readonly OpsBinding[] = Object.freeze([
	"artifact-grants",
	"clock",
	"native-turn-meter",
	"output-health-events",
	"sample-byte-meter",
	"whole-job-cpu",
	"source-billing",
	"pending-overlap-highwater",
	"resource-highwater",
	"operating-limits",
	"workload",
	"accepted-final-request",
	"matched-request-pair",
	"refresh-settlement",
	"soak-boundaries",
	"joined-retirement",
	"source-diagnostics",
] as const);
export const MISSING_OPERATIONAL_AUTHORITY = Object.freeze([
	"Byte inspection alone supplies no authority: original issued SC085 policy/qualification and the SAME original Pi permissionAbi1 context remain required",
]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function bytes(input: HeldOperationalRecord): Uint8Array {
	input.held.check();
	const raw = Buffer.from(input.held.bytes);
	assert(/^[a-f0-9]{64}$/.test(input.ref.sha256) && sha(raw) === input.ref.sha256, "OPS_ADMISSION_RECORD_PIN");
	input.held.check();
	return raw;
}
function instruction(raw: Uint8Array): OperationalHostInstruction {
	const input = parseCanonicalPilotDecision(raw) as OperationalHostInstruction;
	assert(
		input.version === 1 &&
			input.operation === "sense-operational-pi" &&
			typeof input.runId === "string" &&
			input.runId.length > 0 &&
			input.identity?.profile.harness === "pi",
		"OPS_ADMISSION_INSTRUCTION",
	);
	return input;
}
/** Concrete existing record/profile/receiving joins, never a grant. It deliberately
 * does not equate Sense source/runId with native source/admission.instruction or
 * grantsSha256 with permissions. Those cross-operation mappings are not in the
 * existing ordinary-owner-receiving schema. Valid protected bytes still REFUSE. */
export function inspectOperationalAdmission(inputs: OperationalAdmissionInputs) {
	const original = bytes(inputs.instruction),
		requested = instruction(original);
	const decisionBytes = bytes(inputs.decision),
		record = parseOrdinaryOwnerRecord(decisionBytes);
	const received = parseOrdinaryOwnerReceiving(bytes(inputs.receiving));
	const profileBytes = bytes(inputs.profile),
		profile = parseOwnerHostProfile(profileBytes);
	assert.equal(record.receiving.path, inputs.receiving.ref.path, "OPS_ADMISSION_RECEIVING_PATH");
	assert.equal(record.receiving.reference, received.reference, "OPS_ADMISSION_RECEIVING_REFERENCE");
	assert.equal(received.decisionSha256, sha(decisionBytes), "OPS_ADMISSION_DECISION_JOIN");
	assert.equal(received.profileSha256, record.profileSha256, "OPS_ADMISSION_PROFILE_JOIN");
	assert.equal(record.profileSha256, sha(profileBytes), "OPS_ADMISSION_PROFILE_BYTES");
	for (const key of ["source", "package", "application", "admission"] as const)
		assert.deepEqual(received[key], record[key], `OPS_ADMISSION_RECEIVING_${key}`);
	for (const key of ["uid", "gid", "unit", "cgroup"] as const)
		assert.equal(record.admission.target[key], profile.host[key], "OPS_ADMISSION_PROFILE_TARGET");
	const ceilings = [profile.artifacts.runtime, ...profile.artifacts.closure];
	for (const item of [record.application, record.bun, record.sense, ...record.closure])
		assert(
			ceilings.some((ceiling) => ceiling.path === item.path && ceiling.sha256 === item.sha256),
			"OPS_ADMISSION_ARTIFACT_CEILING",
		);
	for (const root of Object.values(record.roots))
		assert(
			profile.sandbox.fileRoots.some(
				(ceiling) => ceiling.path === root.path && (root.access === "read-only" || ceiling.access === "read-write"),
			),
			"OPS_ADMISSION_ROOT_CEILING",
		);
	assert(
		record.limits.timeoutMs <= profile.limits.processTimeoutMs &&
			record.limits.maxConcurrent <= profile.limits.launchesPerOwner &&
			record.limits.maxInputBytes <= profile.limits.outputBytes &&
			record.limits.maxBodyBytes + record.limits.maxStderrBytes <= profile.limits.outputBytes &&
			record.admission.allocation.inference + (record.provider.count?.operations ?? 0) <=
				profile.limits.operationsPerOwner,
		"OPS_ADMISSION_RESOURCE_CEILING",
	);
	assert(
		inputs.producers.size === producerNames.length && producerNames.every((name) => inputs.producers.has(name)),
		"OPS_ADMISSION_PRODUCER_SET",
	);
	const producers = [...inputs.producers].map(([name, held]) => {
		const raw = bytes(held),
			retained = inputs.retained.get(held.ref.path);
		assert(retained && sha(retained) === held.ref.sha256, "OPS_ADMISSION_PRODUCER_NOT_RETAINED");
		return { name, ref: { ...held.ref }, bytes: raw.byteLength };
	});
	// Each call returns detached data. No returned object or JSON flag can enable receive/check.
	return structuredClone({
		authority: "UNAVAILABLE" as const,
		instructionSha256: sha(original),
		requested,
		nativeCorrespondence: {
			decisionSha256: sha(decisionBytes),
			source: record.source,
			profileSha256: record.profileSha256,
			package: record.package,
			application: record.application,
			admission: record.admission,
			roots: record.roots,
			effects: record.effects,
			limits: record.limits,
			profileLimits: profile.limits,
			provider: { provider: record.provider.provider, model: record.provider.model, api: record.provider.api },
		},
		producers,
		missing: MISSING_OPERATIONAL_AUTHORITY,
	});
}

/** Pure tuple correspondence, exported for nearest inert checks. This function
 * accepts DATA and supplies NO authority/token/permission. Production entry below
 * always gets its data from the pinned original CI receiver, never a callback. */
export function joinOperationalTuple(
	data: ReceivedCIData,
	inputs: SelectedOperationalAdmissionInputs,
	facts: ReturnType<typeof inspectOperationalAdmission>,
	operation: Operation,
): OperationalBinding {
	const selected = inputs.authority,
		auth = data.authorization;
	assert(
		data.version === 1 &&
			data.kind === "original-ci-operational-authorization" &&
			data.authorization_id === selected.authorizationId &&
			data.release_sha256 === selected.releaseSha256 &&
			auth.release_sha256 === selected.releaseSha256,
		"OPS_CI_ORIGINAL_PROVENANCE",
	);
	for (const key of [
		"repository_id",
		"run_id",
		"run_attempt",
		"source_sha",
		"source_tree",
		"control_sha",
		"workflow_sha",
		"recipe_sha256",
	] as const)
		assert.equal(auth[key], selected.expected[key], `OPS_CI_TUPLE_${key}`);
	assert.equal(data.manifest_sha256, selected.expected.manifest_sha256, "OPS_CI_SOURCE_MANIFEST");
	const binding = auth.operational_binding;
	assert(
		binding?.version === 1 &&
			binding.namespace === "sense-operational-pi" &&
			binding.producer_schema === "ops-bindings-17-source-diagnostics",
		"OPS_NAMESPACE_NOT_ISSUED",
	);
	assert(binding.allowed_operations.includes(operation), "OPS_OPERATION_NOT_ADMITTED");
	assert.equal(binding.operational_run_id, facts.requested.runId, "OPS_OPERATIONAL_RUN");
	assert.deepEqual(binding.instruction, inputs.instruction.ref, "OPS_ORIGINAL_INSTRUCTION");
	assert.equal(binding.instruction.sha256, facts.instructionSha256, "OPS_PLAN_MODULE_SOURCE_BYTES");
	assert.equal(facts.requested.identity.source.commit, auth.source_sha, "OPS_OPERATIONAL_SOURCE_COMMIT");
	assert.equal(facts.requested.identity.source.tree, auth.source_tree, "OPS_OPERATIONAL_SOURCE_TREE");
	assert.deepEqual(binding.producer_contract, inputs.producerContract.ref, "OPS_REVIEWED_PRODUCER_CONTRACT");
	bytes(inputs.producerContract);
	assertOriginalCINativeBinding(binding.native);
	for (const key of ["decision", "receiving", "profile"] as const)
		assert.deepEqual(binding.native[key], inputs[key].ref, `OPS_ORIGINAL_NATIVE_${key}`);
	assert.deepEqual(Object.keys(binding.producers).sort(), [...producerNames].sort(), "OPS_EXACT_17_PRODUCERS");
	for (const item of facts.producers)
		assert.deepEqual(binding.producers[item.name], item.ref, "OPS_ORIGINAL_PRODUCER");
	const now = Date.now();
	assert(
		Number.isSafeInteger(auth.issued_at) &&
			Number.isSafeInteger(auth.expires_at) &&
			auth.issued_at * 1000 <= now &&
			auth.expires_at > auth.issued_at &&
			auth.expires_at - auth.issued_at <= 600,
		"OPS_CI_EXPIRED",
	);
	return structuredClone(binding);
}
/** Numeric DATA checks only, never continuation authority. Production supplies a
 * continued deadline only for its already-bound child, AFTER each successful
 * pinned original CI read authenticates the same released-in-time custody. */
export function assertOperationalAdmissionTime(
	authorization: Pick<ReceivedCIData["authorization"], "issued_at" | "expires_at">,
	allocation: { notBeforeMs: number; expiresMs: number },
	clock: { firstWall: number; firstMono: number; lastWall: number; lastMono: number; now: number; mono: number },
	continuedDeadlineWallMs?: number,
): void {
	const { firstWall, firstMono, lastWall, lastMono, now, mono } = clock;
	const issued = authorization.issued_at * 1000;
	const bootstrapEnd = authorization.expires_at * 1000;
	const end = Math.min(allocation.expiresMs, continuedDeadlineWallMs ?? bootstrapEnd);
	assert(
		Number.isSafeInteger(issued) &&
			Number.isSafeInteger(bootstrapEnd) &&
			bootstrapEnd > issued &&
			bootstrapEnd - issued <= 600_000 &&
			Number.isSafeInteger(allocation.notBeforeMs) &&
			Number.isSafeInteger(allocation.expiresMs) &&
			(continuedDeadlineWallMs === undefined || Number.isSafeInteger(continuedDeadlineWallMs)) &&
			Number.isSafeInteger(now) &&
			Number.isSafeInteger(firstWall) &&
			Number.isSafeInteger(lastWall) &&
			Number.isFinite(mono) &&
			Number.isFinite(firstMono) &&
			Number.isFinite(lastMono) &&
			now >= lastWall &&
			lastWall >= firstWall &&
			mono >= lastMono &&
			lastMono >= firstMono &&
			now >= issued &&
			now >= allocation.notBeforeMs &&
			now < end &&
			mono - firstMono < end - firstWall,
		"OPS_ADMISSION_EXPIRED_OR_CLOCK_REGRESSION",
	);
}
/** Original retained graph correspondence after EACH pinned CI receiving. The
 * helper authenticates protected raw records (including duplicate-key refusal).
 * These joins do not qualify the physical claims or replace native permission. */
export function receiveOperationalResourceGraph(
	binding: OperationalBinding,
	inputs: SelectedOperationalAdmissionInputs,
): void {
	const seen = new Map<string, RawRef>();
	const retainedBytes = (ref: unknown): Buffer => {
		fields(ref, "path sha256");
		assert(typeof ref.path === "string" && typeof ref.sha256 === "string", "OPS_GRAPH_REF");
		const selected = { path: ref.path, sha256: ref.sha256 };
		const previous = seen.get(selected.path);
		assert(!previous || previous.sha256 === selected.sha256, "OPS_GRAPH_REF_REBOUND");
		assert(previous || seen.size < 64, "OPS_GRAPH_REF_BOUND");
		seen.set(selected.path, selected);
		return sc085RetainedBytes(selected, inputs.retained);
	};
	const record = (ref: unknown): Record<string, unknown> => {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(retainedBytes(ref)));
		assert(value !== null && typeof value === "object" && !Array.isArray(value), "OPS_GRAPH_OBJECT");
		return value as Record<string, unknown>;
	};
	const policy = record(binding.policy);
	const prelaunch = policy.operational_prelaunch;
	fields(
		prelaunch,
		"version kind phasePlan allocation resourceEpoch receiving execution constraints operationalBinding",
	);
	assert(prelaunch.version === 1 && prelaunch.kind === "original-ci-operational-selection", "OPS_GRAPH_PRELAUNCH");
	const constraints = prelaunch.constraints;
	fields(constraints, "N T budget epochSource otherResources");
	const source = parseOperationalEpochSource(canonicalPilotDecision(record(constraints.epochSource)));
	for (const ref of operationalEnforcementMethodRefs(source.enforcementMethod)) {
		assert.notEqual(ref.path, (constraints.epochSource as RawRef).path, "OPS_GRAPH_ENFORCEMENT_METHOD_CYCLE");
		retainedBytes(ref);
	}
	for (const [name, original] of [
		["repositoryId", "repository_id"],
		["runId", "run_id"],
		["attempt", "run_attempt"],
		["controlSha", "control_sha"],
		["workflowSha", "workflow_sha"],
	] as const)
		assert.equal(source[name], inputs.authority.expected[original], "OPS_GRAPH_TUPLE");
	for (const name of ["allocation", "resourceEpoch", "receiving", "phasePlan"] as const)
		assert.deepEqual(source[name], prelaunch[name], "OPS_GRAPH_SELECTION");
	const declaredBinding = prelaunch.operationalBinding;
	fields(
		declaredBinding,
		"version namespace producer_schema producer_contract instruction operational_run_id native producers allowed_operations",
	);
	for (const name of Object.keys(declaredBinding) as Array<keyof typeof binding>)
		assert.deepEqual(declaredBinding[name], binding[name], "OPS_GRAPH_ORIGINAL_BINDING");
	assert.deepEqual(source.receiving, binding.native.receiving, "OPS_GRAPH_RECEIVING");
	assert.deepEqual(source.clockContract, record(source.phasePlan).clockBasisRef, "OPS_GRAPH_CLOCK");
	record(source.clockContract);
	const profile = parseOwnerHostProfile(bytes(inputs.profile));
	const decision = parseOrdinaryOwnerRecord(bytes(inputs.decision));
	const receiving = parseOrdinaryOwnerReceiving(bytes(inputs.receiving));
	assert(
		source.ownerUid === String(profile.host.uid) &&
			profile.host.uid > 0 &&
			profile.host.uid <= 2147483647 &&
			profile.host.uid === decision.admission.target.uid,
		"OPS_GRAPH_HOST_UID",
	);
	for (const key of ["gid", "unit", "cgroup"] as const)
		assert.equal(profile.host[key], decision.admission.target[key], "OPS_GRAPH_HOST_TARGET");
	assert.equal(decision.admission.allocation.id, source.allocation.id, "OPS_GRAPH_ALLOCATION");
	assert.equal(decision.profileSha256, binding.native.profile.sha256, "OPS_GRAPH_PROFILE");
	assert.equal(receiving.profileSha256, binding.native.profile.sha256, "OPS_GRAPH_PROFILE");
	assert.equal(receiving.decisionSha256, binding.native.decision.sha256, "OPS_GRAPH_DECISION");
	assert.deepEqual(receiving.admission, decision.admission, "OPS_GRAPH_NATIVE_ADMISSION");
	const host = record(source.host);
	fields(host, "version kind owner resourceEpoch profile uidReservation qualification network");
	assert(host.version === 1 && host.kind === "original-ci-operational-host-source", "OPS_GRAPH_HOST_SOURCE");
	assert.deepEqual(host.owner, source.owner, "OPS_GRAPH_HOST_OWNER");
	assert.equal(host.resourceEpoch, source.resourceEpoch, "OPS_GRAPH_HOST_EPOCH");
	assert.deepEqual(host.profile, binding.native.profile, "OPS_GRAPH_HOST_PROFILE");
	const reservation = record(host.uidReservation);
	fields(reservation, "version kind owner name uid gid allocation resourceEpoch tenure");
	fields(reservation.tenure, "kind source");
	assert(
		reservation.version === 1 &&
			reservation.kind === "original-ci-host-uid-reservation" &&
			typeof reservation.name === "string" &&
			/^[a-z_][a-z0-9_-]{0,30}$/.test(reservation.name),
		"OPS_GRAPH_HOST_RESERVATION",
	);
	assert.deepEqual(reservation.owner, source.owner, "OPS_GRAPH_HOST_RESERVATION_OWNER");
	assert.deepEqual(reservation.allocation, source.allocation, "OPS_GRAPH_HOST_RESERVATION_ALLOCATION");
	assert.equal(reservation.resourceEpoch, source.resourceEpoch, "OPS_GRAPH_HOST_RESERVATION_EPOCH");
	assert(
		reservation.uid === profile.host.uid &&
			reservation.gid === profile.host.gid &&
			profile.host.gid > 0 &&
			profile.host.gid <= 2147483647,
		"OPS_GRAPH_HOST_RESERVATION_ACCOUNT",
	);
	assert.equal(reservation.tenure.kind, "exclusive-through-original-parent-release", "OPS_GRAPH_HOST_TENURE");
	record(reservation.tenure.source);
	const hostQualification = record(host.qualification);
	fields(hostQualification, "version kind owner profile uidReservation allocation resourceEpoch observations");
	assert(
		hostQualification.version === 1 && hostQualification.kind === "original-ci-operational-host-qualification",
		"OPS_GRAPH_HOST_QUALIFICATION",
	);
	for (const name of ["owner", "profile", "uidReservation", "resourceEpoch"])
		assert.deepEqual(hostQualification[name], host[name], "OPS_GRAPH_HOST_QUALIFICATION_SELECTION");
	assert.deepEqual(hostQualification.allocation, source.allocation, "OPS_GRAPH_HOST_QUALIFICATION_ALLOCATION");
	fields(
		hostQualification.observations,
		"mountinfo delegationOwner ancestorDeny siblingDeny noEscape uidTenure namespaceSandbox storageEnforcement",
	);
	assert.deepEqual(
		hostQualification.observations.uidTenure,
		reservation.tenure.source,
		"OPS_GRAPH_HOST_ORIGINAL_TENURE",
	);
	for (const observed of Object.values(hostQualification.observations)) record(observed);
	// These exact original references are DATA, not semantic Host qualification.
	// Original CI still owns runner-account exclusion and observation authority.
	fields(host.network, "kind owner decision endpoints credential");
	assert.equal(host.network.kind, "original-provider-http", "OPS_GRAPH_HOST_NETWORK_KIND");
	record(host.network.owner);
	assert.deepEqual(host.network.decision, binding.native.decision, "OPS_GRAPH_HOST_NETWORK_DECISION");
	assert.deepEqual(host.network.credential, decision.provider.credential, "OPS_GRAPH_HOST_NETWORK_CREDENTIAL");
	assert.deepEqual(
		host.network.endpoints,
		[decision.provider.url, ...(decision.provider.count ? [decision.provider.count.url] : [])],
		"OPS_GRAPH_HOST_NETWORK_ENDPOINTS",
	);
	const owner = record(source.owner);
	fields(
		owner,
		"version kind role repositoryId runId attempt controlSha workflowSha allocation resourceEpoch ownerEpoch controllerSource",
	);
	assert(
		owner.version === 1 &&
			owner.kind === "original-ci-parent-aggregate-owner" &&
			owner.role === "ci-parent-aggregate",
		"OPS_GRAPH_PARENT_ROLE",
	);
	for (const name of [
		"repositoryId",
		"runId",
		"attempt",
		"controlSha",
		"workflowSha",
		"allocation",
		"resourceEpoch",
		"ownerEpoch",
	] as const)
		assert.deepEqual(owner[name], source[name], "OPS_GRAPH_PARENT_TUPLE");
	assert.deepEqual(owner.controllerSource, inputs.authority.controller, "OPS_GRAPH_CONTROLLER");
	const limits = record(source.limits);
	fields(limits, "version kind role owner ownerEpoch N T budget memoryBytes memorySwapBytes otherResources");
	assert(
		limits.version === 1 &&
			limits.kind === "original-ci-parent-aggregate-limits" &&
			limits.role === "ci-parent-aggregate",
		"OPS_GRAPH_LIMIT_ROLE",
	);
	assert.deepEqual(limits.owner, source.owner, "OPS_GRAPH_LIMIT_OWNER");
	assert.equal(limits.ownerEpoch, source.ownerEpoch, "OPS_GRAPH_LIMIT_EPOCH");
	for (const name of ["N", "T", "budget"] as const) {
		safe(constraints[name]);
		assert((constraints[name] as number) > 0, "OPS_GRAPH_LIMIT");
		assert.equal(limits[name], constraints[name], "OPS_GRAPH_LIMIT");
	}
	assert(
		BigInt(constraints.N as number) * BigInt(constraints.T as number) <= BigInt(constraints.budget as number),
		"OPS_GRAPH_BUDGET",
	);
	assert.equal(constraints.N, profile.limits.fileDescriptors, "OPS_GRAPH_NATIVE_LIMIT");
	assert.equal(constraints.T, profile.limits.pids, "OPS_GRAPH_NATIVE_LIMIT");
	assert.equal(limits.memoryBytes, profile.limits.memoryBytes, "OPS_GRAPH_MEMORY");
	assert.equal(limits.memorySwapBytes, 0, "OPS_GRAPH_SWAP");
	assert.deepEqual(limits.otherResources, constraints.otherResources, "OPS_GRAPH_OTHER_LIMITS");
	const preflight = binding.fd_slot_bound;
	assert(preflight, "OPS_GRAPH_PREFLIGHT_REQUIRED");
	for (const name of ["N", "T", "budget"] as const)
		assert.equal(preflight[name], constraints[name], "OPS_GRAPH_PREFLIGHT_LIMIT");
	const scope = record(preflight.scope);
	fields(scope, "version kind owner ownerEpoch aggregate subjects limits");
	assert(scope.version === 2 && scope.kind === "fd-slot-scope", "OPS_GRAPH_SCOPE");
	assert.deepEqual(scope.owner, source.owner, "OPS_GRAPH_SCOPE_OWNER");
	assert.equal(scope.ownerEpoch, source.ownerEpoch, "OPS_GRAPH_SCOPE_EPOCH");
	assert.deepEqual(scope.limits, source.limits, "OPS_GRAPH_SCOPE_LIMITS");
	assert.deepEqual(scope.subjects, ["bun", "native", "observers"], "OPS_GRAPH_SUBJECTS");
	fields(scope.aggregate, "device inode");
	safe(scope.aggregate.device);
	safe(scope.aggregate.inode);
	assert(scope.aggregate.inode > 0, "OPS_GRAPH_PARENT_INODE");
	const epoch = record(preflight.epoch);
	fields(epoch, "version kind scope owner ownerEpoch aggregate source");
	assert(epoch.version === 1 && epoch.kind === "fd-slot-epoch", "OPS_GRAPH_EPOCH");
	assert.deepEqual(epoch.scope, preflight.scope, "OPS_GRAPH_EPOCH_SCOPE");
	assert.deepEqual(epoch.source, constraints.epochSource, "OPS_GRAPH_EPOCH_SOURCE");
	for (const key of ["owner", "ownerEpoch", "aggregate"])
		assert.deepEqual(epoch[key], scope[key], "OPS_GRAPH_EPOCH_BINDING");
	const association = {
		scope: preflight.scope,
		epoch: preflight.epoch,
		owner: scope.owner,
		ownerEpoch: scope.ownerEpoch,
		aggregate: scope.aggregate,
	};
	let initialAt: unknown;
	const associated = (row: Record<string, unknown>, kind: string, extra: string) => {
		fields(row, `version kind binding initialAt source ${extra}`);
		assert(row.version === 1 && row.kind === kind, "OPS_GRAPH_WRAPPER_KIND");
		assert.deepEqual(row.binding, association, "OPS_GRAPH_WRAPPER_BINDING");
		fields(row.initialAt, "clockId monotonicMs wallMs uncertaintyMs raw");
		assert(
			typeof row.initialAt.clockId === "string" &&
				row.initialAt.clockId.length > 0 &&
				row.initialAt.clockId.length <= 256,
			"OPS_GRAPH_STAMP",
		);
		for (const name of ["monotonicMs", "wallMs", "uncertaintyMs"])
			assert(typeof row.initialAt[name] === "number" && Number.isFinite(row.initialAt[name]), "OPS_GRAPH_STAMP");
		assert(
			(row.initialAt.monotonicMs as number) >= 0 && (row.initialAt.uncertaintyMs as number) >= 0,
			"OPS_GRAPH_STAMP",
		);
		record(row.initialAt.raw);
		if (initialAt !== undefined) assert.deepEqual(row.initialAt, initialAt, "OPS_GRAPH_STAMP_CHANGED");
		initialAt = structuredClone(row.initialAt);
	};
	assert.deepEqual(
		Object.keys(preflight.proofs).sort(),
		[...initialConditionNames].sort(),
		"OPS_GRAPH_SEVEN_WRAPPERS",
	);
	for (const name of initialConditionNames) {
		const row = record(preflight.proofs[name]);
		const extra =
			name === "inheritedHardLimit"
				? " soft hard"
				: name === "initialFdRoster"
					? " tasks tables"
					: name === "aggregateTasksMembership"
						? " ceiling initialTaskIds"
						: "";
		associated(row, "fd-slot-initial-condition", `name${extra}`);
		assert.equal(row.name, name, "OPS_GRAPH_CONDITION_NAME");
		assert.deepEqual(row.source, source.initialConditions[name], "OPS_GRAPH_CONDITION_SOURCE");
		assert.notDeepEqual(row.source, preflight.proofs[name], "OPS_GRAPH_WRAPPER_AS_SOURCE");
		record(row.source);
		if (name === "inheritedHardLimit") {
			safe(row.soft);
			safe(row.hard);
			assert(row.soft > 0 && row.soft <= row.hard && row.hard === preflight.N, "OPS_GRAPH_INHERITED_LIMIT");
		}
		if (name === "aggregateTasksMembership") assert.equal(row.ceiling, preflight.T, "OPS_GRAPH_TASK_LIMIT");
	}
	const quantities = {
		openFileDescriptions: "open-file-descriptions",
		queuedOrInFlightReferences: "queued-or-inflight-references",
		ioUringFixedFiles: "io-uring-fixed-files",
		logicalHandles: "runtime-logical-handles",
	} as const;
	fields(constraints.otherResources, Object.keys(quantities).join(" "));
	assert.deepEqual(
		Object.keys(preflight.otherResources).sort(),
		Object.keys(quantities).sort(),
		"OPS_GRAPH_OTHER_SET",
	);
	for (const name of Object.keys(quantities) as Array<keyof typeof quantities>) {
		const selected: unknown = constraints.otherResources[name];
		const actual: Record<string, unknown> = { ...preflight.otherResources[name] };
		assert(actual.kind === "admitted-exclusion" || actual.kind === "separately-bounded", "OPS_GRAPH_OTHER_KIND");
		const extra: string = actual.kind === "admitted-exclusion" ? "" : " bound budget unit";
		fields(selected, `kind evidence${extra}`);
		fields(actual, `kind evidence${extra}`);
		for (const key of ["kind", ...(extra ? ["bound", "budget", "unit"] : [])])
			assert.deepEqual(actual[key], selected[key], "OPS_GRAPH_OTHER_SELECTION");
		const row = record(actual.evidence);
		associated(
			row,
			"fd-slot-initial-other-resource",
			`quantity disposition ${extra ? "bound budget unit" : "restriction"}`,
		);
		assert.equal(row.quantity, quantities[name], "OPS_GRAPH_OTHER_QUANTITY");
		assert.equal(row.disposition, selected.kind, "OPS_GRAPH_OTHER_DISPOSITION");
		assert.deepEqual(row.source, selected.evidence, "OPS_GRAPH_OTHER_SOURCE");
		assert.notDeepEqual(row.source, actual.evidence, "OPS_GRAPH_WRAPPER_AS_SOURCE");
		record(row.source);
		if (actual.kind === "admitted-exclusion") record(row.restriction);
		else {
			safe(actual.bound);
			safe(actual.budget);
			assert(
				actual.bound <= actual.budget &&
					actual.budget > 0 &&
					typeof actual.unit === "string" &&
					actual.unit.length > 0,
				"OPS_GRAPH_OTHER_BOUND",
			);
			for (const key of ["bound", "budget", "unit"])
				assert.deepEqual(row[key], selected[key], "OPS_GRAPH_OTHER_BOUND");
		}
	}
	for (const ref of seen.values()) sc085RetainedBytes(ref, inputs.retained);
}

/** DATA retention correspondence after the original helper's private projection.
 * No file read, sibling lookup, controller exchange or effect permission here. */
export function verifyOperationalInitialRetention(
	projection: OriginalCIInitialProjection,
	binding: OperationalBinding,
	retained: ReadonlyMap<string, Uint8Array>,
): RawRef {
	for (const entry of [projection.release, projection.initial]) {
		assert(sha(entry.bytes) === entry.raw.sha256, "OPS_INITIAL_PROJECTION_MUTATED");
		assert(
			sc085RetainedBytes(
				entry.raw,
				retained,
				entry === projection.release ? 2 * 1024 * 1024 : 4 * 1024 * 1024,
			).equals(Buffer.from(entry.bytes)),
			"OPS_INITIAL_BYTES_NOT_RETAINED",
		);
	}
	const release: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(projection.release.bytes));
	fields(
		release,
		"version kind entry captureSha256 initial authorizationId wrapper issuanceLink releasedNs releasedWallSeconds",
	);
	assert.deepEqual(release.initial, projection.initial.raw, "OPS_INITIAL_RELEASE_CARRIER");
	const initial: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(projection.initial.bytes));
	fields(
		initial,
		"version kind receivingReference runId allocationId sessionId profileSha256 resourceEpoch aggregate launcher preexec original records",
	);
	assert(initial.version === 1 && initial.kind === "ordinary-resource-initial/1", "OPS_INITIAL_KIND");
	fields(initial.preexec, "nofile initialFdAndTasks raw");
	fields(initial.original, "scope epoch enforcement initialFd");
	assert(Array.isArray(initial.records) && initial.records.length <= 96, "OPS_INITIAL_RECORD_COUNT");
	const records = new Map<string, RawRef>();
	let total = 0;
	for (const row of initial.records) {
		fields(row, "raw base64");
		fields(row.raw, "path sha256");
		assert(
			typeof row.raw.path === "string" &&
				typeof row.raw.sha256 === "string" &&
				/^[a-f0-9]{64}$/.test(row.raw.sha256),
			"OPS_INITIAL_RECORD_REF",
		);
		assert(
			typeof row.base64 === "string" && row.base64.length <= 4 * Math.ceil((2 * 1024 * 1024 - total) / 3),
			"OPS_INITIAL_RECORD_ENCODING",
		);
		const bytes = Buffer.from(row.base64, "base64");
		total += bytes.length;
		assert(
			total <= 2 * 1024 * 1024 &&
				bytes.toString("base64") === row.base64 &&
				!records.has(row.raw.path) &&
				sha(bytes) === row.raw.sha256,
			"OPS_INITIAL_RECORD_RETENTION",
		);
		const ref = { path: row.raw.path, sha256: row.raw.sha256 };
		assert(sc085RetainedBytes(ref, retained, 2 * 1024 * 1024).equals(bytes), "OPS_INITIAL_RECORD_NOT_RETAINED");
		records.set(ref.path, ref);
	}
	const bound = binding.fd_slot_bound;
	assert(bound, "OPS_INITIAL_PREFLIGHT_REQUIRED");
	assert.deepEqual(initial.original.scope, bound.scope, "OPS_INITIAL_SCOPE");
	assert.deepEqual(initial.original.epoch, bound.epoch, "OPS_INITIAL_EPOCH");
	assert.deepEqual(initial.original.initialFd, bound.proofs.initialFdRoster, "OPS_INITIAL_FD_ROSTER");
	assert.deepEqual(initial.preexec.initialFdAndTasks, initial.original.initialFd, "OPS_INITIAL_FD_CAPTURE");
	for (const ref of [
		initial.preexec.raw,
		...Object.values(initial.original),
		...Object.values(bound.proofs),
		...Object.values(bound.otherResources).map((row) => row.evidence),
	]) {
		fields(ref, "path sha256");
		assert(typeof ref.path === "string", "OPS_INITIAL_RECORD_REF");
		assert.deepEqual(records.get(ref.path), ref, "OPS_INITIAL_REQUIRED_RECORD");
	}
	fields(initial.preexec.raw, "path sha256");
	assert.equal(initial.preexec.raw.sha256, release.captureSha256, "OPS_INITIAL_CAPTURE_HASH");
	assert.equal(initial.runId, binding.operational_run_id, "OPS_INITIAL_RUN");
	assert.equal(initial.profileSha256, binding.native.profile.sha256, "OPS_INITIAL_PROFILE");
	verifyOperationalEnforcementRetention(initial, release, binding, records, retained);
	return { ...projection.release.raw };
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
/** Original CI receiving, plan2 bootstrap and private actual-child supplier.
 * It never calls issue/allocate/activate/receiveOrdinaryOwner, and takes no verifier
 * callback. Factory is inert except checking already-held instruction bytes. */
export function createOperationalAdmission(
	inputs: OperationalAdmissionInputs,
): OperationalHostProviders["admission"] & {
	preflight(input: OperationalHostInstruction): void;
	preflightSc085(
		input: OperationalHostInstruction,
		originalBytes: Uint8Array,
		retainInitial: (projection: OriginalCIInitialProjection) => void,
	): Promise<void>;
	receiveFdSlotPreflight(): IndependentlyAdmittedFdSlotPreflight;
	receiveFdSlotBoundExpectation(): IndependentlyAdmittedFdSlotExpectation;
} {
	fields(inputs, "producerContract instruction decision receiving profile producers retained");
	const hold = (r: HeldOperationalRecord): HeldOperationalRecord => ({ ref: { ...r.ref }, held: r.held });
	const retained: OperationalAdmissionInputs = {
		producerContract: hold(inputs.producerContract),
		instruction: hold(inputs.instruction),
		decision: hold(inputs.decision),
		receiving: hold(inputs.receiving),
		profile: hold(inputs.profile),
		producers: new Map([...inputs.producers].map(([name, value]) => [name, hold(value)])),
		retained: inputs.retained,
	};
	const initial = bytes(retained.instruction);
	let lastWall = Date.now(),
		lastMono = performance.now();
	const firstWall = lastWall,
		firstMono = lastMono;
	let issuedGrant: { notBeforeWallMs: number; expiresWallMs: number } | undefined;
	let originalAuthorization: ReceivedCIData | undefined;
	let originalInitial: OriginalCIInitialProjection | undefined;
	let released: ReturnType<typeof readReleasedCISelection> | undefined;
	let selectedInputs: SelectedOperationalAdmissionInputs | undefined;
	let receivingActive = false;
	const guarded = <T>(action: () => T): T => {
		checkFailure();
		if (receivingActive) return fail(new Error("OPS_SYNCHRONOUS_AUTHORITY_REENTRY"));
		receivingActive = true;
		try {
			const value = action();
			checkFailure();
			return value;
		} catch (error) {
			return fail(error);
		} finally {
			receivingActive = false;
		}
	};
	const readRetained = (ref: RawRef) => guarded(() => sc085RetainedBytes(ref, retained.retained));
	const receiveTuple = (
		operation: Operation,
		input?: OperationalHostInstruction,
		originalBytes?: Uint8Array,
		retainInitial?: (projection: OriginalCIInitialProjection) => void,
		clock?: OriginalClockReceiving,
	) =>
		guarded(() => {
			assert(
				["preflight", "configure", "request", "burst", "refresh", "boundary"].includes(operation),
				"OPS_ADMISSION_OPERATION",
			);
			const facts = inspectOperationalAdmission(retained);
			assert(facts.requested.production && typeof facts.requested.production === "object", "OPS_SOURCE2_FIELDS");
			const source2 = (facts.requested.production as Record<string, unknown>).source2;
			assert(source2 && typeof source2 === "object" && !Array.isArray(source2), "OPS_SOURCE2_FIELDS");
			assert.deepEqual(
				Object.keys(source2).sort(),
				["agentDir", "entry", "evidence", "producerContract"],
				"OPS_SOURCE2_FIELDS",
			);
			const staticSource = source2 as Record<string, unknown>;
			assert.deepEqual(staticSource.producerContract, retained.producerContract.ref, "OPS_SOURCE2_CONTRACT");
			assert.deepEqual(
				staticSource.entry,
				parseOrdinaryOwnerRecord(bytes(retained.decision)).application,
				"OPS_SOURCE2_ENTRY",
			);
			assert.equal(facts.instructionSha256, sha(initial), "OPS_ADMISSION_INSTRUCTION_DRIFT");
			if (input !== undefined) assert.deepEqual(input, facts.requested, "OPS_ADMISSION_INPUT_MISMATCH");
			if (originalBytes !== undefined)
				assert(Buffer.from(originalBytes).equals(Buffer.from(initial)), "OPS_ADMISSION_INPUT_BYTES");
			assert(
				!retainInitial ||
					(operation === "preflight" && stage === "new" && !originalAuthorization && !originalInitial),
				"OPS_CI_INITIAL_ONCE",
			);
			assert(
				!clock ||
					(!retainInitial && originalInitial && clock.recorder.retained === retained.retained && !clock.received),
				"OPS_CI_CLOCK_ORIGINAL_ROUTE",
			);
			if (!released) {
				assert(operation === "preflight" && retainInitial, "OPS_CI_RELEASED_INITIAL_REQUIRED");
				released = readReleasedCISelection({
					instruction: retained.instruction.ref,
					native: {
						decision: retained.decision.ref,
						receiving: retained.receiving.ref,
						profile: retained.profile.ref,
					},
				});
				selectedInputs = { ...retained, authority: freeze(structuredClone(released.selection)) };
			}
			released.check(undefined, operation);
			checkFailure();
			const actual = selectedInputs!;
			const receivedClock = clock
				? receiveOriginalCIAuthorization(actual.authority, retained.receiving.ref, operation, clock.query)
				: undefined;
			const receivedInitial = retainInitial
				? receiveOriginalCIAuthorization(actual.authority, retained.receiving.ref, "preflight", true)
				: undefined;
			const data = receivedInitial
				? receivedInitial.authorization
				: receivedClock
					? receivedClock.authorization
					: receiveOriginalCIAuthorization(actual.authority, retained.receiving.ref, operation);
			released.check(data, operation);
			if (originalAuthorization) assert.deepEqual(data, originalAuthorization, "OPS_CI_AUTHORIZATION_CHANGED");
			const binding = joinOperationalTuple(data, actual, facts, operation);
			if (receivedInitial) {
				assert.deepEqual(receivedInitial.projection.release.raw, released.release, "OPS_CI_RELEASED_INITIAL");
				// Already inside the original supplier guard. No nested guard around
				// this storage-only callback, and no caller-supplied authority result.
				const completion: unknown = retainInitial!(structuredClone(receivedInitial.projection));
				assert(completion === undefined, "OPS_CI_INITIAL_RETENTION_MUST_BE_SYNCHRONOUS");
				checkFailure();
				verifyOperationalInitialRetention(receivedInitial.projection, binding, retained.retained);
				originalInitial = structuredClone(receivedInitial.projection);
			}
			if (receivedClock) {
				// SAME recorder and original guard. The helper result is not published
				// until storage, custody and swallowed reentry checks all succeed.
				retainOriginalCIClock(receivedClock, originalInitial!, clock!.recorder);
				checkFailure();
			}
			if (originalInitial) verifyOperationalInitialRetention(originalInitial, binding, retained.retained);
			if (binding.fd_slot_bound) receiveOperationalResourceGraph(binding, actual);
			const now = Date.now(),
				mono = performance.now(),
				allocation = facts.nativeCorrespondence.admission.allocation;
			assertOperationalAdmissionTime(
				data.authorization,
				allocation,
				{ firstWall, firstMono, lastWall, lastMono, now, mono },
				stage === "bound"
					? Math.min(selection!.intent.validity.expiresWallMs, selection!.clock.validity.expiresWallMs)
					: undefined,
			);
			originalAuthorization ??= freeze(structuredClone(data));
			lastWall = now;
			lastMono = mono;
			issuedGrant = {
				notBeforeWallMs: data.authorization.issued_at * 1000,
				expiresWallMs: data.authorization.expires_at * 1000,
			};
			assert(allocation.scopeOpen, "OPS_ADMISSION_DECLARED_SCOPE_CLOSED");
			// Recheck held inputs/producer refs after the finite original authority read.
			assert.deepEqual(inspectOperationalAdmission(retained), facts, "OPS_ADMISSION_CUSTODY_DRIFT");
			if (receivedClock) {
				checkFailure();
				clock!.received = receivedClock;
			}
			return binding;
		});
	const nativePending = (): never => {
		throw new Error("OPS_NATIVE_CURRENT_PERMISSION_API_UNAVAILABLE:original-Pi-owner");
	};
	// This state is reachable only through this original receiving closure. No
	// option/callback/JSON can supply the expected intent or permission predicate.
	let stage: "new" | "bootstrap" | "binding" | "bound" | "failed" = "new";
	let firstFailure: { error: unknown } | undefined;
	const checkFailure = () => {
		if (firstFailure) throw firstFailure.error;
	};
	const fail = (error: unknown): never => {
		firstFailure ??= { error };
		stage = "failed";
		throw firstFailure.error;
	};
	let selection: ReturnType<typeof selectSc085> | undefined;
	let bound: Sc085Bound | undefined;
	let child: OrdinaryOwnerContext | undefined;
	let store: OperationalHostProviders["recorder"] | undefined;
	let expectedCapsule: Sc085AdmissionV1 | undefined;
	let expectedQualification: Sc085AuditClockQualificationV2 | undefined;
	let parentClock: ReturnType<typeof receiveClockParentAssociation> | undefined;
	const receiveParentClock = (clock: OriginalClockReceiving, witness: Parameters<typeof receiveClockParentAssociation>[0]["witness"]) => {
		assert(clock.received && originalInitial && originalAuthorization, "OPS_CLOCK_ORIGINAL_QUERY_REQUIRED");
		const associated = guarded(() => receiveClockParentAssociation({ binding: originalAuthorization!.authorization.operational_binding, initial: originalInitial!, retained: retained.retained, prepared: originalClockAssociation(), witness, guard: clock.received!.projection.reply.raw }));
		assert(associated.clockId === selection!.clock.admittedClockId && Number(BigInt(associated.uncertaintyNs)) / 1_000_000 === selection!.uncertaintyMs, "OPS_CLOCK_ORIGINAL_POLICY_BUDGET");
		// Explicit CI source boundary: no independently qualified method exists in
		// this packet. Neither a valid DATA join nor a root reply enables v2 award.
		requireIndependentClockQualification();
		parentClock = associated;
		return associated;
	};
	const originalClose: { phase: "open" | "closing" | "clean" | "failed"; task?: Promise<void>; evidence?: RawRef } = {
		phase: "open",
	};
	const receiveCurrentParent = (operation: Operation, clock?: OriginalClockReceiving) => {
		if (firstFailure) throw firstFailure.error;
		assert(stage !== "failed", "SC085_RECEIVING_FAILED");
		assert(selection, "SC085_BOOTSTRAP_REQUIRED");
		const binding = receiveTuple(operation, undefined, undefined, undefined, clock);
		const current = guarded(() => selectSc085(binding, retained, firstWall, issuedGrant!, stage !== "bound"));
		assert.deepEqual(current, selection, "SC085_ORIGINAL_SELECTION_CHANGED");
		if (stage !== "bound") assert(operation === "preflight", "SC085_CHILD_NOT_BOUND");
		return { binding, current };
	};
	const recheck = (operation: Operation, terminalAccounting = false, clock?: OriginalClockReceiving) => {
		const { binding, current } = receiveCurrentParent(operation, clock);
		if (terminalAccounting) {
			assert(
				operation === "preflight" &&
					originalClose.phase === "clean" &&
					child &&
					child.owner.phase === "closed" &&
					originalClose.evidence,
				"SC085_ORIGINAL_CLEAN_CLOSE_REQUIRED",
			);
			readRetained(originalClose.evidence);
		} else assert(originalClose.phase === "open", "SC085_CHILD_EFFECTS_CLOSED");
		if (child) {
			if (!terminalAccounting) {
				const permission = nativePermission(child, operation, current.intent.nativeReceiving);
				checkSc085Budget(current, permission, stage !== "bound");
			}
			if (bound && expectedCapsule && expectedQualification) {
				guarded(() => receiveSc085Admission(bound!.admission, expectedCapsule, retained.retained));
				guarded(() =>
					receiveSc085AuditClockQualification(
						expectedCapsule!.clock.qualification,
						expectedQualification,
						retained.retained,
					),
				);
				readRetained(bound.binding);
			}
		}
		return binding;
	};
	const receiveCompaction = () => {
		const binding = recheck(stage === "bound" ? "boundary" : "preflight");
		return guarded(() => receiveOriginalCompactionMethod({
			root: binding.producers["soak-boundaries"],
			controller: selectedInputs!.authority.controller,
			retained: retained.retained,
			application: parseOrdinaryOwnerRecord(bytes(retained.decision)).application,
		}));
	};
	const result = Object.freeze({
		async preflightSc085(
			input: OperationalHostInstruction,
			originalBytes: Uint8Array,
			retainInitial: (projection: OriginalCIInitialProjection) => void,
		) {
			try {
				if (firstFailure) throw firstFailure.error;
				assert(stage === "new", "SC085_BOOTSTRAP_ONCE");
				assert(typeof retainInitial === "function", "OPS_CI_INITIAL_RETENTION_REQUIRED");
				const binding = receiveTuple("preflight", input, originalBytes, retainInitial);
				selection = guarded(() => selectSc085(binding, retained, firstWall, issuedGrant!));
				stage = "bootstrap";
				recheck("preflight");
			} catch (error) {
				fail(error);
			}
		},
		async receive(input: OperationalHostInstruction, originalBytes: Uint8Array) {
			if (firstFailure) throw firstFailure.error;
			if (isPlan2(input.sc085)) {
				try {
					receiveTuple("preflight", input, originalBytes);
					assert(stage === "bound", "SC085_CHILD_NOT_BOUND");
					return structuredClone(recheck("preflight").producers);
				} catch (error) {
					return fail(error);
				}
			}
			receiveTuple("preflight", input, originalBytes);
			if (input.sc085) {
				// The current ORIGINAL CI/native interface supplies no private SC085
				// expectation/child-owner binding. Do not promote input/sibling JSON,
				// producer refs or a caller-supplied object into that missing authority.
				// This precise refusal is before Foundation native.preflightSc085.
				guarded(() => receiveSc085Admission((input.sc085 as Sc085Plan).admission, undefined, retained.retained));
			}
			return nativePending();
		},
		check(operation: Operation) {
			if (firstFailure) throw firstFailure.error;
			if (selection) {
				try {
					recheck(operation);
					return;
				} catch (error) {
					fail(error);
				}
			}
			receiveTuple(operation);
			nativePending();
		},
		preflight(input: OperationalHostInstruction) {
			if (firstFailure) throw firstFailure.error;
			if (isPlan2(input.sc085)) {
				try {
					receiveTuple("preflight", input);
					recheck("preflight");
					return;
				} catch (error) {
					fail(error);
				}
			}
			receiveTuple("preflight", input);
			nativePending();
		},
		receiveFdSlotBoundExpectation(): never {
			// Final assembly belongs to the ORIGINAL outside CI owner after capture.
			// This pre-effect supplier has no authenticated final receipt transport.
			throw new Error("OPS_FD_FINAL_EXPECTATION_REQUIRES_ORIGINAL_CI_OWNER_CAPTURE");
		},
		receiveFdSlotPreflight() {
			const binding = receiveTuple("preflight");
			const value = binding.fd_slot_bound;
			assert(value !== null, "OPS_FD_EXPECTATION_NOT_ADMITTED");
			// Independent selection only. Linux still validates real proof bytes/facts;
			// native current permission and other producers remain required by the host.
			const refs = [
				value.scope,
				value.epoch,
				...Object.values(value.proofs),
				...Object.values(value.otherResources).map((item) => item.evidence),
			];
			for (const ref of refs) {
				const raw = guarded(() => retained.retained.get(ref.path));
				assert(raw && sha(raw) === ref.sha256, "OPS_FD_EXPECTATION_RAW_NOT_RETAINED");
			}
			return freeze(structuredClone(value));
		},
	});
	sc085Failures.set(result, {
		fail,
		guarded,
		check: checkFailure,
	});
	sc085Stores.set(result, retained.retained);
	sc085Compactions.set(result, receiveCompaction);
	sc085Bootstraps.set(result, () => {
		try {
			recheck("preflight");
			const selected = selection!;
			return freeze(
				structuredClone({
					intent: selected.intent,
					policy: selected.policy,
					clockPolicy: selected.clock,
					uncertaintyMs: selected.uncertaintyMs,
					application: guarded(() => parseOrdinaryOwnerRecord(bytes(retained.decision)).application),
					receiverInterval: {
						firstWallMs: firstWall,
						firstMonotonicMs: firstMono,
						timeOriginMs: performance.timeOrigin,
						deadlineWallMs: Math.min(
							selected.intent.validity.expiresWallMs,
							selected.clock.validity.expiresWallMs,
						),
					},
				}),
			);
		} catch (error) {
			return fail(error);
		}
	});
	sc085Closers.set(result, () => {
		if (originalClose.task) return originalClose.task;
		// No caller report or callback: only the actual child retained by successful B.
		try {
			assert(child && bound && store, "SC085_ORIGINAL_BOUND_CHILD_REQUIRED");
		} catch (error) {
			return fail(error);
		}
		originalClose.phase = "closing";
		let resolveClose!: () => void, rejectClose!: (error: unknown) => void;
		originalClose.task = new Promise<void>((resolve, reject) => {
			resolveClose = resolve;
			rejectClose = reject;
		});
		const errors: unknown[] = [];
		const capture = (error: unknown) => {
			if (!errors.includes(error)) errors.push(error);
			// Latch immediately in causal order, but never skip original close.
			try {
				fail(error);
			} catch (first) {
				if (!errors.includes(first)) errors.unshift(first);
			}
		};
		let nativeClose: Promise<void> | undefined;
		// Publish the join BEFORE invocation, then fence saved ORIGINAL methods NOW.
		// No yield or parent/storage callback may precede this fixed native call.
		// Rejoining an already-started context close returns its original promise.
		try {
			nativeClose = OrdinaryOwnerContext.prototype.close.call(child!);
		} catch (error) {
			capture(error);
		} // Preserve the exact synchronous cause.
		void (async () => {
			// Cleanup was invoked even when parent permission or an earlier latch fails.
			try {
				receiveCurrentParent("preflight");
			} catch (error) {
				capture(error);
			}
			if (nativeClose) {
				try {
					await nativeClose;
					assert(child!.owner.phase === "closed", "SC085_ORIGINAL_CLOSE_UNKNOWN");
				} catch (error) {
					capture(error);
				}
			} else if (!errors.length) capture(new Error("SC085_ORIGINAL_CLOSE_UNKNOWN"));
			if (!errors.length) {
				try {
					receiveCurrentParent("preflight");
					const evidence = {
						protocol: "sense-ops-sc085-original-child-close/1",
						outcome: "clean",
						owner: expectedCapsule!.owner,
						nativeReceiving: selection!.intent.nativeReceiving,
						preflight: bound!.preflight,
						admission: bound!.admission,
						binding: bound!.binding,
						policy: selection!.policy,
					};
					const ref = guarded(() => store!.bytes(Buffer.from(`${JSON.stringify(evidence)}\n`)));
					assert.deepEqual(
						JSON.parse(readRetained(ref).toString("utf8")),
						evidence,
						"SC085_ORIGINAL_CLOSE_STORAGE",
					);
					receiveCurrentParent("preflight");
					sc085Failures.get(result)!.check();
					originalClose.evidence = freeze(structuredClone(ref));
					originalClose.phase = "clean";
					return;
				} catch (error) {
					capture(error);
				}
			}
			originalClose.phase = "failed";
			// Preserve the original sticky cause AND distinct cleanup/unknown failures.
			let first: unknown;
			try {
				fail(errors[0]);
			} catch (error) {
				first = error;
			}
			const all = [first, ...errors.filter((error) => error !== first)];
			if (all.length > 1) throw new AggregateError(all, "SC085_ORIGINAL_CLOSE_FAILED", { cause: first });
			throw first;
		})().then(resolveClose, rejectClose);
		return originalClose.task;
	});
	let bootstrapSampling = false;
	let lastBootstrapWall: number | undefined, lastBootstrapMono: number | undefined;
	sc085BootstrapSamplers.set(result, (recorder) => {
		try {
			assert(!bootstrapSampling, "SC085_BOOTSTRAP_CLOCK_REENTRY");
			bootstrapSampling = true;
			assert(stage === "bootstrap" || stage === "bound", "SC085_BOOTSTRAP_CLOCK_PHASE");
			assert(recorder.retained === retained.retained, "SC085_ORIGINAL_RECORDER");
			const terminalAccounting = originalClose.phase === "clean";
			recheck("preflight", terminalAccounting);
			const selected = selection!;
			// Sample the original shared object directly. No caller numbers, clock
			// callback, child identity, replacement baseline or inferred calibration.
			const observation = lastBootstrapMono === undefined ? originalClockInitialObservation()
				: captureOrdinaryClockObservation("bootstrap-accounting", () => undefined).observation;
			const { monotonicMs, wallMs } = observation.local;
			assert(
				Number.isFinite(monotonicMs) &&
					monotonicMs >= (lastBootstrapMono ?? monotonicMs) &&
					Number.isSafeInteger(wallMs) &&
					wallMs >= (lastBootstrapWall ?? wallMs),
				"SC085_BOOTSTRAP_CLOCK_REGRESSION",
			);
			const margin = Math.ceil(selected.uncertaintyMs);
			assert(
				wallMs - margin >=
					Math.max(
						selected.clock.validity.notBeforeWallMs,
						selected.intent.validity.notBeforeWallMs,
						issuedGrant!.notBeforeWallMs,
					) &&
					wallMs + margin <
						Math.min(
							selected.clock.validity.expiresWallMs,
							selected.intent.validity.expiresWallMs,
							stage === "bound" ? selected.intent.validity.expiresWallMs : issuedGrant!.expiresWallMs,
						),
				"SC085_BOOTSTRAP_STAMP_VALIDITY",
			);
			const original = {
				protocol: "sense-ops-sc085-bootstrap-sample/1",
				runId: selected.intent.runId,
				allocationId: selected.intent.allocationId,
				source: "node:perf_hooks.performance",
				timeOriginMs: performance.timeOrigin,
				monotonicMs,
				wallMs,
				uncertaintyMs: null,
				parent: observation.parent,
				clockSequence: observation.sequence,
				eventMeaning: observation.eventMeaning,
			};
			const raw = guarded(() => recorder.bytes(Buffer.from(`${JSON.stringify(original)}\n`)));
			assert.deepEqual(JSON.parse(readRetained(raw).toString("utf8")), original, "SC085_BOOTSTRAP_SAMPLE_STORAGE");
			const clock: OriginalClockReceiving = { query: { beforeNs: observation.parent.before.monotonicNs, afterNs: observation.parent.after.monotonicNs }, recorder };
			recheck("preflight", terminalAccounting, clock); // LAST existing recheck, never a third helper.
			const parent = receiveParentClock(clock, observation.parent);
			// Bootstrap keeps original policy/run/allocation; never a fake child.
			const qualification = selected.intent.clockRequirement.qualificationPolicy;
			const view = {
				protocol: "sense-ops-sc085-qualified-bootstrap-stamp/2",
				original: raw,
				qualification,
				policy: selected.policy,
				clockId: selected.clock.admittedClockId,
				runId: selected.intent.runId,
				allocationId: selected.intent.allocationId,
				monotonicNs: parent.monotonicNs,
				uncertaintyNs: parent.uncertaintyNs,
				basis: parent.basis,
				guard: parent.guard,
				monotonicMs: parent.monotonicMs,
				conversionErrorNs: parent.conversionErrorNs,
				wallMs,
				uncertaintyMs: selected.uncertaintyMs,
				accountingPhase: terminalAccounting ? "post-original-child-close" : "original-open-interval",
				originalChildClose: terminalAccounting ? originalClose.evidence! : null,
			};
			const viewRef = guarded(() => recorder.bytes(Buffer.from(`${JSON.stringify(view)}\n`)));
			assert.deepEqual(JSON.parse(readRetained(viewRef).toString("utf8")), view, "SC085_BOOTSTRAP_VIEW_STORAGE");
			assert((originalClose.phase === "clean") === terminalAccounting, "SC085_ACCOUNTING_PHASE_CHANGED");
			checkFailure();
			lastBootstrapWall = wallMs;
			lastBootstrapMono = monotonicMs;
			return {
				clockId: view.clockId,
				monotonicMs: view.monotonicMs,
				conversionErrorNs: view.conversionErrorNs,
				monotonicNs: view.monotonicNs,
				uncertaintyNs: view.uncertaintyNs,
				basis: view.basis,
				guard: view.guard,
				wallMs,
				uncertaintyMs: view.uncertaintyMs,
				raw: viewRef,
				original: raw,
				qualification: { ...qualification },
			};
		} catch (error) {
			return fail(error);
		} finally {
			bootstrapSampling = false;
		}
	});
	sc085Checks.set(result, (owner, operation) => {
		try {
			assert(stage === "bound" && owner === child, "SC085_ORIGINAL_BOUND_CHILD_REQUIRED");
			recheck(operation);
		} catch (error) {
			fail(error);
		}
	});
	sc085Qualifications.set(result, (owner, selector) => {
		try {
			assert(
				stage === "bound" && owner === child && store && expectedQualification && expectedCapsule,
				"SC085_ORIGINAL_BOUND_CHILD_REQUIRED",
			);
			recheck("boundary"); // Completed evidence never demands a FUTURE turn.
			const q = guarded(() =>
				receiveSc085AuditClockQualification(
					expectedCapsule!.clock.qualification,
					expectedQualification,
					retained.retained,
				),
			);
			if (selector.kind === "request") fields(selector, "kind requestId phase");
			else if (selector.kind === "exposure") fields(selector, "kind requestId");
			else if (selector.kind === "compaction") fields(selector, "kind entryId");
			else {
				fields(selector, "kind cursor edge");
				assert.equal(selector.kind, "window", "SC085_STAMP_SELECTOR");
			}
			OrdinaryOperationalAudit.prototype.assertSc085ClockCoverage.call(owner.operationalAudit);
			const compaction = selector.kind === "compaction"
				? OrdinaryOwnerContext.prototype.compactionReceipt.call(owner) : undefined;
			if (compaction && selector.kind === "compaction")
				assert(compaction.append === "confirmed" && compaction.entryId === selector.entryId &&
					compaction.observation?.eventMeaning === "compaction-append", "OPS_COMPACTION_ORIGINAL_ENDPOINT");
			const original = compaction ? {
				scope: { ownerEpoch: compaction.ownerEpoch, sessionId: compaction.sessionId, allocationId: compaction.allocationId },
				clockIdentity: owner.operationalAudit.clockIdentity,
				stamp: {
					monotonicMs: compaction.observation!.local.monotonicMs, wallMs: compaction.observation!.local.wallMs,
					clockId: owner.operationalAudit.clockIdentity.id, uncertaintyMs: null,
					parent: compaction.observation!.parent, clockSequence: compaction.observation!.sequence,
					eventMeaning: compaction.observation!.eventMeaning,
				},
			} : OrdinaryOperationalAudit.prototype.resolveSc085Stamp.call(owner.operationalAudit, selector);
			assert.deepEqual(original.scope, q.owner, "SC085_STAMP_ORIGINAL_SCOPE");
			assert.deepEqual(
				original.clockIdentity,
				JSON.parse(readRetained(q.nativeIdentity).toString("utf8")),
				"SC085_STAMP_ORIGINAL_IDENTITY",
			);
			const stamp = original.stamp,
				uncertaintyMs = Number(BigInt(q.mapping.uncertaintyNs)) / 1_000_000;
			assert(
				uncertaintyMs !== null && stamp.uncertaintyMs === null && stamp.clockId === q.mapping.nativeClockId,
				"SC085_STAMP_QUALIFICATION",
			);
			// Integer validity edges use conservative margins; original fractional
			// monotonic/wall observations themselves are never rounded or replaced.
			assert(
				stamp.wallMs - Math.ceil(uncertaintyMs) >=
					Math.max(q.validity.notBeforeWallMs, expectedCapsule.validity.notBeforeWallMs) &&
					stamp.wallMs + Math.ceil(uncertaintyMs) <
						Math.min(q.validity.expiresWallMs, expectedCapsule.validity.expiresWallMs),
				"SC085_STAMP_VALIDITY",
			);
			const raw = guarded(() => store!.bytes(Buffer.from(`${JSON.stringify(original)}\n`)));
			assert.deepEqual(JSON.parse(readRetained(raw).toString("utf8")), original, "SC085_STAMP_STORAGE");
			assert(stamp.parent && stamp.clockSequence && stamp.eventMeaning, "SC085_ORIGINAL_EVENT_WITNESS_REQUIRED");
			const clock: OriginalClockReceiving = { query: { beforeNs: stamp.parent.before.monotonicNs, afterNs: stamp.parent.after.monotonicNs }, recorder: store };
			recheck("boundary", false, clock); // LAST existing recheck.
			const parent = receiveParentClock(clock, stamp.parent);
			assert.deepEqual(parent.basis, q.mapping.basis, "SC085_CLOCK_FROZEN_BASIS");
			assert.deepEqual(parent.contract, q.mapping.contract, "SC085_CLOCK_FROZEN_CONTRACT");
			const view = {
				protocol: "sense-ops-sc085-qualified-stamp/2",
				original: raw,
				qualification: expectedCapsule.clock.qualification,
				clockId: q.admittedClockId,
				owner: q.owner,
				monotonicNs: parent.monotonicNs,
				uncertaintyNs: parent.uncertaintyNs,
				basis: parent.basis,
				guard: parent.guard,
				monotonicMs: parent.monotonicMs,
				conversionErrorNs: parent.conversionErrorNs,
				wallMs: stamp.wallMs,
				uncertaintyMs,
			};
			const viewRef = guarded(() => store!.bytes(Buffer.from(`${JSON.stringify(view)}\n`)));
			assert.deepEqual(JSON.parse(readRetained(viewRef).toString("utf8")), view, "SC085_QUALIFIED_VIEW_STORAGE");
			checkFailure();
			return {
				monotonicNs: view.monotonicNs,
				uncertaintyNs: view.uncertaintyNs,
				basis: view.basis,
				guard: view.guard,
				clockId: view.clockId,
				monotonicMs: view.monotonicMs,
				conversionErrorNs: view.conversionErrorNs,
				wallMs: view.wallMs,
				uncertaintyMs,
				raw: viewRef,
				original: raw,
				qualification: view.qualification,
			};
		} catch (error) {
			return fail(error);
		}
	});
	sc085Suppliers.set(result, (owner, recorder, receiveOnly) => {
		try {
			assert(stage === (receiveOnly ? "bound" : "bootstrap"), "SC085_BINDING_PHASE");
			assert(recorder.retained === retained.retained, "SC085_ORIGINAL_RECORDER");
			recheck("preflight");
			if (receiveOnly) {
				assert(owner === child && recorder === store && bound, "SC085_CHILD_REBOUND");
				nativePermission(owner, "preflight", selection!.intent.nativeReceiving);
				return structuredClone(bound);
			}
			stage = "binding"; // Once-only even if evidence storage re-enters the supplier.
			// Fixed original Pi identity gate, not an instanceof/shape/callback check.
			assertOrdinaryOwner(owner);
			const selected = selection!,
				intent = selected.intent;
			const permission = nativePermission(owner, "preflight", intent.nativeReceiving);
			checkSc085Budget(selected, permission);
			assert.equal(owner.decision.digest, intent.nativeReceiving.decision.sha256, "SC085_NATIVE_DECISION");
			// The selected preflight ID is raw; the native claim hashes that ID.
			assert.equal(owner.decision.record.admission.allocation.id, intent.allocationId, "SC085_NATIVE_ALLOCATION");
			const identity = {
				ownerEpoch: owner.owner.grant,
				sessionId: owner.owner.sessionId,
				allocationId: owner.decision.allocation.id,
			};
			assert.deepEqual(permission.owner, identity, "SC085_NATIVE_PERMISSION_OWNER");
			assert(owner.operationalAudit.clock === ordinaryClock, "SC085_ORIGINAL_SHARED_CLOCK");
			const audit = owner.operationalAudit.clockIdentity;
			assert(
				audit.ownerEpoch === identity.ownerEpoch &&
					audit.allocationId === identity.allocationId &&
					audit.source === "node:perf_hooks.performance" &&
					audit.correspondence === "original-runtime-clock-source" &&
					audit.restartComparable === false &&
					audit.uncertaintyMs === null &&
					Number.isFinite(audit.timeOriginMs) &&
					audit.timeOriginMs === performance.timeOrigin,
				"SC085_ORIGINAL_AUDIT_SOURCE",
			);
			const nativeIdentity = guarded(() => recorder.bytes(Buffer.from(`${JSON.stringify(audit)}\n`)));
			assert.deepEqual(JSON.parse(readRetained(nativeIdentity).toString("utf8")), audit, "SC085_AUDIT_STORAGE");
			assert(parentClock, "SC085_ORIGINAL_BOOTSTRAP_QUALIFICATION_REQUIRED");
			const prepared = originalClockAssociation();
			const qualification: Sc085AuditClockQualificationV2 = {
				protocol: "sense-ops-sc085-audit-clock/2",
				owner: identity,
				admittedClockId: selected.clock.admittedClockId,
				nativeIdentity,
				source: "node:perf_hooks.performance",
				sourceIdentity: selected.clock.sourceIdentity,
				mapping: { kind: "original-native-clock-witness", nativeClockId: audit.id, contract: parentClock.contract, basis: parentClock.basis, producer: prepared.producer, implementation: prepared.implementation, uncertaintyNs: parentClock.uncertaintyNs },
				validity: selected.clock.validity,
			};
			const qualifiedRef = guarded(() => recorder.bytes(canonicalSc085AuditClockQualification(qualification)));
			guarded(() => receiveSc085AuditClockQualification(qualifiedRef, qualification, retained.retained));
			const capsule: Sc085AdmissionV1 = {
				protocol: "sense-ops-sc085-admission/1",
				runId: intent.runId,
				instruction: intent.instruction,
				owner: identity,
				workload: intent.workload,
				checkpoints: intent.checkpoints,
				clock: {
					id: qualification.admittedClockId,
					qualification: qualifiedRef,
					maxUncertaintyMs: intent.clockRequirement.maxUncertaintyMs,
				},
				observation: intent.observation,
				validity: intent.validity,
				authority: intent.authority,
			};
			const admission = guarded(() => recorder.bytes(canonicalPilotDecision(capsule)));
			const received = guarded(() => receiveSc085Admission(admission, capsule, retained.retained));
			const requested = instruction(initial),
				plan = requested.sc085;
			assert(isPlan2(plan), "SC085_PLAN2_REQUIRED");
			assert(requested.identity.commandRef, "SC085_ORIGINAL_COMMAND");
			joinSc085OriginalAssociation(
				received,
				{
					...requested,
					identity: { ...requested.identity, commandRef: requested.identity.commandRef },
					sc085: {
						admission,
						finalExpectation: plan.finalExpectation,
						failureExpectations: [...plan.failureExpectations],
					},
				},
				{
					...capsule,
					currentWallMs: permission.currentWallMs + Math.ceil(selected.uncertaintyMs),
					holdRemainingMs: intent.validity.maxHoldMs,
					observationRemainingMs: intent.observation.unchangedMs,
					cleanupRemainingMs: selected.cleanupReserveMs,
					grantExpiresWallMs: permission.grantExpiresWallMs,
					cancellation: permission.cancellation,
				},
			);
			const evidence = {
				protocol: "sense-ops-sc085-child-binding/1",
				preflight: plan.preflight,
				admission,
				qualification: qualifiedRef,
				nativeIdentity,
				nativeReceiving: intent.nativeReceiving,
				policy: selected.policy,
				owner: identity,
				permission,
			};
			const binding = guarded(() => recorder.bytes(Buffer.from(`${JSON.stringify(evidence)}\n`)));
			assert.deepEqual(JSON.parse(readRetained(binding).toString("utf8")), evidence, "SC085_BINDING_STORAGE");
			// Publish private bound state only after both byte receiving and native
			// authentication. Failure poisons this once path; caller owns original close.
			// Include retention/qualification costs before publishing the full binding.
			checkSc085Budget(selected, nativePermission(owner, "preflight", intent.nativeReceiving), true);
			receiveCurrentParent("preflight"); // B must finish inside the original bootstrap window.
			// Storage may catch a nested known-route violation. Its original cause
			// still poisons THIS supplier; never publish bound state over that latch.
			sc085Failures.get(result)!.check();
			child = owner;
			store = recorder;
			expectedCapsule = structuredClone(capsule);
			expectedQualification = structuredClone(qualification);
			bound = { primaryWatchId: selected.primaryWatchId, preflight: { ...plan.preflight }, admission, binding };
			stage = "bound";
			recheck("preflight");
			return structuredClone(bound);
		} catch (error) {
			return fail(error);
		}
	});
	return result;
}

export interface Sc085Bound {
	/** Derived from the original admitted instruction.with, never an author field. */
	primaryWatchId: string;
	preflight: RawRef;
	admission: RawRef;
	binding: RawRef;
}
export interface Sc085BootstrapSelection {
	intent: Sc085PreflightIntentV1;
	policy: RawRef;
	clockPolicy: Sc085ClockPolicyV1;
	uncertaintyMs: number;
	application: RawRef;
	receiverInterval: { firstWallMs: number; firstMonotonicMs: number; timeOriginMs: number; deadlineWallMs: number };
}
const sc085Bootstraps = new WeakMap<object, () => Sc085BootstrapSelection>();
const sc085Stores = new WeakMap<object, OperationalHostProviders["recorder"]["retained"]>();
const sc085Compactions = new WeakMap<object, () => ReturnType<typeof receiveOriginalCompactionMethod>>();

export function receiveSc085Compaction(receiving: Sc085OriginalReceiving, owner: OrdinaryOwnerContext) {
	return withSc085Route(receiving, (route) => {
		assert(route.phase === "bound" && route.owner === owner, "SC085_ORIGINAL_BOUND_CHILD_REQUIRED");
		return sc085Compactions.get(route.supplier)!();
	});
}
/** Original provider/receiving composition reads this authenticated selection;
 * the returned detached DATA is not a transferable grant or a new start clock.
 * receiverInterval is the existing supplier's regression guard, NOT an accounting
 * baseline. Original job accounting includes earlier intake and must not reset. */
export function receiveSc085BootstrapSelection(supplier: object): Sc085BootstrapSelection {
	const receive = sc085Bootstraps.get(supplier);
	assert(receive, "SC085_ORIGINAL_SOURCE_SUPPLIER_REQUIRED");
	return receive();
}
/** Source-normalized observation after the ACTUAL Pi permissionAbi1 read and
 * Source operation-specific checks. It is evidence, not a grant or reservation. */
export interface Sc085NativePermission {
	protocol: "sense-ops-sc085-current-permission/1";
	owner: Sc085AdmissionV1["owner"];
	nativeReceiving: Sc085PreflightIntentV1["nativeReceiving"];
	currentWallMs: number;
	grantExpiresWallMs: number;
	remainingMs: number;
	cancellation: "active" | "cancelled";
	counters: Sc085Counters;
}
const sc085Suppliers = new WeakMap<
	object,
	(owner: OrdinaryOwnerContext, recorder: OperationalHostProviders["recorder"], receiveOnly: boolean) => Sc085Bound
>();
declare const receivingBrand: unique symbol;
/** In-process routing/custody only; cannot be constructed from JSON or transfer
 * authority. The original issued supplier remains checked at every receiving. */
export interface Sc085OriginalReceiving {
	readonly [receivingBrand]: true;
}
interface ReceivingRoute {
	supplier: object;
	recorder: OperationalHostProviders["recorder"];
	phase: "prepared" | "entered" | "bound" | "failed";
	owner?: OrdinaryOwnerContext;
}
const sc085Failures = new WeakMap<
	object,
	{ check(): void; fail(error: unknown): never; guarded<T>(action: () => T): T }
>();
/** Synchronous original storage callbacks cannot reenter an authority read. This
 * is a private routing guard, not a cached permission or replacement recorder. */
export function guardSc085OriginalCallback<T>(receiving: Sc085OriginalReceiving, action: () => T): T {
	const route = originalReceivings.get(receiving);
	assert(route, "SC085_ORIGINAL_RECEIVING_PHASE");
	return sc085Failures.get(route.supplier)!.guarded(action);
}
/** Only an already registered supplier can be poisoned. This is internal control
 * flow, not a caller-provided verifier or another authority registry. */
function withSc085Supplier<T>(supplier: object, action: () => T): T {
	const failure = sc085Failures.get(supplier);
	assert(failure, "SC085_ORIGINAL_SOURCE_SUPPLIER_REQUIRED");
	try {
		failure.check();
		const value = action();
		failure.check(); // Also catch a swallowed reentrant violation before return.
		return value;
	} catch (error) {
		return failure.fail(error);
	}
}
function withSc085Route<T>(receiving: Sc085OriginalReceiving, action: (route: ReceivingRoute) => T): T {
	const route = originalReceivings.get(receiving);
	// Unknown handles have no attributable supplier; do NOT poison any other one.
	assert(route, "SC085_ORIGINAL_RECEIVING_PHASE");
	return withSc085Supplier(route.supplier, () => {
		try {
			return action(route);
		} catch (error) {
			route.phase = "failed";
			throw error;
		}
	});
}
const originalReceivings = new WeakMap<Sc085OriginalReceiving, ReceivingRoute>();
const receivingBySupplier = new WeakMap<object, Sc085OriginalReceiving>();
const sc085Checks = new WeakMap<object, (owner: OrdinaryOwnerContext, operation: Operation) => void>();
export interface Sc085QualifiedStamp {
	/** Display rounding error only; exact-ns acceptance does not use monotonicMs. */
	conversionErrorNs: string;
	monotonicNs: string;
	uncertaintyNs: string;
	basis: RawRef;
	guard: RawRef;
	clockId: string;
	monotonicMs: number;
	wallMs: number;
	uncertaintyMs: number;
	raw: RawRef;
	original: RawRef;
	qualification: RawRef;
}
const sc085Qualifications = new WeakMap<
	object,
	(owner: OrdinaryOwnerContext, selector: Sc085StampSelector) => Sc085QualifiedStamp
>();
const sc085BootstrapSamplers = new WeakMap<
	object,
	(recorder: OperationalHostProviders["recorder"]) => Sc085QualifiedStamp
>();
const sc085Closers = new WeakMap<object, () => Promise<void>>();
/** The original adapter's once-close path calls this INSTEAD of context.close.
 * Await the ACTUAL private context close, never a claimed-success boolean. This
 * path must remain available for cleanup even after a prior supplier failure. */
export function closeSc085OriginalChild(receiving: Sc085OriginalReceiving, owner: OrdinaryOwnerContext): Promise<void> {
	const route = originalReceivings.get(receiving);
	assert(route, "SC085_ORIGINAL_RECEIVING_PHASE");
	// Identity of the original B pair, NOT active permission (retirement must stay
	// reachable after revoke/stop). A wrong known pair latches, but cannot close it.
	try {
		assert(route.owner === owner && owner !== undefined, "SC085_ORIGINAL_BOUND_CHILD_REQUIRED");
	} catch (error) {
		return sc085Failures.get(route.supplier)!.fail(error);
	}
	const close = sc085Closers.get(route.supplier);
	assert(close, "SC085_ORIGINAL_SOURCE_SUPPLIER_REQUIRED");
	return close();
}
/** Original accounting supplier, after A and prepare, can qualify current samples
 * BEFORE native creation. Only the registered original handle enters; recorder,
 * selected qualification and original clock are private, never caller parameters.
 * This remains the same sampler after B; it never resets accounting at child bind. */
export function qualifySc085BootstrapStamp(receiving: Sc085OriginalReceiving): Sc085QualifiedStamp {
	return withSc085Route(receiving, (route) => {
		assert(
			route.phase === "prepared" || route.phase === "entered" || route.phase === "bound",
			"SC085_BOOTSTRAP_CLOCK_PHASE",
		);
		return sc085BootstrapSamplers.get(route.supplier)!(route.recorder);
	});
}
/** Original provider factory, after A, prepares exactly one typed third argument
 * for Pi receiving. This carries its EXISTING recorder, never a verifier callback. */
export function prepareSc085OriginalReceiving(
	supplier: object,
	recorder: OperationalHostProviders["recorder"],
): Sc085OriginalReceiving {
	return withSc085Supplier(supplier, () => {
		assert(sc085Suppliers.has(supplier) && !receivingBySupplier.has(supplier), "SC085_ORIGINAL_RECEIVING_ONCE");
		assert(recorder.retained === sc085Stores.get(supplier), "SC085_ORIGINAL_RECORDER");
		receiveSc085BootstrapSelection(supplier);
		const receiving = Object.freeze(Object.create(null)) as Sc085OriginalReceiving;
		originalReceivings.set(receiving, { supplier, recorder, phase: "prepared" });
		receivingBySupplier.set(supplier, receiving);
		return receiving;
	});
}
/** Pi calls BEFORE native creation in its ORIGINAL receiving try block. */
export function enterSc085OriginalReceiving(
	receiving: Sc085OriginalReceiving,
	profilePath: string,
	applicationPath: string,
): Sc085BootstrapSelection {
	return withSc085Route(receiving, (route) => {
		assert(route.phase === "prepared", "SC085_ORIGINAL_RECEIVING_PHASE");
		route.phase = "failed"; // Failed entry cannot be retried/reallocated.
		const selected = receiveSc085BootstrapSelection(route.supplier);
		// Inert root/leaf receiving before B; no four-method readiness award.
		sc085Compactions.get(route.supplier)!();
		assert.equal(profilePath, selected.intent.nativeReceiving.profile.path, "SC085_RECEIVING_PROFILE");
		assert.equal(applicationPath, selected.application.path, "SC085_RECEIVING_APPLICATION");
		sc085Failures.get(route.supplier)!.check();
		route.phase = "entered";
		return selected;
	});
}
/** Original Pi calls after constructing its SAME context, before returning it. */
export function bindSc085OriginalChild(receiving: Sc085OriginalReceiving, owner: OrdinaryOwnerContext): Sc085Bound {
	return withSc085Route(receiving, (route) => {
		assert(route.phase === "entered", "SC085_ORIGINAL_RECEIVING_PHASE");
		route.phase = "failed";
		const bound = sc085Suppliers.get(route.supplier)!(owner, route.recorder, false);
		sc085Failures.get(route.supplier)!.check();
		route.owner = owner;
		route.phase = "bound";
		return bound;
	});
}
/** Original host-facing native.bindSc085Child reads the already-created binding. */
export function receiveSc085ChildBinding(receiving: Sc085OriginalReceiving, owner: OrdinaryOwnerContext): Sc085Bound {
	return withSc085Route(receiving, (route) => {
		assert(route.phase === "bound" && route.owner === owner, "SC085_ORIGINAL_BOUND_CHILD_REQUIRED");
		return sc085Suppliers.get(route.supplier)!(owner, route.recorder, true);
	});
}
export function checkSc085Operation(
	receiving: Sc085OriginalReceiving,
	owner: OrdinaryOwnerContext,
	operation: Operation,
): void {
	withSc085Route(receiving, (route) => {
		assert(route.phase === "bound" && route.owner === owner, "SC085_ORIGINAL_BOUND_CHILD_REQUIRED");
		sc085Checks.get(route.supplier)!(owner, operation);
	});
}
/** Storage-only access for original Pi setup/hold evidence AFTER authenticated B.
 * Returns the SAME recorder; it neither qualifies data nor grants permission. */
export function receiveSc085OriginalStorage(
	receiving: Sc085OriginalReceiving,
	owner: OrdinaryOwnerContext,
): OperationalHostProviders["recorder"] {
	return withSc085Route(receiving, (route) => {
		assert(route.phase === "bound" && route.owner === owner, "SC085_ORIGINAL_BOUND_CHILD_REQUIRED");
		sc085Checks.get(route.supplier)!(owner, "boundary");
		return route.recorder;
	});
}
/** Selector-only private qualified consumer: no numeric timestamp argument and
 * no caller-supplied expected qualification, binding or evidence recorder. */
export function qualifySc085OriginalStamp(
	receiving: Sc085OriginalReceiving,
	owner: OrdinaryOwnerContext,
	selector: Sc085StampSelector,
): Sc085QualifiedStamp {
	return withSc085Route(receiving, (route) => {
		assert(route.phase === "bound" && route.owner === owner, "SC085_ORIGINAL_BOUND_CHILD_REQUIRED");
		return sc085Qualifications.get(route.supplier)!(owner, selector);
	});
}
function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "SC085_POLICY_OBJECT");
	assert.deepEqual(Object.keys(value).sort(), names.split(" ").sort(), "SC085_POLICY_FIELDS");
}
function safe(value: unknown): asserts value is number {
	assert(
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0),
		"SC085_POLICY_INTEGER",
	);
}
function isPlan2(plan: OperationalHostInstruction["sc085"]): plan is Sc085PreflightPlan {
	return !!plan && "protocol" in plan && plan.protocol === "sense-ops-sc085-plan/2";
}
export interface Sc085Counters {
	automaticRemaining: number;
	inferenceRemaining: number;
	countRemaining: number;
	operationRemaining: number;
	launchRemaining: number;
}
/** Labels describe the existing host/Core callsites, not future-turn promises.
 * Automatic enrollment/spend remains the original Pi once gate, even for request. */
export function sc085OperationRequirements(operation: Operation, countConfigured: boolean): Sc085Counters {
	const required = {
		automaticRemaining: 0,
		inferenceRemaining: 0,
		countRemaining: 0,
		operationRemaining: 0,
		launchRemaining: 0,
	};
	switch (operation) {
		case "preflight":
		case "configure":
		case "burst":
		case "boundary":
			break;
		case "request":
			required.inferenceRemaining = 1;
			required.operationRemaining = 1;
			required.countRemaining = countConfigured ? 1 : 0;
			break;
		case "refresh":
			required.launchRemaining = 1;
			break;
		default:
			throw new Error("SC085_PERMISSION_OPERATION");
	}
	return required;
}
function nativePermission(
	owner: OrdinaryOwnerContext,
	operation: Operation,
	expectedNative: Sc085PreflightIntentV1["nativeReceiving"],
): Sc085NativePermission {
	assertOrdinaryOwner(owner);
	const value = OrdinaryOwnerContext.prototype.inspectCurrentPermission.call(owner);
	fields(
		value,
		"automaticRemaining inferenceRemaining countRemaining operationRemaining launchRemaining currentWallMs grantExpiresWallMs remainingMs ownerEpoch sessionId allocationId",
	);
	for (const key of [
		"automaticRemaining",
		"inferenceRemaining",
		"countRemaining",
		"operationRemaining",
		"launchRemaining",
		"currentWallMs",
		"grantExpiresWallMs",
		"remainingMs",
	] as const)
		safe(value[key]);
	const identity = {
		ownerEpoch: owner.owner.grant,
		sessionId: owner.owner.sessionId,
		allocationId: owner.decision.allocation.id,
	};
	assert.deepEqual(
		{ ownerEpoch: value.ownerEpoch, sessionId: value.sessionId, allocationId: value.allocationId },
		identity,
		"SC085_NATIVE_PERMISSION_IDENTITY",
	);
	assert.equal(owner.decision.digest, expectedNative.decision.sha256, "SC085_NATIVE_ORIGINAL_DECISION");
	assert.equal(owner.profilePath, expectedNative.profile.path, "SC085_NATIVE_ORIGINAL_PROFILE_PATH");
	assert.equal(
		owner.decision.record.profileSha256,
		expectedNative.profile.sha256,
		"SC085_NATIVE_ORIGINAL_PROFILE_PIN",
	);
	assert.equal(
		owner.decision.record.receiving.path,
		expectedNative.receiving.path,
		"SC085_NATIVE_ORIGINAL_RECEIVING_PATH",
	);
	const requirements = sc085OperationRequirements(operation, !!owner.decision.record.provider.count);
	const counters = {} as Sc085Counters;
	for (const key of Object.keys(requirements) as Array<keyof Sc085Counters>) {
		assert(value[key] >= requirements[key], `SC085_NATIVE_REMAINING_${key}`);
		counters[key] = value[key];
	}
	assertOrdinaryOwner(owner);
	// "active" is derived ONLY from the original native inspection's successful
	// stop/holder/admission/expiry checks, never from a supplied cancellation flag.
	return {
		protocol: "sense-ops-sc085-current-permission/1",
		owner: identity,
		nativeReceiving: structuredClone(expectedNative),
		currentWallMs: value.currentWallMs,
		grantExpiresWallMs: value.grantExpiresWallMs,
		remainingMs: value.remainingMs,
		cancellation: "active",
		counters,
	};
}
/** This format is an externally issued policy operand, NOT a new issuer. It is
 * reachable only through the existing original operational_binding.policy pin.
 * Caller instruction/plan bytes are compared later, never used as expected. */
export interface Sc085IssuedPolicyV1 {
	protocol: "sense-ops-sc085-issued-policy/1";
	intent: Sc085PreflightIntentV1;
	bootstrap: readonly ["accounting", "native-receive"];
	cleanupReserveMs: number;
}
/** Original policy selects this ref through intent.clockRequirement. Decimal
 * text preserves the external qualified uncertainty within the existing canonical
 * envelope. The explicit instance selector binds the ACTUAL original runtime at B,
 * rather than pre-pinning a future timeOrigin or inventing an epoch. */
export interface Sc085ClockPolicyV1 {
	protocol: "sense-ops-sc085-clock-policy/1";
	source: "node:perf_hooks.performance";
	sourceIdentity: RawRef;
	instance: "same-original-runtime";
	admittedClockId: string;
	uncertaintyMs: string | null;
	validity: { notBeforeWallMs: number; expiresWallMs: number };
}
/** DATA correspondence only; the enclosing supplier authenticates instruction and
 * intent bytes before this selection. Preserve every peer, independent of order. */
export function selectSc085PrimaryWatch(
	controls: readonly unknown[],
	checkpoints: Sc085AdmissionV1["checkpoints"],
): string {
	assert([1, 8].includes(controls.length), "SC085_CONTROL_COHORT");
	const watches = controls.map((control) => {
		assert(control !== null && typeof control === "object" && !Array.isArray(control), "SC085_CONTROL_WATCH");
		const value = control as Record<string, unknown>;
		assert(
			value.op === "watch" &&
				typeof value.id === "string" &&
				value.id.length > 0 &&
				typeof value.source === "string" &&
				value.source.length > 0 &&
				(value.wake === "change" || value.wake === "never"),
			"SC085_CONTROL_WATCH",
		);
		if (controls.length === 8) assert(value.every === "1s", "SC085_CONTROL_CADENCE");
		return value;
	});
	if (controls.length === 8) {
		const selectedSource = watches.find((watch) => watch.wake === "change");
		assert(selectedSource, "SC085_UNIQUE_PRIMARY");
		fields(selectedSource.input, "path");
		assert(
			typeof selectedSource.input.path === "string" && selectedSource.input.path.length > 0,
			"SC085_CONTROL_INPUT",
		);
		for (const watch of watches) {
			assert.equal(watch.source, selectedSource.source, "SC085_CONTROL_SOURCE");
			assert.deepEqual(watch.input, selectedSource.input, "SC085_CONTROL_INPUT");
		}
	}
	const ids = watches.map((watch) => watch.id as string);
	assert(new Set(ids).size === ids.length, "SC085_CONTROL_DUPLICATE");
	const primary = watches.filter((watch) => watch.wake === "change");
	assert(primary.length === 1, "SC085_UNIQUE_PRIMARY");
	for (const checkpoint of checkpoints)
		assert.deepEqual(
			checkpoint.watches.map((watch) => watch.watchId).sort(),
			[...ids].sort(),
			"SC085_CONTROL_EXPECTATIONS",
		);
	return primary[0].id as string;
}

function selectSc085(
	binding: OperationalBinding,
	inputs: OperationalAdmissionInputs,
	firstWall: number,
	issuedGrant: { notBeforeWallMs: number; expiresWallMs: number },
	reserve = true,
) {
	// receiveTuple authenticates the ENTIRE policy through the pinned original CI
	// helper before this call. Keep its full raw ref; never accept a detached intent
	// or rehash these four operands as a replacement policy. CI metadata stays in
	// the same retained canonical document and original issuance joins.
	const document = parseCanonicalPilotDecision(sc085RetainedBytes(binding.policy, inputs.retained));
	assert(document !== null && typeof document === "object" && !Array.isArray(document), "SC085_POLICY_OBJECT");
	const policy = document as Record<string, unknown>;
	for (const name of ["protocol", "intent", "bootstrap", "cleanupReserveMs"])
		assert(Object.hasOwn(policy, name), "SC085_POLICY_FIELDS");
	const selected = {
		protocol: policy.protocol,
		intent: policy.intent,
		bootstrap: policy.bootstrap,
		cleanupReserveMs: policy.cleanupReserveMs,
	};
	assert.equal(selected.protocol, "sense-ops-sc085-issued-policy/1", "SC085_ORIGINAL_POLICY_UNAVAILABLE");
	assert.deepEqual(selected.bootstrap, ["accounting", "native-receive"], "SC085_BOOTSTRAP_PERMISSION");
	safe(selected.cleanupReserveMs);
	assert(selected.cleanupReserveMs > 0, "SC085_CLEANUP_RESERVE");
	// This expected value originates in ORIGINAL CI's independently selected policy,
	// never from the requested capsule, plan or a callback.
	const expected = parseSc085PreflightIntent(canonicalPilotDecision(selected.intent));
	const requested = instruction(bytes(inputs.instruction)),
		plan = requested.sc085;
	assert(isPlan2(plan), "SC085_PLAN2_REQUIRED");
	fields(plan, "protocol preflight finalExpectation failureExpectations");
	const intent = receiveSc085PreflightIntent(plan.preflight, expected, inputs.retained);
	const native = parseOrdinaryOwnerRecord(bytes(inputs.decision));
	assert.equal(intent.allocationId, native.admission.allocation.id, "SC085_PREFLIGHT_ALLOCATION");
	// The pinned original helper authenticates this immutable policy's phase-plan
	// deadline. The short release/start window is not the operational lifetime.
	assert(
		intent.validity.notBeforeWallMs >=
			Math.max(issuedGrant.notBeforeWallMs, native.admission.allocation.notBeforeMs) &&
			intent.validity.expiresWallMs <= native.admission.allocation.expiresMs,
		"SC085_ORIGINAL_GRANT_WINDOW",
	);
	// compiledReceiving selects a producer-management result, not native owner
	// receiving. The full fourth Ref remains bound by the original wrapper/policy.
	assertOriginalCINativeBinding(binding.native);
	assert.deepEqual(
		intent.nativeReceiving,
		{ decision: binding.native.decision, receiving: binding.native.receiving, profile: binding.native.profile },
		"SC085_PREFLIGHT_NATIVE",
	);
	assert.equal(intent.runId, binding.operational_run_id, "SC085_PREFLIGHT_RUN");
	assert.deepEqual(intent.instruction.command, requested.identity.commandRef, "SC085_PREFLIGHT_COMMAND");
	assert.deepEqual(intent.workload, requested.production?.source?.workload, "SC085_PREFLIGHT_WORKLOAD");
	assert.deepEqual(
		intent.checkpoints,
		[plan.finalExpectation, ...plan.failureExpectations],
		"SC085_PREFLIGHT_CHECKPOINTS",
	);
	const clockValue = parseCanonicalPilotDecision(
		sc085RetainedBytes(intent.clockRequirement.qualificationPolicy, inputs.retained),
	);
	fields(clockValue, "protocol source sourceIdentity instance admittedClockId uncertaintyMs validity");
	assert.equal(clockValue.protocol, "sense-ops-sc085-clock-policy/1", "SC085_CLOCK_POLICY_UNAVAILABLE");
	assert.equal(clockValue.source, "node:perf_hooks.performance", "SC085_CLOCK_POLICY_SOURCE");
	assert(
		typeof clockValue.admittedClockId === "string" && clockValue.admittedClockId.length > 0,
		"SC085_CLOCK_POLICY_ID",
	);
	sc085RetainedBytes(clockValue.sourceIdentity as RawRef, inputs.retained);
	assert.equal(clockValue.instance, "same-original-runtime", "SC085_CLOCK_POLICY_INSTANCE");
	assert.deepEqual(clockValue.sourceIdentity, binding.native.profile, "SC085_QUALIFIED_ORIGINAL_SOURCE_IDENTITY");
	assert(
		typeof clockValue.uncertaintyMs === "string" && clockValue.uncertaintyMs.length > 0,
		"SC085_CLOCK_UNQUALIFIED",
	);
	const uncertaintyMs = Number(clockValue.uncertaintyMs);
	assert(
		Number.isFinite(uncertaintyMs) &&
			uncertaintyMs >= 0 &&
			!Object.is(uncertaintyMs, -0) &&
			String(uncertaintyMs) === clockValue.uncertaintyMs &&
			uncertaintyMs <= intent.clockRequirement.maxUncertaintyMs,
		"SC085_CLOCK_QUALIFIED_BOUND",
	);
	const uncertaintyBudgetMs = Math.ceil(uncertaintyMs);
	fields(clockValue.validity, "notBeforeWallMs expiresWallMs");
	safe(clockValue.validity.notBeforeWallMs);
	safe(clockValue.validity.expiresWallMs);
	assert(
		clockValue.validity.notBeforeWallMs <= Math.min(firstWall, issuedGrant.notBeforeWallMs) - uncertaintyBudgetMs &&
			clockValue.validity.expiresWallMs > firstWall + uncertaintyBudgetMs,
		"SC085_ORIGINAL_CLOCK_COVERAGE",
	);
	const now = Date.now();
	assert(
		now - uncertaintyBudgetMs >= Math.max(intent.validity.notBeforeWallMs, clockValue.validity.notBeforeWallMs) &&
			now + uncertaintyBudgetMs < Math.min(intent.validity.expiresWallMs, clockValue.validity.expiresWallMs),
		"SC085_POLICY_EXPIRED",
	);
	const required = intent.validity.maxHoldMs + intent.observation.unchangedMs + selected.cleanupReserveMs;
	safe(required);
	if (reserve)
		assert(
			Math.min(
				intent.validity.expiresWallMs,
				clockValue.validity.expiresWallMs,
				native.admission.allocation.expiresMs,
			) -
				(now + uncertaintyBudgetMs) >=
				required,
			"SC085_BOOTSTRAP_NO_FIT",
		);
	return {
		primaryWatchId: selectSc085PrimaryWatch(requested.with, intent.checkpoints),
		policy: { ...binding.policy },
		intent,
		clock: structuredClone(clockValue) as unknown as Sc085ClockPolicyV1,
		uncertaintyMs,
		cleanupReserveMs: selected.cleanupReserveMs as number,
	};
}
function checkSc085Budget(selected: ReturnType<typeof selectSc085>, permission: Sc085NativePermission, reserve = true) {
	// Reserve the complete phase budget at A/B, not anew after every consumed phase.
	// Thereafter the original native predicate checks its actual current allowance.
	const required = reserve
		? selected.intent.validity.maxHoldMs + selected.intent.observation.unchangedMs + selected.cleanupReserveMs
		: 0;
	safe(required);
	const end = Math.min(
		selected.intent.validity.expiresWallMs,
		selected.clock.validity.expiresWallMs,
		permission.grantExpiresWallMs,
	);
	const uncertaintyBudgetMs = Math.ceil(selected.uncertaintyMs);
	assert(
		permission.currentWallMs - uncertaintyBudgetMs >=
			Math.max(selected.intent.validity.notBeforeWallMs, selected.clock.validity.notBeforeWallMs),
		"SC085_NATIVE_NOT_YET_VALID",
	);
	assert(
		end > permission.currentWallMs + uncertaintyBudgetMs &&
			end - (permission.currentWallMs + uncertaintyBudgetMs) >= required &&
			permission.remainingMs >= required + uncertaintyBudgetMs,
		"SC085_NATIVE_NO_FIT",
	);
}
