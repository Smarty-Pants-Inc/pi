import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	canonicalPilotDecision,
	parseCanonicalPilotDecision,
} from "./references/sense/src/adapters/codex/pilot-canonical.ts";
import type { BurstExpectation, RawRef, Sc085Plan } from "./source-contracts.ts";

export interface Sc085PreflightIntentV1 {
	protocol: "sense-ops-sc085-preflight/1";
	runId: string;
	instruction: Sc085AdmissionV1["instruction"];
	allocationId: string;
	nativeReceiving: { decision: RawRef; receiving: RawRef; profile: RawRef };
	workload: RawRef;
	checkpoints: Sc085AdmissionV1["checkpoints"];
	clockRequirement: { qualificationPolicy: RawRef; maxUncertaintyMs: number };
	observation: Sc085AdmissionV1["observation"];
	validity: Sc085AdmissionV1["validity"];
	authority: Sc085AdmissionV1["authority"];
}
export interface Sc085AuditClockQualificationV1 {
	protocol: "sense-ops-sc085-audit-clock/1";
	owner: Sc085AdmissionV1["owner"];
	admittedClockId: string;
	nativeIdentity: RawRef;
	source: "node:perf_hooks.performance";
	sourceIdentity: RawRef;
	mapping: { kind: "same-original-source"; nativeClockId: string; uncertaintyMs: number | null };
	validity: { notBeforeWallMs: number; expiresWallMs: number };
}

/** Agreed capsule DATA. This type/parser never constructs authority or a hold. */
export interface Sc085AdmissionV1 {
	protocol: "sense-ops-sc085-admission/1";
	runId: string;
	instruction: { id: string; command: RawRef };
	owner: { ownerEpoch: string; sessionId: string; allocationId: string };
	workload: RawRef;
	checkpoints: [BurstExpectation, BurstExpectation, BurstExpectation, BurstExpectation, BurstExpectation];
	clock: { id: string; qualification: RawRef; maxUncertaintyMs: number };
	observation: { anchor: "accepted-final-exposure"; unchangedMs: number };
	validity: { notBeforeWallMs: number; expiresWallMs: number; maxHoldMs: number };
	authority: { grant: RawRef; scope: RawRef; limits: RawRef; cancellation: RawRef };
}

/** PRIVATE facts from the original grant/native/clock receiving context, not a
 * sibling JSON file or values inferred from this capsule. Passing an object to
 * a pure join does NOT authenticate these facts or expose native methods. */
export interface Sc085OriginalAssociation {
	owner: Sc085AdmissionV1["owner"]; // Actual CHILD OwnerContext/lease, never parent accounting epoch.
	runId: string;
	instruction: Sc085AdmissionV1["instruction"]; // Issued identity and retained original command, not instruction self-hash.
	workload: RawRef;
	checkpoints: Sc085AdmissionV1["checkpoints"];
	clock: Sc085AdmissionV1["clock"];
	observation: Sc085AdmissionV1["observation"];
	validity: Sc085AdmissionV1["validity"];
	authority: Sc085AdmissionV1["authority"];
	currentWallMs: number; // Qualified original clock observation, not Date.now fallback.
	holdRemainingMs: number; // Preflight reserves the complete admitted maximum hold.
	observationRemainingMs: number;
	cleanupRemainingMs: number;
	grantExpiresWallMs: number;
	cancellation: "active" | "cancelled";
}
export interface Sc085InstructionAssociation {
	runId: string;
	identity: { commandRef: RawRef };
	production?: { source?: { workload: RawRef } };
	sc085?: Sc085Plan;
}

