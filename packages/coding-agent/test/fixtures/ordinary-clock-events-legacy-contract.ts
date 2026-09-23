import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { NativeClockSample, OriginalClockWitness } from "../../src/core/ordinary-clock-evidence.ts";
import type { NativeAuditStamp } from "../../src/core/ordinary-operational-audit.ts";
import type { OrdinaryExposureFrame, OrdinaryExposureReceipt } from "../../src/core/ordinary-sense.ts";
import { observeRejectedSyncResult } from "../../src/utils/observe-rejected-sync-result.ts";

// HISTORICAL MOCK CONTRACT ONLY. Exact pre-C6 clock/sample and audit method
// excerpts are recorded in EVENTS-LEGACY-EXCERPTS.json. They are not production
// exports, current ticket APIs, authentic owners, native clocks or qualification.
// Minimal state below models an unopened audit window; publication/clock and
// rejection bodies themselves are unchanged. No test-side promise handling.
function unsigned(value: unknown): bigint {
	assert(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value), "OWNER_CLOCK_INTEGER");
	return BigInt(value);
}
function sample(value: NativeClockSample): NativeClockSample {
	assert.deepEqual(Object.keys(value).sort(), ["bootId", "monotonicNs", "pid", "timeNamespace"], "OWNER_CLOCK_SAMPLE");
	assert.deepEqual(Object.keys(value.timeNamespace).sort(), ["device", "inode"], "OWNER_CLOCK_NAMESPACE");
	unsigned(value.monotonicNs);
	unsigned(value.timeNamespace.device);
	assert(
		unsigned(value.timeNamespace.inode) > 0n && Number.isSafeInteger(value.pid) && value.pid > 0,
		"OWNER_CLOCK_IDENTITY",
	);
	assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.bootId), "OWNER_CLOCK_BOOT");
	return structuredClone(value);
}

/** Evidence state machine, not a clock/authority factory. Production supplies
 * the original verified addon; inert tests supply only modeled read ports. */
export class OriginalClockEvidence {
	readonly #read: () => NativeClockSample;
	readonly #maxBracket: bigint;
	#identity?: Omit<NativeClockSample, "monotonicNs">;
	#last = 0n;
	#sequence = 0n;
	#active = false;
	#failure?: { cause: unknown };

