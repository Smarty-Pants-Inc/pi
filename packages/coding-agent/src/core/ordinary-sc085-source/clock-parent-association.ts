import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readOrdinaryClockPreparation } from "../ordinary-clock.ts";
import type { OriginalClockWitness } from "../ordinary-clock-evidence.ts";
import { projectClockNanoseconds } from "../ordinary-clock-evidence.ts";
import type { OperationalBinding, OriginalCIInitialProjection } from "./ci-authority.ts";
import type { RawRef } from "./fd-slot-expectation.ts";

function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "OPS_CLOCK_PARENT_OBJECT");
	assert.deepEqual(Object.keys(value).sort(), names.split(" ").sort(), "OPS_CLOCK_PARENT_FIELDS");
}
function object(value: unknown): asserts value is Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "OPS_CLOCK_PARENT_OBJECT");
}
function ns(value: unknown): bigint {
	assert(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value), "OPS_CLOCK_PARENT_INTEGER");
	return BigInt(value);
}
function reference(value: unknown): RawRef {
	fields(value, "path sha256");
	assert(
		typeof value.path === "string" &&
			value.path.startsWith("/") &&
			typeof value.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(value.sha256),
		"OPS_CLOCK_PARENT_REF",
	);
	return { path: value.path, sha256: value.sha256 };
}
function budget(value: unknown): bigint {
	assert(
		typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000,
		"OPS_CLOCK_PARENT_BUDGET",
	);
	const scaled = value * 1_000_000;
	assert(Number.isSafeInteger(scaled), "OPS_CLOCK_PARENT_BUDGET_PRECISION");
	return BigInt(scaled);
}

/** CI has identified no supported independent rate/reference/tenure method in
 * this source packet. Consistency samples and root-owned hashed declarations
 * cannot enable a positive award. Adding a real typed method requires reviewed
 * reference traceability, actual platform/addon binding and continuous tenure. */
export function requireIndependentClockQualification(): void {
	throw new Error("OPS_CLOCK_INDEPENDENT_METHOD_UNSUPPORTED:consistency-observations-are-not-metrology");
}

/** Original retained DATA joins only. No external callback or filesystem fallback.
 * Physical authority/method/reference semantics remain a separate mandatory
 * receiver; this function deliberately does NOT return a qualified ClockStamp. */