const sha = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
const FINAL = "Build: changed; source revision: sc085-1000.\n";
const DIAGNOSTIC = "build-status: status must contain 1-1024 bytes\n";
function object(value: unknown, keys: string): asserts value is Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "SC085_OBJECT");
	assert.deepEqual(Object.keys(value).sort(), keys.split(" ").sort(), "SC085_FIELDS");
}
function text(value: unknown): asserts value is string {
	assert(typeof value === "string" && value.length > 0, "SC085_TEXT");
}
function integer(value: unknown, positive = false): asserts value is number {
	assert(
		typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= (positive ? 1 : 0),
		"SC085_SAFE_INTEGER",
	);
}
function reference(value: unknown): asserts value is RawRef {
	object(value, "path sha256");
	text(value.path);
	assert(typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256), "SC085_REF");
}
function validateCommon(value: Record<string, unknown>): void {
	text(value.runId);
	object(value.instruction, "id command");
	text(value.instruction.id);
	reference(value.instruction.command);
	reference(value.workload);
	object(value.observation, "anchor unchangedMs");
	assert.equal(value.observation.anchor, "accepted-final-exposure", "SC085_ANCHOR");
	integer(value.observation.unchangedMs, true);
	object(value.validity, "notBeforeWallMs expiresWallMs maxHoldMs");
	integer(value.validity.notBeforeWallMs);
	integer(value.validity.expiresWallMs);
	integer(value.validity.maxHoldMs, true);
	assert(value.validity.expiresWallMs > value.validity.notBeforeWallMs, "SC085_VALIDITY");
	object(value.authority, "grant scope limits cancellation");
	Object.values(value.authority).forEach(reference);
	assert(Array.isArray(value.checkpoints) && value.checkpoints.length === 5, "SC085_CHECKPOINT_COUNT");
	const checkpoints: unknown[] = value.checkpoints;
	let first: Record<string, unknown> | undefined;
	for (const [index, checkpoint] of checkpoints.entries()) {
		object(checkpoint, "change sourceSha256 sourceBytes watches");
		integer(checkpoint.change);
		assert.equal(checkpoint.change, 1000 + index, "SC085_CHECKPOINT_ORDER");
		integer(checkpoint.sourceBytes);
		const payload = index === 1 ? "" : index === 3 ? `${"X".repeat(1025)}\n` : FINAL;
		assert.equal(checkpoint.sourceBytes, Buffer.byteLength(payload), "SC085_SOURCE_BYTES");
		assert.equal(checkpoint.sourceSha256, sha(Buffer.from(payload)), "SC085_CONFORMANCE_HASH");
		assert(Array.isArray(checkpoint.watches) && checkpoint.watches.length === 1, "SC085_SINGLE_WATCH");
		const watch: unknown = checkpoint.watches[0];
		object(watch, "watchId executionKey stateNamespace outcome body diagnostic");
		text(watch.watchId);
		text(watch.executionKey);
		if (typeof watch.stateNamespace === "string") text(watch.stateNamespace);
		else {
			object(watch.stateNamespace, "kind");
			assert.equal(watch.stateNamespace.kind, "original-setup", "SC085_NAMESPACE_SELECTOR");
		}
		const invalid = index === 1 || index === 3;
		assert.equal(watch.outcome, invalid ? "EXIT_NONZERO" : "OK", "SC085_OUTCOME");
		assert.equal(watch.body, invalid ? "" : FINAL.trim(), "SC085_BODY");
		assert.equal(watch.diagnostic, invalid ? DIAGNOSTIC : null, "SC085_DIAGNOSTIC");
		first ??= watch;
		assert(watch.watchId === first.watchId && watch.executionKey === first.executionKey, "SC085_WATCH_REBOUND");
		assert.deepEqual(watch.stateNamespace, first.stateNamespace, "SC085_NAMESPACE_REBOUND");
	}
}

function validate(value: unknown): asserts value is Sc085AdmissionV1 {
	object(value, "protocol runId instruction owner workload checkpoints clock observation validity authority");
	assert.equal(value.protocol, "sense-ops-sc085-admission/1", "SC085_PROTOCOL");
	validateCommon(value);
	object(value.owner, "ownerEpoch sessionId allocationId");
	Object.values(value.owner).forEach(text);
	object(value.clock, "id qualification maxUncertaintyMs");
	text(value.clock.id);
	reference(value.clock.qualification);
	integer(value.clock.maxUncertaintyMs);
}

