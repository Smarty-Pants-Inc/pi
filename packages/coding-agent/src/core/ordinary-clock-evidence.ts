import assert from "node:assert/strict";
import { observeRejectedSyncResult } from "../utils/observe-rejected-sync-result.ts";

/** Read-only original-addon DATA. No permission or qualified clock is implied. */
export interface NativeClockSample {
	monotonicNs: string;
	bootId: string;
	timeNamespace: { device: string; inode: string };
	pid: number;
}
export interface OriginalClockWitness {
	version: 1;
	kind: "original-native-clock-witness";
	before: NativeClockSample;
	after: NativeClockSample;
}

export interface OriginalClockObservation {
	local: { monotonicMs: number; wallMs: number };
	parent: OriginalClockWitness;
	sequence: string;
	eventMeaning: string;
}

function unsigned(value: unknown): bigint {
	assert(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value), "OWNER_CLOCK_INTEGER");
	return BigInt(value);
}
/** Display projection only. Compute the actual binary64 rounding error in ns,
 * rounded UP; a receiver must compare it with the independently admitted adapter
 * allowance. All event/duration/deadline acceptance still uses integer ns. */
export function projectClockNanoseconds(monotonicNs: string) {
	const original = unsigned(monotonicNs);
	const monotonicMs = Number(original) / 1_000_000;
	const bits = new DataView(new ArrayBuffer(8));
	bits.setFloat64(0, monotonicMs);
	const encoded = bits.getBigUint64(0),
		exponent = Number((encoded >> 52n) & 2047n);
	const mantissa = (encoded & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
	const power = (exponent || 1) - 1023 - 52;
	const denominator = power < 0 ? 1n << BigInt(-power) : 1n;
	const numerator = mantissa * 1_000_000n * (power > 0 ? 1n << BigInt(power) : 1n);
	const difference = original * denominator - numerator;
	const absolute = difference < 0n ? -difference : difference;
	return { monotonicNs, monotonicMs, conversionErrorNs: String((absolute + denominator - 1n) / denominator) };
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
					witness: Object.freeze({ version: 1, kind: "original-native-clock-witness", before: Object.freeze({ ...before, timeNamespace: Object.freeze(before.timeNamespace) }), after: Object.freeze({ ...after, timeNamespace: Object.freeze(after.timeNamespace) }) }),
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
