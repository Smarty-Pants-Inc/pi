/** Source-only schema for a field of the ORIGINAL sealed CI authorization.
 * Linux's pure proof receiver consumes an object returned by the real original
 * admission supplier, never a caller-created JSON expectation as authority.
 * No N/T/budget/scope/enforcement values are selected by this source definition. */
export interface RawRef {
	readonly path: string;
	readonly sha256: string;
}
export type OtherResourceDisposition =
	| { readonly kind: "admitted-exclusion"; readonly evidence: RawRef }
	| {
			readonly kind: "separately-bounded";
			readonly evidence: RawRef;
			readonly bound: number;
			readonly budget: number;
			readonly unit: string;
	  };
export interface IndependentlyAdmittedFdSlotExpectation {
	readonly version: 1;
	readonly kind: "enforced-live-fd-slots";
	readonly quantity: "live-fd-table-slots";
	readonly semantics: "CONSERVATIVE_UPPER_BOUND";
	readonly N: number;
	readonly T: number;
	readonly budget: number;
	readonly scope: RawRef;
	readonly epoch: RawRef;
	readonly wholeWindow: RawRef;
	readonly retirement: RawRef;
	readonly proofs: {
		readonly inheritedHardLimit: RawRef;
		readonly initialFdRoster: RawRef;
		readonly aggregateTasksMembership: RawRef;
		readonly noForeignTableSharers: RawRef;
		readonly noMigrationOrEscape: RawRef;
		readonly noLimitRaiseOrExternalMutation: RawRef;
		readonly targetAllocationSemantics: RawRef;
		readonly uninterruptedBoundaryCustody: RawRef;
		readonly retirementTail: RawRef;
	};
	readonly otherResources: {
		readonly openFileDescriptions: OtherResourceDisposition;
		readonly queuedOrInFlightReferences: OtherResourceDisposition;
		readonly ioUringFixedFiles: OtherResourceDisposition;
		readonly logicalHandles: OtherResourceDisposition;
	};
}
/** Implemented by createOperationalAdmission in this packet. It verifies the
 * canonical original CI authorization and exact tuple again on each call, then
 * returns a detached immutable expectation. Missing expectation/authority refuses.
 * This is not the original Pi native current-permission check or an activation. */
export interface FdSlotAdmissionSupplier {
	receiveFdSlotBoundExpectation(): IndependentlyAdmittedFdSlotExpectation;
}
