import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { observeRejectedSyncResult } from "../utils/observe-rejected-sync-result.ts";
import { OriginalClockEvidence, type OriginalClockObservation } from "./ordinary-clock-evidence.ts";
import { receiveOriginalClockSource } from "./owner-effects.ts";

type Ref = { path: string; sha256: string };
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

/** SAME original local scheduling/raw clock object. Parent-domain witnesses
 * remain separate evidence; performance.now is never relabeled or offset. */
export const ordinaryClock = Object.freeze({
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

/** Decode the SAME held producer bytes before A. This finite preparation ceiling
 * is DATA only; original post-A receiving must rejoin the selected contract. */
export function readOrdinaryClockPreparation(
	producer: Ref,
	raw: Uint8Array,
): { maxBracketNs: string; guardSource: Ref } {
	assert(
		raw.byteLength <= 65536 && createHash("sha256").update(raw).digest("hex") === producer.sha256,
		"OWNER_CLOCK_PRODUCER_BYTES",
	);
	const declaration: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
	assert(
		declaration !== null && typeof declaration === "object" && !Array.isArray(declaration),
		"OWNER_CLOCK_PRODUCER_OBJECT",
	);
	const preparation: unknown = (declaration as Record<string, unknown>).clockPreparation;
	assert(
		preparation !== null && typeof preparation === "object" && !Array.isArray(preparation),
		"OWNER_CLOCK_PREPARATION_OBJECT",
	);
	const value = preparation as Record<string, unknown>;
	assert.deepEqual(
		Object.keys(value).sort(),
		["version", "kind", "maxBracketNs", "guardSource"].sort(),
		"OWNER_CLOCK_PREPARATION_FIELDS",
	);
	assert(value.version === 1 && value.kind === "original-native-clock-preparation", "OWNER_CLOCK_PREPARATION_KIND");
	assert(
		typeof value.maxBracketNs === "string" &&
			/^[1-9][0-9]{0,19}$/.test(value.maxBracketNs) &&
			BigInt(value.maxBracketNs) <= 1_000_000_000n,
		"OWNER_CLOCK_BRACKET_CAP",
	);
	assert(
		value.guardSource !== null && typeof value.guardSource === "object" && !Array.isArray(value.guardSource),
		"OWNER_CLOCK_GUARD_SOURCE",
	);
	const source = value.guardSource as Record<string, unknown>;
	assert.deepEqual(Object.keys(source).sort(), ["path", "sha256"], "OWNER_CLOCK_GUARD_SOURCE_FIELDS");
	assert(
		typeof source.path === "string" &&
			source.path.startsWith("/") &&
			!/[\u0000-\u001f\u007f]/.test(source.path) &&
			!source.path
				.split("/")
				.slice(1)
				.some((part) => !part || part === "." || part === "..") &&
			typeof source.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(source.sha256),
		"OWNER_CLOCK_GUARD_SOURCE_REF",
	);
	return { maxBracketNs: value.maxBracketNs, guardSource: { path: source.path, sha256: source.sha256 } };
}

/** Private original entry route, before factory/A/ANY local sample. Verifies
 * artifacts only, never validateHost/activation/allocation. Execution of this
 * source still requires a selected successor addon; source tests mock the port. */
export function prepareOrdinaryClock(input: { profile: Ref; producer: Ref; maxBracketNs: string; guardSource: Ref }) {
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

/** The local sample is captured at the original transition, within its native
 * edges. An observer receives this record later without resampling it. */
export function captureOrdinaryClockObservation<T>(
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

export function hasOriginalClockEvidence(): boolean {
	healthy();
	return evidence !== undefined;
}

/** Original receiving consumes the stored pre-A witness, never caller-supplied
 * return data or a fresh sample substituted after A. */
export function originalClockInitialObservation(): OriginalClockObservation {
	healthy();
	assert(initialObservation, "OWNER_CLOCK_NOT_PREPARED");
	return structuredClone(initialObservation);
}

/** Original receiving only. Association DATA is not permission/qualification. */
export function originalClockAssociation() {
	healthy();
	assert(association && evidence, "OWNER_CLOCK_NOT_PREPARED");
	return structuredClone(association);
}
