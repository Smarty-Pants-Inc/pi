import type { IndependentlyAdmittedFdSlotExpectation as Final } from "./fd-slot-expectation.ts";
/** Original pre-effect policy selection. No future receipt placeholders.
 * Initial proof sources remain obligations, not proof of later enforcement. */
export type IndependentlyAdmittedFdSlotPreflight = Omit<
	Final,
	"version" | "kind" | "wholeWindow" | "retirement" | "proofs"
> & {
	readonly version: 2;
	readonly kind: "admitted-live-fd-slot-preflight";
	readonly proofs: Omit<Final["proofs"], "uninterruptedBoundaryCustody" | "retirementTail">;
};
