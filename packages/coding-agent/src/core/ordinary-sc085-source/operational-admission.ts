import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ordinaryClock } from "../ordinary-clock.ts";
import { OrdinaryOperationalAudit, type Sc085StampSelector } from "../ordinary-operational-audit.ts";
import { assertOrdinaryOwner, OrdinaryOwnerContext } from "../ordinary-owner-context.ts";
import {
	type OperationalBinding,
	type OriginalCISelection,
	type ReceivedCIData,
	receiveOriginalCIAuthorization,
} from "./ci-authority.ts";
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
	type Sc085AuditClockQualificationV1,
	type Sc085PreflightIntentV1,
	sc085RetainedBytes,
} from "./sc085-admission.ts";
import type {
	SourceOperationalInstruction as FoundationInstruction,
	HeldOperationalFile,
	SourceAdmissionPorts as OperationalHostProviders,
	OpsBinding as PreviousOpsBinding,
} from "./source-contracts.ts";

type OpsBinding = PreviousOpsBinding | "source-diagnostics";

import { parseOrdinaryOwnerReceiving, parseOrdinaryOwnerRecord } from "../ordinary-owner-policy.ts";
import { parseOwnerHostProfile } from "../owner-profile.ts";
import {
	canonicalPilotDecision,
	parseCanonicalPilotDecision,
} from "./references/sense/src/adapters/codex/pilot-canonical.ts";

type RawRef = FoundationInstruction["providerModule"];
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
/** Existing93fa protected file handle, acquired by the trusted provider composition.
 * Caller retains/checks/closes these original handles; this supplier never reopens
 * a path, consumes a once instruction, issues or activates a native allocation. */
