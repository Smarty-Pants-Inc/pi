import assert from "node:assert/strict";
import type { RawRef } from "./fd-slot-expectation.ts";
import { outsideFields, outsideNs, outsideRef } from "./outside-final-data.ts";

export interface OperationalEnforcementMethod {
	qualificationAuthority: RawRef;
	qualification: RawRef;
	source: RawRef;
	mechanisms: RawRef[];
	validity: { startNs: string; endNs: string };
	guardRules: { kind: "original-ci-enforcement-guards/1"; invariants: unknown[]; source: RawRef };
}

/** Closed static input, not an award or a future capture. No compatibility
 * default: the original selected epoch source must contain the actual method. */
export function parseOperationalEnforcementMethod(value: unknown): OperationalEnforcementMethod {
	outsideFields(value, "qualificationAuthority qualification source mechanisms validity guardRules");
	assert(Array.isArray(value.mechanisms) && value.mechanisms.length > 0, "OPS_ENFORCEMENT_METHOD_MECHANISMS");
	outsideFields(value.validity, "startNs endNs");
	assert(outsideNs(value.validity.startNs) < outsideNs(value.validity.endNs), "OPS_ENFORCEMENT_METHOD_VALIDITY");
	outsideFields(value.guardRules, "kind invariants source");
	assert(
		value.guardRules.kind === "original-ci-enforcement-guards/1" &&
			Array.isArray(value.guardRules.invariants) &&
			value.guardRules.invariants.length > 0,
		"OPS_ENFORCEMENT_METHOD_GUARDS",
	);
	for (const ref of [
		value.qualificationAuthority,
		value.qualification,
		value.source,
		...value.mechanisms,
		value.guardRules.source,
	])
		outsideRef(ref);
	return structuredClone(value) as unknown as OperationalEnforcementMethod;
}

export function operationalEnforcementMethodRefs(method: OperationalEnforcementMethod): RawRef[] {
	return [
		method.qualificationAuthority,
		method.qualification,
		method.source,
		...method.mechanisms,
		method.guardRules.source,
	];
}