export function parseSc085PreflightIntent(raw: Uint8Array): Sc085PreflightIntentV1 {
	const value = parseCanonicalPilotDecision(raw);
	object(
		value,
		"protocol runId instruction allocationId nativeReceiving workload checkpoints clockRequirement observation validity authority",
	);
	assert.equal(value.protocol, "sense-ops-sc085-preflight/1", "SC085_PREFLIGHT_PROTOCOL");
	validateCommon(value);
	text(value.allocationId);
	object(value.nativeReceiving, "decision receiving profile");
	Object.values(value.nativeReceiving).forEach(reference);
	object(value.clockRequirement, "qualificationPolicy maxUncertaintyMs");
	reference(value.clockRequirement.qualificationPolicy);
	integer(value.clockRequirement.maxUncertaintyMs);
	return structuredClone(value) as unknown as Sc085PreflightIntentV1;
}
function validateQualification(value: unknown): asserts value is Sc085AuditClockQualificationV1 {
	object(value, "protocol owner admittedClockId nativeIdentity source sourceIdentity mapping validity");
	assert.equal(value.protocol, "sense-ops-sc085-audit-clock/1", "SC085_CLOCK_PROTOCOL");
	object(value.owner, "ownerEpoch sessionId allocationId");
	Object.values(value.owner).forEach(text);
	text(value.admittedClockId);
	reference(value.nativeIdentity);
	reference(value.sourceIdentity);
	assert.equal(value.source, "node:perf_hooks.performance", "SC085_CLOCK_SOURCE");
	object(value.mapping, "kind nativeClockId uncertaintyMs");
	assert.equal(value.mapping.kind, "same-original-source", "SC085_CLOCK_MAPPING");
	text(value.mapping.nativeClockId);
	const u = value.mapping.uncertaintyMs;
	assert(
		u === null || (typeof u === "number" && Number.isFinite(u) && u >= 0 && !Object.is(u, -0)),
		"SC085_CLOCK_UNCERTAINTY",
	);
	object(value.validity, "notBeforeWallMs expiresWallMs");
	integer(value.validity.notBeforeWallMs);
	integer(value.validity.expiresWallMs);
	assert(value.validity.expiresWallMs > value.validity.notBeforeWallMs, "SC085_CLOCK_VALIDITY");
}
/** Reuse the existing canonical recipe; only the agreed uncertainty scalar has a
 * finite fractional numeric domain. Native timeOrigin/stamps remain raw refs. */
export function canonicalSc085AuditClockQualification(value: Sc085AuditClockQualificationV1): Buffer {
	validateQualification(value);
	const base = canonicalPilotDecision({ ...value, mapping: { ...value.mapping, uncertaintyMs: null } });
	const raw = Buffer.from(
		base
			.toString("utf8")
			.replace('"uncertaintyMs":null', `"uncertaintyMs":${JSON.stringify(value.mapping.uncertaintyMs)}`),
	);
	assert(raw.length <= 65536, "SC085_CLOCK_BOUND");
	return raw;
}
export function parseSc085AuditClockQualification(raw: Uint8Array): Sc085AuditClockQualificationV1 {
	assert(raw.byteLength > 0 && raw.byteLength <= 65536, "SC085_CLOCK_BOUND");
	const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw));
	validateQualification(value);
	assert(canonicalSc085AuditClockQualification(value).equals(raw), "SC085_CLOCK_CANONICAL");
	return structuredClone(value);
}
export function sc085RetainedBytes(ref: RawRef, retained: ReadonlyMap<string, Uint8Array>, bound = 65536): Buffer {
	reference(ref);
	const held = retained.get(ref.path);
	assert(held && held.byteLength > 0 && held.byteLength <= bound, "SC085_ORIGINAL_REF_NOT_RETAINED");
	const raw = Buffer.from(held);
	assert.equal(sha(raw), ref.sha256, "SC085_ORIGINAL_REF_PIN");
	return raw;
}
export function receiveSc085PreflightIntent(
	ref: RawRef,
	expected: Sc085PreflightIntentV1 | undefined,
	retained: ReadonlyMap<string, Uint8Array>,
): Sc085PreflightIntentV1 {
	assert(expected !== undefined, "SC085_INDEPENDENT_INTENT_UNAVAILABLE");
	const independent = parseSc085PreflightIntent(canonicalPilotDecision(expected));
	const value = parseSc085PreflightIntent(sc085RetainedBytes(ref, retained));
	assert.deepEqual(value, independent, "SC085_INDEPENDENT_INTENT_MISMATCH");
	for (const item of [
		value.instruction.command,
		value.workload,
		value.clockRequirement.qualificationPolicy,
		...Object.values(value.nativeReceiving),
		...Object.values(value.authority),
	])
		sc085RetainedBytes(item, retained);
	return value;
}
export function receiveSc085AuditClockQualification(
	ref: RawRef,
	expected: Sc085AuditClockQualificationV1 | undefined,
	retained: ReadonlyMap<string, Uint8Array>,
): Sc085AuditClockQualificationV1 {
	assert(expected !== undefined, "SC085_INDEPENDENT_CLOCK_UNAVAILABLE");
	const independent = parseSc085AuditClockQualification(canonicalSc085AuditClockQualification(expected));
	const value = parseSc085AuditClockQualification(sc085RetainedBytes(ref, retained));
	assert.deepEqual(value, independent, "SC085_INDEPENDENT_CLOCK_MISMATCH");
	sc085RetainedBytes(value.nativeIdentity, retained);
	sc085RetainedBytes(value.sourceIdentity, retained);
	assert(value.mapping.uncertaintyMs !== null, "SC085_CLOCK_UNQUALIFIED");
	return value;
}