	constructor(read: () => NativeClockSample, maxBracketNs: string) {
		this.#read = read;
		this.#maxBracket = unsigned(maxBracketNs);
		assert(this.#maxBracket > 0n, "OWNER_CLOCK_BRACKET_CAP");
	}
	check(): void {
		if (this.#failure) throw this.#failure.cause;
	}
	#observe(): NativeClockSample {
		this.check();
		const value = sample(this.#read());
		this.check();
		const { monotonicNs, ...identity } = value;
		this.#identity ??= structuredClone(identity);
		assert.deepEqual(identity, this.#identity, "OWNER_CLOCK_IDENTITY_CHANGED");
		assert(unsigned(monotonicNs) >= this.#last, "OWNER_CLOCK_REVERSED");
		this.#last = BigInt(monotonicNs);
		return value;
	}
	capture<T>(
		eventMeaning: string,
		transition: () => T,
	): { value: T; witness: OriginalClockWitness; sequence: string; eventMeaning: string } {
		let discarded: unknown;
		try {
			this.check();
			assert(!this.#active, "OWNER_CLOCK_REENTRY");
			assert(typeof eventMeaning === "string" && /^[a-z][a-z0-9-]{0,95}$/.test(eventMeaning), "OWNER_CLOCK_EVENT");
			this.#active = true;
			try {
				const before = this.#observe();
				const value = transition();
				discarded = value;
				this.check();
				// Do not issue an after-edge for an unfinished asynchronous transition.
				assert(
					value === null || (typeof value !== "object" && typeof value !== "function") || !("then" in value),
					"OWNER_CLOCK_ASYNC_TRANSITION",
				);
				const after = this.#observe();
				assert(
					BigInt(after.monotonicNs) - BigInt(before.monotonicNs) <= this.#maxBracket,
					"OWNER_CLOCK_BRACKET_EXCEEDED",
				);
				this.check();
				return {
					value,
					sequence: String(++this.#sequence),
					eventMeaning,
					witness: Object.freeze({
						version: 1,
						kind: "original-native-clock-witness",
						before: Object.freeze({ ...before, timeNamespace: Object.freeze(before.timeNamespace) }),
						after: Object.freeze({ ...after, timeNamespace: Object.freeze(after.timeNamespace) }),
					}),
				};
			} finally {
				this.#active = false;
			}
		} catch (cause) {
			this.#failure ??= { cause };
			// Seal first. Deferred assimilation also contains hostile then getters;
			// a forbidden rejection must not escape the synchronous refusal.
			observeRejectedSyncResult(discarded);
			throw this.#failure.cause;
		}
	}
}

export interface HistoricalExposureAudit {
	readonly exposureLost: boolean;
	bindExposureSink(sink: (frame: OrdinaryExposureFrame, receipt: OrdinaryExposureReceipt) => void): void;
	exposureTransition(frame: OrdinaryExposureFrame, receipt: OrdinaryExposureReceipt, transition: () => void): void;
	exposure(frame: OrdinaryExposureFrame, receipt: OrdinaryExposureReceipt): void;
	validatedSetup(): never;
}

export function createHistoricalExposureAudit(input: {
	scope: { ownerEpoch: string; sessionId: string; allocationId: string };
	read: () => NativeClockSample;
	monotonic: () => number;
	wallTime: () => number;
}): HistoricalExposureAudit {
	const evidence = new OriginalClockEvidence(input.read, "10");
	const ordinaryClock = {
		capture: <T>(name: string, transition: () => T) => evidence.capture(name, transition),
		monotonic: input.monotonic,
		wallTime: input.wallTime,
	};
	const hasOriginalClockEvidence = () => true;
	class HistoricalAudit {
		readonly #scope = Object.freeze({ ...input.scope });
		readonly clock = ordinaryClock;
		readonly clockIdentity = { id: "MOCK-historical-clock" };
		readonly #maxRequestBytes = 65536;
		readonly #requests = new Map<object, unknown>();
		readonly #exposures = new Map<
			string,
			{ frame: OrdinaryExposureFrame; receipt: OrdinaryExposureReceipt; at: NativeAuditStamp }
		>();
		readonly #setup = {
			baseline(): never {
				throw new Error("MOCK_LEGACY_SETUP_UNAVAILABLE");
			},
		};
		#exposureSink?: (frame: OrdinaryExposureFrame, receipt: OrdinaryExposureReceipt) => void;
		#exposureTransitionFailure?: { cause: unknown };
		#pendingExposure?: { frame: OrdinaryExposureFrame; receipt: OrdinaryExposureReceipt; at: NativeAuditStamp };
		#exposureTransitionActive = false;
		#exposureBytes = 0;
		#exposureLost = false;
		// Test-only readback of the historical bounded-retention state.
		get exposureLost(): boolean {
			return this.#exposureLost;
		}
		#closed = false;
		#lost = false;
		// No active audit window in these retained scenarios. Original event()
		// increments a sequence then returns; no event sample/publication follows.
		#sequence = 0;
		event(_source: string, _kind: string, _requestId: string): void {
			this.#sequence++;
		}
		#stamp(eventMeaning?: string): NativeAuditStamp {
			if (eventMeaning && hasOriginalClockEvidence()) {
				const observed = ordinaryClock.capture(eventMeaning, () => this.#stamp());
				return {
					...observed.value,
					parent: observed.witness,
					clockSequence: observed.sequence,
					eventMeaning: observed.eventMeaning,
				};
			}
			return {
				monotonicMs: this.clock.monotonic(),
				wallMs: this.clock.wallTime(),
				clockId: this.clockIdentity.id,
				uncertaintyMs: null,
			};
		}

		validatedSetup() {
			if (this.#closed || this.#lost) throw new Error("OWNER_SC085_SETUP_AUDIT_LOST");
			return this.#setup.baseline();
		}

		/** Forward only the original validated Core callback. The Foundation adapter
		 * retains/matches it; Pi does not implement a second common-exposure matcher. */
		bindExposureSink(sink: (frame: OrdinaryExposureFrame, receipt: OrdinaryExposureReceipt) => void): void {
			if (this.#closed || this.#exposureSink || this.#requests.size) throw new Error("OWNER_AUDIT_SINK_BOUND");
			this.#exposureSink = sink;
		}

		/** Core calls this around its actual accepted mutation, BEFORE evidence
		 * delivery. The later exposure callback consumes, never resamples, this edge. */
		exposureTransition(frame: OrdinaryExposureFrame, receipt: OrdinaryExposureReceipt, transition: () => void): void {
			let discarded: unknown;
			try {
				if (this.#exposureTransitionFailure) throw this.#exposureTransitionFailure.cause;
				if (
					this.#closed ||
					this.#lost ||
					this.#pendingExposure ||
					this.#exposureTransitionActive ||
					frame.ownerEpoch !== this.#scope.ownerEpoch ||
					receipt.ownerEpoch !== this.#scope.ownerEpoch ||
					frame.scope.sessionId !== this.#scope.sessionId ||
					receipt.scope.sessionId !== this.#scope.sessionId
				)
					throw new Error("OWNER_EXPOSURE_TRANSITION");
				this.#exposureTransitionActive = true;
				const originals = structuredClone({ frame, receipt });
				const captured = ordinaryClock.capture("core-exposure-transition", () => {
					const result: unknown = transition();
					discarded = result;
					if (result !== undefined) throw new Error("OWNER_EXPOSURE_TRANSITION_SYNC");
					if (this.#exposureTransitionFailure) throw this.#exposureTransitionFailure.cause;
					if (this.#closed || this.#lost) throw new Error("OWNER_EXPOSURE_TRANSITION_LOST");
					return this.#stamp();
				});
				if (!isDeepStrictEqual(originals, { frame, receipt })) throw new Error("OWNER_EXPOSURE_TRANSITION_CHANGED");
				this.#pendingExposure = {
					...originals,
					at: {
						...captured.value,
						parent: captured.witness,
						clockSequence: captured.sequence,
						eventMeaning: captured.eventMeaning,
					},
				};
			} catch (cause) {
				this.#lost = true;
				this.#exposureTransitionFailure ??= { cause };
				// This wrapper discards before outer capture receives a value. Seal
				// audit/clock failure before assimilating any forbidden thenable.
				observeRejectedSyncResult(discarded);
				throw this.#exposureTransitionFailure.cause;
			} finally {
				this.#exposureTransitionActive = false;
			}
		}

		exposure(frame: OrdinaryExposureFrame, receipt: OrdinaryExposureReceipt): void {
			if (this.#closed) {
				this.#lost = true;
				return;
			}
			try {
				if (
					frame.ownerEpoch !== this.#scope.ownerEpoch ||
					receipt.ownerEpoch !== this.#scope.ownerEpoch ||
					frame.scope.sessionId !== this.#scope.sessionId ||
					receipt.scope.sessionId !== this.#scope.sessionId
				) {
					this.#lost = true;
					return;
				}
				const key = JSON.stringify([receipt.decisionId, receipt.attemptId]);
				const pending = this.#pendingExposure;
				if (
					hasOriginalClockEvidence() &&
					(!pending ||
						this.#exposureTransitionActive ||
						!isDeepStrictEqual({ frame: pending.frame, receipt: pending.receipt }, { frame, receipt }))
				)
					throw new Error("OWNER_EXPOSURE_TRANSITION_MISSING");
				this.#pendingExposure = undefined;
				const retained = structuredClone({ frame, receipt, at: pending?.at ?? this.#stamp() });
				const bytes = Buffer.byteLength(JSON.stringify(retained), "utf8");
				if (
					this.#exposures.has(key) ||
					this.#exposures.size >= 8 ||
					bytes > this.#maxRequestBytes - this.#exposureBytes
				) {
					this.#exposureLost = true;
				} else {
					this.#exposureBytes += bytes;
					this.#exposures.set(key, retained);
				}
				this.#exposureSink?.(frame, receipt);
				this.event("owner", "common-exposure-observed", receipt.requestId);
			} catch {
				this.#lost = true;
			}
		}
	}
	return new HistoricalAudit();
}
