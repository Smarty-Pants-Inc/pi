import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
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
	__proto__: null,
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
		evidence = new OriginalClockEvidence(input.maxBracketNs);
		const first = beginOrdinaryClockOperation("pre-a-initial");
		initialObservation = commitOrdinaryClockOperation(first);
		return structuredClone({ ...association, initial: initialObservation });
	} catch (cause) {
		failure ??= { cause };
		throw failure.cause;
	}
}

/** Internal source-operation edges, never re-exported by ./ordinary. No callback
 * or supplied sample is accepted. The operation retains its ticket before effect. */
export function beginOrdinaryClockOperation(event: string): object {
	healthy();
	assert(evidence && association, "OWNER_CLOCK_NOT_PREPARED");
	return evidence.begin(event);
}

export function finishOrdinaryClockOperation(ticket: object) {
	healthy();
	assert(evidence && association, "OWNER_CLOCK_NOT_PREPARED");
	return evidence.commit(ticket);
}

export function commitOrdinaryClockOperation(ticket: object): OriginalClockObservation {
	try {
		healthy();
		assert(evidence && association, "OWNER_CLOCK_NOT_PREPARED");
		evidence.checkOperation(ticket);
		const local = { monotonicMs: ordinaryClock.monotonic(), wallMs: ordinaryClock.wallTime() };
		const captured = finishOrdinaryClockOperation(ticket);
		return { local, parent: captured.witness, sequence: captured.sequence, eventMeaning: captured.eventMeaning };
	} catch (cause) {
		return failOrdinaryClockOperation(cause);
	}
}

export function failOrdinaryClockOperation(cause: unknown): never {
	if (evidence) {
		try {
			evidence.fail(cause);
		} catch (first) {
			failure ??= { cause: first };
		}
	} else failure ??= { cause };
	throw failure!.cause;
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
