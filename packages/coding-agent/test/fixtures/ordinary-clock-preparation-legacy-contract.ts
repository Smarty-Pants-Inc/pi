import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { NativeClockSample, OriginalClockObservation } from "../../src/core/ordinary-clock-evidence.ts";
import { observeRejectedSyncResult } from "../../src/utils/observe-rejected-sync-result.ts";
import { OriginalClockEvidence } from "./ordinary-clock-events-legacy-contract.ts";

type Ref = { path: string; sha256: string };

// HISTORICAL MOCK ONLY. Original state/clock/prepare/observation function text
// below is byte-exact; only module export keywords are outside the excerpts.
// The old evidence implementation is reused, not restored to production.
// Each call isolates historical module state; receiveOriginalClockSource is a
// test-only modeled dependency, never an original addon/owner/clock registrar.
export function createHistoricalPreparedClock(
	receiveOriginalClockSource: (profile: Ref) => { implementation: Ref; read: () => NativeClockSample },
) {
	let sampled = false;
	let prepared = false;
	let failure: { cause: unknown } | undefined;
	let evidence: OriginalClockEvidence | undefined;
	let initialObservation: OriginalClockObservation | undefined;
	let association:
		| Readonly<{ profile: Ref; producer: Ref; implementation: Ref; maxBracketNs: string; guardSource: Ref }>
		| undefined;
	function healthy() {
		if (failure) throw failure.cause;
		evidence?.check();
	}

	const ordinaryClock = Object.freeze({
		monotonic: () => {
			healthy();
			sampled = true;
			return performance.now();
		},
		wallTime: () => {
			healthy();
			sampled = true;
			return Date.now();
		},
		setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
		clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		capture<T>(event: string, transition: () => T) {
			healthy();
			assert(evidence && association, "OWNER_CLOCK_NOT_PREPARED");
			return evidence.capture(event, transition);
		},
	});

	function prepareOrdinaryClock(input: { profile: Ref; producer: Ref; maxBracketNs: string; guardSource: Ref }) {
		try {
			healthy();
			assert(!sampled && !prepared, "OWNER_CLOCK_PREPARE_BEFORE_FIRST_SAMPLE_ONCE");
			prepared = true;
			assert(
				typeof input.maxBracketNs === "string" &&
					/^[1-9][0-9]{0,19}$/.test(input.maxBracketNs) &&
					BigInt(input.maxBracketNs) <= 1_000_000_000n,
				"OWNER_CLOCK_BRACKET_CAP",
			);
			for (const ref of [input.profile, input.producer, input.guardSource]) {
				assert(
					typeof ref.path === "string" && ref.path.startsWith("/") && /^[a-f0-9]{64}$/.test(ref.sha256),
					"OWNER_CLOCK_REF",
				);
			}
			const original = receiveOriginalClockSource(input.profile);
			association = Object.freeze({
				profile: Object.freeze({ ...input.profile }),
				producer: Object.freeze({ ...input.producer }),
				implementation: original.implementation,
				maxBracketNs: input.maxBracketNs,
				guardSource: Object.freeze({ ...input.guardSource }),
			});
			evidence = new OriginalClockEvidence(original.read, input.maxBracketNs);
			const first = ordinaryClock.capture("pre-a-initial", () => ({
				monotonicMs: ordinaryClock.monotonic(),
				wallMs: ordinaryClock.wallTime(),
			}));
			initialObservation = {
				local: first.value,
				parent: first.witness,
				sequence: first.sequence,
				eventMeaning: first.eventMeaning,
			};
			return structuredClone({ ...association, initial: initialObservation });
		} catch (cause) {
			failure ??= { cause };
			throw failure.cause;
		}
	}

	function captureOrdinaryClockObservation<T>(
		event: string,
		transition: () => T,
	): { value: T; observation: OriginalClockObservation } {
		let discarded: unknown;
		try {
			const captured = ordinaryClock.capture(event, () => {
				const value = transition();
				discarded = value;
				assert(
					value === null || (typeof value !== "object" && typeof value !== "function") || !("then" in value),
					"OWNER_CLOCK_ASYNC_TRANSITION",
				);
				return { value, local: { monotonicMs: ordinaryClock.monotonic(), wallMs: ordinaryClock.wallTime() } };
			});
			return {
				value: captured.value.value,
				observation: {
					local: captured.value.local,
					parent: captured.witness,
					sequence: captured.sequence,
					eventMeaning: captured.eventMeaning,
				},
			};
		} catch (cause) {
			// Outer capture cannot see a result rejected by this inner wrapper.
			// Its original evidence latch is sealed before this deferred observation.
			observeRejectedSyncResult(discarded);
			throw cause;
		}
	}

	return { ordinaryClock, prepareOrdinaryClock, captureOrdinaryClockObservation };
}