export function receiveClockParentAssociation(input: {
	binding: OperationalBinding;
	initial: OriginalCIInitialProjection;
	retained: ReadonlyMap<string, Uint8Array>;
	prepared: { profile: RawRef; producer: RawRef; implementation: RawRef; maxBracketNs: string; guardSource: RawRef };
	witness: OriginalClockWitness;
	guard: RawRef;
}) {
	const read = (value: unknown) => {
		const ref = reference(value),
			bytes = input.retained.get(ref.path);
		assert(
			bytes &&
				bytes.byteLength <= 4 * 1024 * 1024 &&
				createHash("sha256").update(bytes).digest("hex") === ref.sha256,
			"OPS_CLOCK_PARENT_RETAINED",
		);
		const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		object(decoded);
		return decoded;
	};
	const release = read(input.initial.release.raw),
		initial = read(input.initial.initial.raw);
	assert.deepEqual(release.initial, input.initial.initial.raw, "OPS_CLOCK_PARENT_INITIAL_REF");
	assert(
		release.version === 1 &&
			release.kind === "original-ci-operational-release" &&
			initial.version === 1 &&
			initial.kind === "ordinary-resource-initial/1",
		"OPS_CLOCK_PARENT_INITIAL_KIND",
	);
	assert.deepEqual(input.prepared.profile, input.binding.native.profile, "OPS_CLOCK_PARENT_PROFILE");
	assert.deepEqual(input.prepared.producer, input.binding.producers.clock, "OPS_CLOCK_PARENT_PRODUCER");
	assert(
		initial.profileSha256 === input.prepared.profile.sha256 && initial.runId === input.binding.operational_run_id,
		"OPS_CLOCK_PARENT_INITIAL_IDENTITY",
	);
	object(initial.original);
	object(initial.launcher);
	const bound = input.binding.fd_slot_bound;
	assert(bound, "OPS_CLOCK_PARENT_PREFLIGHT");
	assert.deepEqual(initial.original.initialFd, bound.proofs.initialFdRoster, "OPS_CLOCK_PARENT_INITIAL_FD");
	assert.deepEqual(initial.original.scope, bound.scope, "OPS_CLOCK_PARENT_SCOPE");
	assert.deepEqual(initial.original.epoch, bound.epoch, "OPS_CLOCK_PARENT_EPOCH");
	const first = read(initial.original.initialFd);
	object(first.initialAt);
	const basisRef = reference(first.initialAt.raw),
		basis = read(basisRef);
	const common = "binding allocation resourceEpoch contract adapter boot timeNamespace clockId";
	fields(basis, `version kind ${common} calibration validity uncertainty`);
	assert(basis.version === 1 && basis.kind === "original-ci-clock-initial-basis", "OPS_CLOCK_PARENT_BASIS");
	const scope = read(bound.scope),
		epoch = read(bound.epoch);
	const binding = {
		scope: bound.scope,
		epoch: bound.epoch,
		owner: scope.owner,
		ownerEpoch: scope.ownerEpoch,
		aggregate: scope.aggregate,
	};
	assert.deepEqual(basis.binding, binding, "OPS_CLOCK_PARENT_BINDING");
	for (const key of ["owner", "ownerEpoch", "aggregate"])
		assert.deepEqual(epoch[key], scope[key], "OPS_CLOCK_PARENT_EPOCH_BINDING");
	assert.deepEqual(epoch.scope, bound.scope, "OPS_CLOCK_PARENT_EPOCH_SCOPE");
	assert.deepEqual(initial.aggregate, scope.aggregate, "OPS_CLOCK_PARENT_AGGREGATE");
	assert.deepEqual(
		Object.keys(bound.proofs).sort(),
		[
			"inheritedHardLimit",
			"initialFdRoster",
			"aggregateTasksMembership",
			"noForeignTableSharers",
			"noMigrationOrEscape",
			"noLimitRaiseOrExternalMutation",
			"targetAllocationSemantics",
		].sort(),
		"OPS_CLOCK_PARENT_SEVEN_PROOFS",
	);
	assert.deepEqual(
		Object.keys(bound.otherResources).sort(),
		["openFileDescriptions", "queuedOrInFlightReferences", "ioUringFixedFiles", "logicalHandles"].sort(),
		"OPS_CLOCK_PARENT_FOUR_RESOURCES",
	);
	for (const ref of [
		...Object.values(bound.proofs),
		...Object.values(bound.otherResources).map((row) => row.evidence),
	]) {
		const wrapper = read(ref);
		object(wrapper.initialAt);
		assert.deepEqual(wrapper.initialAt.raw, basisRef, "OPS_CLOCK_PARENT_FROZEN_INITIAL_BASIS");
		assert.deepEqual(wrapper.binding, binding, "OPS_CLOCK_PARENT_WRAPPER_BINDING");
	}
	const policy = read(input.binding.policy);
	object(policy.operational_prelaunch);
	const prelaunch = policy.operational_prelaunch;
	object(prelaunch.constraints);
	const epochSource = read(prelaunch.constraints.epochSource),
		plan = read(prelaunch.phasePlan);
	assert.deepEqual(epoch.source, prelaunch.constraints.epochSource, "OPS_CLOCK_PARENT_EPOCH_SOURCE");
	assert.deepEqual(epochSource.clockContract, plan.clockBasisRef, "OPS_CLOCK_PARENT_CONTRACT_SELECTION");
	assert.deepEqual(basis.contract, plan.clockBasisRef, "OPS_CLOCK_PARENT_BASIS_CONTRACT");
	assert.deepEqual(epochSource.owner, scope.owner, "OPS_CLOCK_PARENT_OWNER");
	const contract = read(plan.clockBasisRef);
	fields(
		contract,
		"version kind owner qualificationAuthority qualification source platform clock adapter acquisition reference rateEnvelope validity guardRules",
	);
	assert(contract.version === 1 && contract.kind === "original-ci-clock-tenure-contract", "OPS_CLOCK_PARENT_CONTRACT");
	assert.deepEqual(contract.owner, scope.owner, "OPS_CLOCK_PARENT_CONTRACT_OWNER");
	assert.deepEqual(basis.validity, contract.validity, "OPS_CLOCK_PARENT_VALIDITY");
	assert.deepEqual(basis.adapter, contract.adapter, "OPS_CLOCK_PARENT_ADAPTER");
	fields(
		contract.adapter,
		"kind producer implementation clockAbi inputClock outputClockId representative localDomain uncertaintyNs",
	);
	object(contract.clock);
	object(contract.platform);
	assert(
		contract.adapter.kind === "original-event-clock-bracket-adapter/1" &&
			contract.adapter.clockAbi === 1 &&
			contract.adapter.inputClock === "CLOCK_MONOTONIC" &&
			contract.adapter.outputClockId === contract.clock.clockId &&
			contract.adapter.representative === "after" &&
			contract.adapter.localDomain === "node:perf_hooks.performance",
		"OPS_CLOCK_PARENT_ADAPTER_DOMAIN",
	);
	assert.deepEqual(contract.adapter.producer, input.prepared.producer, "OPS_CLOCK_PARENT_ADAPTER_PRODUCER");
	assert.deepEqual(contract.adapter.implementation, input.prepared.implementation, "OPS_CLOCK_PARENT_ACTUAL_ADDON");
	assert(basis.clockId === contract.clock.clockId && basis.boot === contract.platform.boot, "OPS_CLOCK_PARENT_DOMAIN");
	assert.deepEqual(basis.timeNamespace, contract.platform.timeNamespace, "OPS_CLOCK_PARENT_NAMESPACE");
	assert(
		initial.resourceEpoch === basis.resourceEpoch && basis.resourceEpoch === epochSource.resourceEpoch,
		"OPS_CLOCK_PARENT_RESOURCE_EPOCH",
	);
	assert.deepEqual(basis.allocation, epochSource.allocation, "OPS_CLOCK_PARENT_ALLOCATION");
	object(basis.allocation);
	assert(
		initial.allocationId === basis.allocation.id && initial.sessionId === basis.allocation.session,
		"OPS_CLOCK_PARENT_INITIAL_ALLOCATION",
	);
	const permission = read(input.guard);
	object(permission.clockGuard);
	assert.deepEqual(permission.clockGuard.basis, basisRef, "OPS_CLOCK_PARENT_LIVE_BASIS");
	assert.deepEqual(
		permission.clockGuard.query,
		{ beforeNs: input.witness.before.monotonicNs, afterNs: input.witness.after.monotonicNs },
		"OPS_CLOCK_PARENT_QUERY",
	);
	const request = read(permission.request),
		context = read(request.context);
	object(context.clock);
	assert.deepEqual(context.release, input.initial.release.raw, "OPS_CLOCK_PARENT_RELEASE");
	assert.deepEqual(context.entry, release.entry, "OPS_CLOCK_PARENT_ENTRY");
	assert.deepEqual(context.receiving, input.binding.native.receiving, "OPS_CLOCK_PARENT_RECEIVING");
	assert.deepEqual(context.controller, permission.controller, "OPS_CLOCK_PARENT_CONTROLLER");
	assert(context.clock.bootId === basis.boot, "OPS_CLOCK_PARENT_CONTEXT_BOOT");
	assert.deepEqual(context.clock.timeNamespace, basis.timeNamespace, "OPS_CLOCK_PARENT_CONTEXT_NAMESPACE");
	fields(input.witness, "version kind before after");
	assert(
		input.witness.version === 1 && input.witness.kind === "original-native-clock-witness",
		"OPS_CLOCK_PARENT_WITNESS",
	);
	for (const sample of [input.witness.before, input.witness.after]) {
		fields(sample, "monotonicNs bootId timeNamespace pid");
		assert(
			Number.isSafeInteger(sample.pid) &&
				sample.pid > 0 &&
				sample.pid === initial.launcher.pid &&
				sample.bootId === basis.boot,
			"OPS_CLOCK_PARENT_LAUNCHER",
		);
		assert.deepEqual(sample.timeNamespace, basis.timeNamespace, "OPS_CLOCK_PARENT_SAMPLE_NAMESPACE");
	}
	fields(contract.guardRules, "kind maxGapNs maxBracketNs invariants source");
	const producerBytes = input.retained.get(input.prepared.producer.path);
	assert(producerBytes, "OPS_CLOCK_PARENT_PRODUCER_RETAINED");
	const preparation = readOrdinaryClockPreparation(input.prepared.producer, producerBytes);
	assert.deepEqual(
		preparation,
		{ maxBracketNs: input.prepared.maxBracketNs, guardSource: input.prepared.guardSource },
		"OPS_CLOCK_PARENT_PREPARATION_CHANGED",
	);
	assert(preparation.maxBracketNs === contract.guardRules.maxBracketNs, "OPS_CLOCK_PARENT_PREPARATION_CAP");
	assert.deepEqual(preparation.guardSource, contract.guardRules.source, "OPS_CLOCK_PARENT_PREPARATION_GUARD");
	fields(
		contract.rateEnvelope,
		"rateErrorPpb resolutionNs referenceUncertaintyNs initialOffsetUncertaintyNs adapterUncertaintyNs",
	);
	fields(contract.validity, "startNs endNs");
	fields(basis.uncertainty, "baselineNs executionNs");
	const before = ns(input.witness.before.monotonicNs),
		after = ns(input.witness.after.monotonicNs),
		start = ns(context.clock.startedNs);
	const width = after - before,
		maximum = ns(contract.guardRules.maxBracketNs),
		gap = ns(contract.guardRules.maxGapNs);
	assert(
		start <= before &&
			before <= after &&
			after < ns(context.clock.captureReleaseDeadlineNs) &&
			ns(contract.validity.startNs) <= before &&
			after <= ns(contract.validity.endNs) &&
			maximum > 0n &&
			maximum <= gap &&
			width <= maximum,
		"OPS_CLOCK_PARENT_EVENT_RANGE",
	);
	const horizon = ns(context.clock.reportingDeadlineNs) - start;
	assert(horizon === 21600_000_000_000n, "OPS_CLOCK_PARENT_FULL_HORIZON");
	const rate = contract.rateEnvelope;
	const error = (elapsed: bigint, bracket: bigint) =>
		ns(rate.resolutionNs) +
		ns(rate.referenceUncertaintyNs) +
		ns(rate.initialOffsetUncertaintyNs) +
		ns(rate.adapterUncertaintyNs) +
		bracket +
		(elapsed * ns(rate.rateErrorPpb) + 999_999_999n) / 1_000_000_000n;
	assert(ns(contract.adapter.uncertaintyNs) === ns(rate.adapterUncertaintyNs), "OPS_CLOCK_PARENT_ADAPTER_ERROR");
	const declared = ns(basis.uncertainty.executionNs);
	assert(
		error(0n, maximum) === ns(basis.uncertainty.baselineNs) &&
			ns(basis.uncertainty.baselineNs) === budget(plan.baselineUncertaintyMs) &&
			error(horizon, maximum) === declared &&
			declared === budget(plan.uncertaintyMs) &&
			declared <= 1_000_000_000n &&
			error(after - start, width) <= declared,
		"OPS_CLOCK_PARENT_FIXED_BUDGET",
	);
	const platform = contract.platform,
		validity = contract.validity,
		clock = context.clock;
	const point = (ref: unknown) => {
		const record = read(ref),
			isBasis = record.kind === "original-ci-clock-initial-basis";
		if (isBasis) assert.deepEqual(reference(ref), basisRef, "OPS_CLOCK_PARENT_ALTERNATE_BASIS");
		else {
			fields(record, `version kind ${common} sequence prior sample`);
			assert(
				record.version === 1 && record.kind === "original-ci-clock-guard" && ns(record.sequence) > 0n,
				"OPS_CLOCK_PARENT_GUARD",
			);
			reference(record.prior);
		}
		for (const key of common.split(" "))
			assert.deepEqual(record[key], basis[key], "OPS_CLOCK_PARENT_GUARD_ASSOCIATION");
		const sample = read(isBasis ? record.calibration : record.sample);
		fields(
			sample,
			"version kind controller sequence errors monotonicBeforeNs monotonicAfterNs processBefore bootBefore timeNamespaceBefore clocksourceBefore processAfter bootAfter timeNamespaceAfter clocksourceAfter rawNs realtimeNs boottimeNs",
		);
		assert(sample.version === 1 && sample.kind === "original-ci-clock-sample", "OPS_CLOCK_PARENT_ROOT_SAMPLE");
		assert.deepEqual(sample.errors, [], "OPS_CLOCK_PARENT_ROOT_ERRORS");
		assert.deepEqual(sample.controller, context.controller, "OPS_CLOCK_PARENT_ROOT_CONTROLLER");
		object(sample.controller);
		assert(ns(sample.sequence) === (isBasis ? 0n : ns(record.sequence)), "OPS_CLOCK_PARENT_ROOT_SEQUENCE");
		for (const suffix of ["Before", "After"]) {
			const process = sample[`process${suffix}`];
			fields(process, "pid startTicks");
			assert(
				Number.isSafeInteger(process.pid) &&
					BigInt(Number(process.pid)) === ns(sample.controller.pid) &&
					process.startTicks === sample.controller.startTicks &&
					sample[`boot${suffix}`] === basis.boot &&
					sample[`clocksource${suffix}`] === platform.clocksource,
				"OPS_CLOCK_PARENT_ROOT_IDENTITY",
			);
			assert.deepEqual(sample[`timeNamespace${suffix}`], basis.timeNamespace, "OPS_CLOCK_PARENT_ROOT_NAMESPACE");
		}
		for (const key of ["rawNs", "realtimeNs", "boottimeNs"]) ns(sample[key]);
		const left = ns(sample.monotonicBeforeNs),
			right = ns(sample.monotonicAfterNs);
		assert(
			start <= left &&
				left <= right &&
				right - left <= maximum &&
				right < ns(clock.captureReleaseDeadlineNs) &&
				ns(validity.startNs) <= left &&
				right <= ns(validity.endNs),
			"OPS_CLOCK_PARENT_ROOT_RANGE",
		);
		return { left, right, sequence: ns(sample.sequence) };
	};
	point(basisRef);
	const left = point(permission.clockGuard.before),
		right = point(permission.clockGuard.after),
		head = point(permission.clockGuard.head),
		checked = ns(permission.checkedNs);
	assert(
		left.right <= before &&
			after <= right.left &&
			left.sequence <= right.sequence &&
			right.sequence <= head.sequence &&
			right.right <= head.right &&
			head.right <= checked &&
			checked - head.left <= gap,
		"OPS_CLOCK_PARENT_COVERAGE",
	);
	const projection = projectClockNanoseconds(String(after));
	assert(ns(projection.conversionErrorNs) <= ns(rate.adapterUncertaintyNs), "OPS_CLOCK_PARENT_DISPLAY_ERROR");
	return {
		...projection,
		uncertaintyNs: String(declared),
		basis: basisRef,
		guard: { ...input.guard },
		clockId: basis.clockId,
		contract: reference(basis.contract),
	};
}