export interface HeldOperationalRecord {
	readonly ref: RawRef;
	readonly held: HeldOperationalFile;
}
export interface OperationalAdmissionInputs {
	readonly authority: OriginalCISelection;
	readonly producerContract: HeldOperationalRecord;
	readonly instruction: HeldOperationalRecord;
	readonly decision: HeldOperationalRecord;
	readonly receiving: HeldOperationalRecord;
	readonly profile: HeldOperationalRecord;
	readonly producers: ReadonlyMap<OpsBinding, HeldOperationalRecord>;
	readonly retained: OperationalHostProviders["recorder"]["retained"];
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
	inputs: OperationalAdmissionInputs,
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
			now < auth.expires_at * 1000 &&
			auth.expires_at > auth.issued_at &&
			auth.expires_at - auth.issued_at <= 600,
		"OPS_CI_EXPIRED",
	);
	return structuredClone(binding);
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
	preflightSc085(input: OperationalHostInstruction, originalBytes: Uint8Array): Promise<void>;
	receiveFdSlotPreflight(): IndependentlyAdmittedFdSlotPreflight;
	receiveFdSlotBoundExpectation(): IndependentlyAdmittedFdSlotExpectation;
} {
	const hold = (r: HeldOperationalRecord): HeldOperationalRecord => ({ ref: { ...r.ref }, held: r.held });
	const retained: OperationalAdmissionInputs = {
		authority: freeze(structuredClone(inputs.authority)),
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
	const receiveTuple = (operation: Operation, input?: OperationalHostInstruction, originalBytes?: Uint8Array) => {
		assert(
			["preflight", "configure", "request", "burst", "refresh", "boundary"].includes(operation),
			"OPS_ADMISSION_OPERATION",
		);
		const facts = inspectOperationalAdmission(retained);
		assert.equal(facts.instructionSha256, sha(initial), "OPS_ADMISSION_INSTRUCTION_DRIFT");
		if (input !== undefined) assert.deepEqual(input, facts.requested, "OPS_ADMISSION_INPUT_MISMATCH");
		if (originalBytes !== undefined)
			assert(Buffer.from(originalBytes).equals(Buffer.from(initial)), "OPS_ADMISSION_INPUT_BYTES");
		const data = receiveOriginalCIAuthorization(retained.authority);
		const binding = joinOperationalTuple(data, retained, facts, operation);
		const now = Date.now(),
			mono = performance.now(),
			allocation = facts.nativeCorrespondence.admission.allocation;
		assert(
			Number.isSafeInteger(now) &&
				Number.isFinite(mono) &&
				now >= lastWall &&
				mono >= lastMono &&
				now >= allocation.notBeforeMs &&
				now < allocation.expiresMs &&
				mono - firstMono < Math.min(allocation.expiresMs, data.authorization.expires_at * 1000) - firstWall,
			"OPS_ADMISSION_EXPIRED_OR_CLOCK_REGRESSION",
		);
		lastWall = now;
		lastMono = mono;
		issuedGrant = {
			notBeforeWallMs: data.authorization.issued_at * 1000,
			expiresWallMs: data.authorization.expires_at * 1000,
		};
		assert(allocation.scopeOpen, "OPS_ADMISSION_DECLARED_SCOPE_CLOSED");
		// Recheck held inputs/producer refs after the finite original authority read.
		assert.deepEqual(inspectOperationalAdmission(retained), facts, "OPS_ADMISSION_CUSTODY_DRIFT");
		return binding;
	};
	const nativePending = (): never => {
		throw new Error("OPS_NATIVE_CURRENT_PERMISSION_API_UNAVAILABLE:original-Pi-owner");
	};
	// This state is reachable only through this original receiving closure. No
	// option/callback/JSON can supply the expected intent or permission predicate.
	let stage: "new" | "bootstrap" | "binding" | "bound" | "failed" = "new";
	let firstFailure: { error: unknown } | undefined;
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
	let expectedQualification: Sc085AuditClockQualificationV1 | undefined;
	const originalClose: { phase: "open" | "closing" | "clean" | "failed"; task?: Promise<void>; evidence?: RawRef } = {
		phase: "open",
	};
	const receiveCurrentParent = (operation: Operation) => {
		if (firstFailure) throw firstFailure.error;
		assert(stage !== "failed", "SC085_RECEIVING_FAILED");
		assert(selection, "SC085_BOOTSTRAP_REQUIRED");
		const binding = receiveTuple(operation);
		const current = selectSc085(binding, retained, firstWall, issuedGrant!, stage !== "bound");
		assert.deepEqual(current, selection, "SC085_ORIGINAL_SELECTION_CHANGED");
		if (stage !== "bound") assert(operation === "preflight", "SC085_CHILD_NOT_BOUND");
		return { binding, current };
	};
	const recheck = (operation: Operation, terminalAccounting = false) => {
		const { binding, current } = receiveCurrentParent(operation);
		if (terminalAccounting) {
			assert(
				operation === "preflight" &&
					originalClose.phase === "clean" &&
					child &&
					child.owner.phase === "closed" &&
					originalClose.evidence,
				"SC085_ORIGINAL_CLEAN_CLOSE_REQUIRED",
			);
			sc085RetainedBytes(originalClose.evidence, retained.retained);
		} else assert(originalClose.phase === "open", "SC085_CHILD_EFFECTS_CLOSED");
		if (child) {
			if (!terminalAccounting) {
				const permission = nativePermission(child, operation, current.intent.nativeReceiving);
				checkSc085Budget(current, permission, stage !== "bound");
			}
			if (bound && expectedCapsule && expectedQualification) {
				receiveSc085Admission(bound.admission, expectedCapsule, retained.retained);
				receiveSc085AuditClockQualification(
					expectedCapsule.clock.qualification,
					expectedQualification,
					retained.retained,
				);
				sc085RetainedBytes(bound.binding, retained.retained);
			}
		}
		return binding;
	};
	const result = Object.freeze({
		async preflightSc085(input: OperationalHostInstruction, originalBytes: Uint8Array) {
			try {
				if (firstFailure) throw firstFailure.error;
				assert(stage === "new", "SC085_BOOTSTRAP_ONCE");
				const binding = receiveTuple("preflight", input, originalBytes);
				selection = selectSc085(binding, retained, firstWall, issuedGrant!);
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
				receiveSc085Admission(input.sc085.admission, undefined, retained.retained);
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
			const value = receiveTuple("preflight").fd_slot_bound;
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
				const raw = retained.retained.get(ref.path);
				assert(raw && sha(raw) === ref.sha256, "OPS_FD_EXPECTATION_RAW_NOT_RETAINED");
			}
			return freeze(structuredClone(value));
		},
	});
	sc085Failures.set(result, {
		fail,
		check() {
			if (firstFailure) throw firstFailure.error;
		},
	});
	sc085Stores.set(result, retained.retained);
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
					application: parseOrdinaryOwnerRecord(bytes(retained.decision)).application,
					receiverInterval: {
						firstWallMs: firstWall,
						firstMonotonicMs: firstMono,
						timeOriginMs: performance.timeOrigin,
						deadlineWallMs: Math.min(
							selected.intent.validity.expiresWallMs,
							selected.clock.validity.expiresWallMs,
							issuedGrant!.expiresWallMs,
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
					const ref = store!.bytes(Buffer.from(`${JSON.stringify(evidence)}\n`));
					assert.deepEqual(
						JSON.parse(sc085RetainedBytes(ref, retained.retained).toString("utf8")),
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
	let lastBootstrapWall = firstWall,
		lastBootstrapMono = firstMono;
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
			const monotonicMs = ordinaryClock.monotonic(),
				wallMs = ordinaryClock.wallTime();
			assert(
				Number.isFinite(monotonicMs) &&
					monotonicMs >= lastBootstrapMono &&
					Number.isSafeInteger(wallMs) &&
					wallMs >= lastBootstrapWall,
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
							issuedGrant!.expiresWallMs,
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
			};
			const raw = recorder.bytes(Buffer.from(`${JSON.stringify(original)}\n`));
			assert.deepEqual(
				JSON.parse(sc085RetainedBytes(raw, retained.retained).toString("utf8")),
				original,
				"SC085_BOOTSTRAP_SAMPLE_STORAGE",
			);
			// This qualification ref is the independently selected original BOOTSTRAP
			// policy, not a child-shaped Sc085AuditClockQualificationV1 with fake owner.
			const qualification = selected.intent.clockRequirement.qualificationPolicy;
			const view = {
				protocol: "sense-ops-sc085-qualified-bootstrap-stamp/1",
				original: raw,
				qualification,
				policy: selected.policy,
				clockId: selected.clock.admittedClockId,
				runId: selected.intent.runId,
				allocationId: selected.intent.allocationId,
				monotonicMs,
				wallMs,
				uncertaintyMs: selected.uncertaintyMs,
				accountingPhase: terminalAccounting ? "post-original-child-close" : "original-open-interval",
				originalChildClose: terminalAccounting ? originalClose.evidence! : null,
			};
			const viewRef = recorder.bytes(Buffer.from(`${JSON.stringify(view)}\n`));
			assert.deepEqual(
				JSON.parse(sc085RetainedBytes(viewRef, retained.retained).toString("utf8")),
				view,
				"SC085_BOOTSTRAP_VIEW_STORAGE",
			);
			assert((originalClose.phase === "clean") === terminalAccounting, "SC085_ACCOUNTING_PHASE_CHANGED");
			recheck("preflight", terminalAccounting); // Parent/current refs and same latch after storage.
			lastBootstrapWall = wallMs;
			lastBootstrapMono = monotonicMs;
			return {
				clockId: view.clockId,
				monotonicMs,
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
			const q = receiveSc085AuditClockQualification(
				expectedCapsule.clock.qualification,
				expectedQualification,
				retained.retained,
			);
			if (selector.kind === "request") fields(selector, "kind requestId phase");
			else if (selector.kind === "exposure") fields(selector, "kind requestId");
			else {
				fields(selector, "kind cursor edge");
				assert.equal(selector.kind, "window", "SC085_STAMP_SELECTOR");
			}
			const original = OrdinaryOperationalAudit.prototype.resolveSc085Stamp.call(owner.operationalAudit, selector);
			assert.deepEqual(original.scope, q.owner, "SC085_STAMP_ORIGINAL_SCOPE");
			assert.deepEqual(
				original.clockIdentity,
				JSON.parse(sc085RetainedBytes(q.nativeIdentity, retained.retained).toString("utf8")),
				"SC085_STAMP_ORIGINAL_IDENTITY",
			);
			const stamp = original.stamp,
				uncertaintyMs = q.mapping.uncertaintyMs;
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
			const raw = store.bytes(Buffer.from(`${JSON.stringify(original)}\n`));
			assert.deepEqual(
				JSON.parse(sc085RetainedBytes(raw, retained.retained).toString("utf8")),
				original,
				"SC085_STAMP_STORAGE",
			);
			const view = {
				protocol: "sense-ops-sc085-qualified-stamp/1",
				original: raw,
				qualification: expectedCapsule.clock.qualification,
				clockId: q.admittedClockId,
				owner: q.owner,
				monotonicMs: stamp.monotonicMs,
				wallMs: stamp.wallMs,
				uncertaintyMs,
			};
			const viewRef = store.bytes(Buffer.from(`${JSON.stringify(view)}\n`));
			assert.deepEqual(
				JSON.parse(sc085RetainedBytes(viewRef, retained.retained).toString("utf8")),
				view,
				"SC085_QUALIFIED_VIEW_STORAGE",
			);
			recheck("boundary");
			return {
				clockId: view.clockId,
				monotonicMs: view.monotonicMs,
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
			const nativeIdentity = recorder.bytes(Buffer.from(`${JSON.stringify(audit)}\n`));
			assert.deepEqual(
				JSON.parse(sc085RetainedBytes(nativeIdentity, retained.retained).toString("utf8")),
				audit,
				"SC085_AUDIT_STORAGE",
			);
			const qualification: Sc085AuditClockQualificationV1 = {
				protocol: "sense-ops-sc085-audit-clock/1",
				owner: identity,
				admittedClockId: selected.clock.admittedClockId,
				nativeIdentity,
				source: "node:perf_hooks.performance",
				sourceIdentity: selected.clock.sourceIdentity,
				mapping: { kind: "same-original-source", nativeClockId: audit.id, uncertaintyMs: selected.uncertaintyMs },
				validity: selected.clock.validity,
			};
			const qualifiedRef = recorder.bytes(canonicalSc085AuditClockQualification(qualification));
			receiveSc085AuditClockQualification(qualifiedRef, qualification, retained.retained);
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
			const admission = recorder.bytes(canonicalPilotDecision(capsule));
			const received = receiveSc085Admission(admission, capsule, retained.retained);
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
			const binding = recorder.bytes(Buffer.from(`${JSON.stringify(evidence)}\n`));
			assert.deepEqual(
				JSON.parse(sc085RetainedBytes(binding, retained.retained).toString("utf8")),
				evidence,
				"SC085_BINDING_STORAGE",
			);
			// Publish private bound state only after both byte receiving and native
			// authentication. Failure poisons this once path; caller owns original close.
			// Include retention/qualification costs before publishing the full binding.
			checkSc085Budget(selected, nativePermission(owner, "preflight", intent.nativeReceiving), true);
			// Storage may catch a nested known-route violation. Its original cause
			// still poisons THIS supplier; never publish bound state over that latch.
			sc085Failures.get(result)!.check();
			child = owner;
			store = recorder;
			expectedCapsule = structuredClone(capsule);
			expectedQualification = structuredClone(qualification);
			bound = { preflight: { ...plan.preflight }, admission, binding };
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
const sc085Failures = new WeakMap<object, { check(): void; fail(error: unknown): never }>();
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
function selectSc085(
	binding: OperationalBinding,
	inputs: OperationalAdmissionInputs,
	firstWall: number,
	issuedGrant: { notBeforeWallMs: number; expiresWallMs: number },
	reserve = true,
) {
	const selected = parseCanonicalPilotDecision(sc085RetainedBytes(binding.policy, inputs.retained));
	fields(selected, "protocol intent bootstrap cleanupReserveMs");
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
	assert(
		intent.validity.notBeforeWallMs >=
			Math.max(issuedGrant.notBeforeWallMs, native.admission.allocation.notBeforeMs) &&
			intent.validity.expiresWallMs <= Math.min(issuedGrant.expiresWallMs, native.admission.allocation.expiresMs),
		"SC085_ORIGINAL_GRANT_WINDOW",
	);
	assert.deepEqual(intent.nativeReceiving, binding.native, "SC085_PREFLIGHT_NATIVE");
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