/** Canonical UTF8 scalar-key-sort JSON + LF; exact schema and <=65536 bytes.
 * Fixed conformance constants are workload semantics, NOT grants/clock defaults. */
export function parseSc085Admission(raw: Uint8Array): Sc085AdmissionV1 {
	const value = parseCanonicalPilotDecision(raw);
	validate(value);
	return structuredClone(value);
}

/** Correspondence only. `independentlyAdmittedExpected` must come from the original
 * PRIVATE admitted context. No path opens, sibling JSON, issuer or verifier callback.
 * Missing independent selection refuses even when all capsule hashes are valid. */
export function receiveSc085Admission(
	ref: RawRef,
	independentlyAdmittedExpected: Sc085AdmissionV1 | undefined,
	originalRetained: ReadonlyMap<string, Uint8Array>,
): Sc085AdmissionV1 {
	assert(independentlyAdmittedExpected !== undefined, "SC085_INDEPENDENT_EXPECTATION_UNAVAILABLE");
	// Canonicalize expected DATA too, rejecting unknown keys/numbers/prototypes.
	const expected = parseSc085Admission(canonicalPilotDecision(independentlyAdmittedExpected));
	reference(ref);
	const held = originalRetained.get(ref.path);
	assert(held && held.byteLength <= 65536, "SC085_ADMISSION_NOT_RETAINED");
	const raw = Buffer.from(held);
	assert.equal(sha(raw), ref.sha256, "SC085_ADMISSION_PIN");
	const received = parseSc085Admission(raw);
	assert.deepEqual(received, expected, "SC085_INDEPENDENT_EXPECTATION_MISMATCH");
	const refs = [
		received.instruction.command,
		received.workload,
		received.clock.qualification,
		...Object.values(received.authority),
	];
	for (const source of refs) {
		const original = originalRetained.get(source.path);
		assert(original && sha(original) === source.sha256, "SC085_ORIGINAL_REF_NOT_RETAINED");
	}
	// No original/native capability is created or cached by this return.
	return structuredClone(received);
}

/** Join independent capsule selection to the ACTUAL original native and issued
 * context and the requested plan. This pure function cannot authenticate objects;
 * original grant/current permission checks remain enclosing-path obligations. */
export function joinSc085OriginalAssociation(
	admission: Sc085AdmissionV1,
	input: Sc085InstructionAssociation,
	original: Sc085OriginalAssociation | undefined,
): Sc085AdmissionV1 {
	assert(original !== undefined, "SC085_ORIGINAL_NATIVE_CONTEXT_UNAVAILABLE");
	validate(admission);
	assert(input.sc085 && input.production?.source, "SC085_PLAN_REQUIRED");
	assert.equal(admission.runId, input.runId, "SC085_INPUT_RUN");
	assert.deepEqual(admission.instruction.command, input.identity.commandRef, "SC085_ORIGINAL_COMMAND");
	assert.deepEqual(admission.workload, input.production.source.workload, "SC085_INPUT_WORKLOAD");
	assert.deepEqual(
		admission.checkpoints,
		[input.sc085.finalExpectation, ...input.sc085.failureExpectations],
		"SC085_PLAN_EXPECTATIONS",
	);
	for (const key of [
		"owner",
		"runId",
		"instruction",
		"workload",
		"checkpoints",
		"clock",
		"observation",
		"validity",
		"authority",
	] as const)
		assert.deepEqual(admission[key], original[key], `SC085_ORIGINAL_${key}`);
	for (const key of [
		"currentWallMs",
		"holdRemainingMs",
		"observationRemainingMs",
		"cleanupRemainingMs",
		"grantExpiresWallMs",
	] as const)
		integer(original[key]);
	assert.equal(original.cancellation, "active", "SC085_CANCELLED");
	assert(original.currentWallMs >= admission.validity.notBeforeWallMs, "SC085_NOT_YET_VALID");
	assert(
		original.holdRemainingMs === admission.validity.maxHoldMs &&
			original.observationRemainingMs >= admission.observation.unchangedMs,
		"SC085_ORIGINAL_PHASE_LIMITS",
	);
	const required = original.holdRemainingMs + original.observationRemainingMs + original.cleanupRemainingMs;
	integer(required, true);
	const end = Math.min(admission.validity.expiresWallMs, original.grantExpiresWallMs);
	assert(end > original.currentWallMs && end - original.currentWallMs >= required, "SC085_REMAINING_VALIDITY");
	return structuredClone(admission);
}
