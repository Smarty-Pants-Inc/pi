import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OrdinaryAutomaticHold } from "./ordinary-automatic-hold.ts";
import type { OrdinaryOwnerContext } from "./ordinary-owner-context.ts";
import type { OrdinaryObservedRefresh, SetupRawRef } from "./ordinary-sc085-setup.ts";
import {
	checkSc085Operation,
	guardSc085OriginalCallback,
	qualifySc085OriginalStamp,
	receiveSc085ChildBinding,
	receiveSc085OriginalStorage,
	type Sc085OriginalReceiving,
} from "./ordinary-sc085-source/operational-admission.ts";
import { parseSc085Admission, sc085RetainedBytes } from "./ordinary-sc085-source/sc085-admission.ts";

/** Original context only: fixed Source authentication, existing admission gate,
 * provenance and audit. This creates neither an issuer nor another wake path. */
export function createOriginalSc085(
	context: OrdinaryOwnerContext,
	receiving: Sc085OriginalReceiving,
	gate: OrdinaryAutomaticHold,
) {
	const bound = receiveSc085ChildBinding(receiving, context);
	const storage = receiveSc085OriginalStorage(receiving, context);
	const admission = guardSc085OriginalCallback(receiving, () =>
		parseSc085Admission(sc085RetainedBytes(bound.admission, storage.retained)),
	);
	const audit = context.operationalAudit;
	let failure: { cause: unknown } | undefined;
	let deadlineTimer: unknown;
	let cancelWait: ((cause: unknown) => void) | undefined;
	let state:
		| {
				token: object;
				segment: "rapid" | "failures";
				phase: "held" | "released" | "sealing" | "sealed" | "finishing" | "finished";
				cursor: object;
				deadline: number;
				raw?: SetupRawRef;
				releaseCursor?: object;
				requestId?: string;
		  }
		| undefined;
	const cancel = (cause: unknown) => {
		failure ??= { cause };
		if (deadlineTimer !== undefined) audit.clock.clearTimeout(deadlineTimer);
		deadlineTimer = undefined;
		gate.fail(failure.cause);
		cancelWait?.(failure.cause);
	};
	const check = (operation: "burst" | "boundary" = "burst") => {
		if (failure) throw failure.cause;
		try {
			checkSc085Operation(receiving, context, operation);
			if (
				state &&
				(state.phase === "held" || state.phase === "finishing") &&
				audit.clock.monotonic() >= state.deadline
			) {
				throw new Error("OWNER_SC085_MAX_HOLD");
			}
		} catch (cause) {
			cancel(cause);
			throw failure!.cause;
		}
	};
	const original = (token: object) => {
		if (failure) throw failure.cause;
		if (!state || state.token !== token) throw new Error("OWNER_SC085_HOLD_TOKEN");
		return state;
	};
	const record = (value: unknown, operation: "burst" | "boundary" = "burst") => {
		check(operation);
		const expected: unknown = JSON.parse(JSON.stringify(value));
		const raw = structuredClone(
			guardSc085OriginalCallback(receiving, () => storage.record(structuredClone(expected))),
		);
		const retained = guardSc085OriginalCallback(receiving, () => storage.retained.get(raw.path));
		assert(
			retained &&
				createHash("sha256").update(retained).digest("hex") === raw.sha256 &&
				isDeepStrictEqual(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(retained)), expected),
			"OWNER_SC085_RECORDER",
		);
		check(operation);
		return raw;
	};
	const wait = (ms: number) =>
		new Promise<void>((resolve, reject) => {
			const timer = audit.clock.setTimeout(() => {
				cancelWait = undefined;
				resolve();
			}, ms);
			cancelWait = (cause) => {
				audit.clock.clearTimeout(timer);
				cancelWait = undefined;
				reject(cause);
			};
		});
	const methods = Object.freeze({
		async hold(selected: SetupRawRef, segment: "rapid" | "failures") {
			try {
				check();
				assert(
					isDeepStrictEqual(selected, bound.admission) && (segment === "rapid" || segment === "failures"),
					"OWNER_SC085_ADMISSION",
				);
				assert(segment === "rapid" ? !state : state?.phase === "sealed", "OWNER_SC085_HOLD_ORDER");
				const baseline = audit.validatedSetup();
				const samples = baseline.event.setup.settlement.samples;
				const expectedWatches = admission.checkpoints[0].watches;
				assert(
					samples.length === expectedWatches.length &&
						samples.some((sample) => sample.watchId === bound.primaryWatchId),
					"OWNER_SC085_SETUP_SCOPE",
				);
				for (const expected of expectedWatches) {
					const setup = samples.find((sample) => sample.watchId === expected.watchId);
					assert(
						setup &&
							setup.request.executionKey === expected.executionKey &&
							(typeof expected.stateNamespace !== "string" ||
								expected.stateNamespace === setup.request.stateNamespace),
						"OWNER_SC085_SETUP_SCOPE",
					);
				}
				const cursor = audit.mark();
				// Refuse a busy original session before parking any admission.
				audit.sc085FailureEvidence(cursor);
				const start = qualifySc085OriginalStamp(receiving, context, { kind: "window", cursor, edge: "start" });
				state = {
					token: Object.freeze({}),
					segment,
					phase: "held",
					cursor,
					// Local timer only; never subtract the local clock from a parent-domain projection.
					deadline: audit.observeSince(cursor).start.monotonicMs + admission.validity.maxHoldMs - 2 * start.uncertaintyMs,
				};
				state.token = gate.hold(segment, () =>
					check(state?.phase === "sealing" || state?.phase === "sealed" ? "boundary" : "burst"),
				);
				check();
				deadlineTimer = audit.clock.setTimeout(
					() => cancel(new Error("OWNER_SC085_MAX_HOLD")),
					Math.max(0, state.deadline - audit.clock.monotonic()),
				);
				state.raw = record({
					kind: "ordinary-sc085-held/1",
					segment,
					admission: bound.admission,
					binding: bound.binding,
					baseline: baseline.raw,
					start,
				});
				return { token: state.token, raw: state.raw };
			} catch (cause) {
				cancel(cause);
				throw failure!.cause;
			}
		},
		checkHeld(token: object): void {
			try {
				original(token);
				check();
				gate.checkHeld(token);
			} catch (cause) {
				cancel(cause);
				throw failure!.cause;
			}
		},
		async release(token: object, checkpoint: OrdinaryObservedRefresh) {
			try {
				const held = original(token);
				check();
				gate.checkHeld(token);
				assert(held.segment === "rapid" && held.phase === "held", "OWNER_SC085_RELEASE_ORDER");
				const final = guardSc085OriginalCallback(receiving, () =>
					audit.validateSc085Checkpoint(checkpoint, storage.retained),
				);
				assert(
					final.settlement.samples.length === admission.checkpoints[0].watches.length &&
						final.settlement.samples.some((sample) => sample.watchId === bound.primaryWatchId),
					"OWNER_SC085_FINAL_SAMPLE",
				);
				for (const expected of admission.checkpoints[0].watches) {
					const sample = final.settlement.samples.find((sample) => sample.watchId === expected.watchId);
					assert(
						sample &&
							sample.request.executionKey === expected.executionKey &&
							sample.result.outcome === expected.outcome &&
							sample.result.body === expected.body &&
							(expected.diagnostic === null ? sample.result.diagnosticRef === undefined : false),
						"OWNER_SC085_FINAL_SAMPLE",
					);
				}
				held.releaseCursor = audit.mark();
				const released = qualifySc085OriginalStamp(receiving, context, {
					kind: "window",
					cursor: held.releaseCursor,
					edge: "start",
				});
				check();
				held.phase = "released";
				if (deadlineTimer !== undefined) audit.clock.clearTimeout(deadlineTimer);
				deadlineTimer = undefined;
				const captured = await context.requestProvenance.captureAutomatic(
					(enroll) => gate.release(token, enroll),
					Math.min(admission.validity.expiresWallMs, context.decision.allocation.expiresMs),
					(reservation) => {
						check();
						const row = audit.joinedRequest(reservation);
						assert(
							row.nativeAccepted && row.nativeOperationRetired && row.kind === "with-view",
							"OWNER_SC085_AUTOMATIC_ACCEPTANCE",
						);
						const exposed = audit.requestExposure(row.requestId);
						assert(
							exposed.frame.hash === final.settlement.publication.hash &&
								exposed.frame.revision === final.settlement.publication.revision,
							"OWNER_SC085_FINAL_EXPOSURE",
						);
						return { requestId: row.requestId };
					},
				);
				held.requestId = captured.requestId;
				const correlation = record({
					kind: "ordinary-sc085-automatic-correlation/1",
					hold: held.raw,
					released,
					checkpoint: final,
					requestId: captured.requestId,
					request: audit.requestEvidence(captured.requestId),
					exposure: audit.requestExposure(captured.requestId),
				});
				return { requestId: captured.requestId, correlation };
			} catch (cause) {
				cancel(cause);
				throw failure!.cause;
			}
		},
		async seal(token: object, requestId: string) {
			try {
				const held = original(token);
				check("boundary");
				assert(
					held.phase === "released" && held.releaseCursor && held.requestId === requestId,
					"OWNER_SC085_SEAL_ORDER",
				);
				held.phase = "sealing";
				const exposure = qualifySc085OriginalStamp(receiving, context, { kind: "exposure", requestId });
				let previousObserved = BigInt(exposure.monotonicNs);
				const requiredNs = BigInt(admission.observation.unchangedMs) * 1_000_000n;
				let wakes = 0;
				// At most one initial wait and one qualified early-wake correction.
				// Refusal never shortens the required absolute observation interval.
				for (;;) {
					check("boundary");
					const measured = audit.sc085RapidEvidence(held.cursor, held.releaseCursor, requestId);
					const end = qualifySc085OriginalStamp(receiving, context, {
						kind: "window",
						cursor: measured.observedCursor,
						edge: "start",
					});
					assert.equal(end.clockId, exposure.clockId, "OWNER_SC085_SEAL_CLOCK_JOIN");
					assert.deepEqual(end.basis, exposure.basis, "OWNER_SC085_SEAL_BASIS_JOIN");
					// Join the entire original stamp (including witness, sequence and meaning),
					// not equality between local milliseconds and a parent-domain projection.
					for (const [qualified, originalStamp] of [
						[end, measured.observedUntil],
						[exposure, measured.exposureAt],
					] as const) {
						const original: unknown = guardSc085OriginalCallback(receiving, () =>
							JSON.parse(sc085RetainedBytes(qualified.original, storage.retained).toString("utf8")),
						);
						assert(original !== null && typeof original === "object", "OWNER_SC085_SEAL_ORIGINAL");
						assert.deepEqual((original as Record<string, unknown>).stamp, originalStamp, "OWNER_SC085_SEAL_ORIGINAL");
						assert(originalStamp.parent && originalStamp.clockSequence && originalStamp.eventMeaning, "OWNER_SC085_SEAL_WITNESS");
						assert.equal(qualified.monotonicNs, originalStamp.parent.after.monotonicNs, "OWNER_SC085_SEAL_AFTER");
					}
					const endNs = BigInt(end.monotonicNs);
					assert(endNs >= BigInt(exposure.monotonicNs), "OWNER_SC085_SEAL_CLOCK_REGRESSION");
					const elapsedNs = endNs - BigInt(exposure.monotonicNs) - BigInt(exposure.uncertaintyNs) - BigInt(end.uncertaintyNs);
					assert(
						measured.startsWhileHeld === 0 &&
							measured.pendingPeak <= 1 &&
							measured.concurrentTurnPeak <= 1 &&
							measured.automaticTurns === 1 &&
							measured.otherRunStarts === 0 &&
							measured.repeatedUnchangedWakes === 0,
						"OWNER_SC085_COALESCING",
					);
					if (elapsedNs < requiredNs) {
						assert(
							wakes < 2 && (wakes === 0 || endNs > previousObserved),
							"OWNER_SC085_OBSERVATION_NO_PROGRESS",
						);
						previousObserved = endNs;
						wakes++;
						const remaining = context.inspectCurrentPermission().remainingMs;
						assert(remaining > 0, "OWNER_SC085_OBSERVATION_EXPIRED");
						// Scheduling projection only, rounded up. Acceptance after waking stays exact ns.
						const waitMs = Number((requiredNs - elapsedNs + 999_999n) / 1_000_000n);
						assert(Number.isSafeInteger(waitMs) && waitMs > 0, "OWNER_SC085_SEAL_WAIT_RANGE");
						await wait(Math.min(waitMs, remaining));
						continue;
					}
					const { observedCursor, ...evidence } = measured;
					const raw = record(
						{
							kind: "ordinary-sc085-sealed/1",
							hold: held.raw,
							requestId,
							evidence,
							exposure,
							end,
							guaranteedUnchangedNs: String(elapsedNs),
							guaranteedUnchangedMs: Number(elapsedNs / 1_000_000n),
							requiredUnchangedNs: String(requiredNs),
							requiredUnchangedMs: admission.observation.unchangedMs,
						},
						"boundary",
					);
					assert(audit.observeSince(observedCursor).events.length === 0, "OWNER_SC085_SEAL_REENTRANCY");
					gate.sealed(token);
					held.phase = "sealed";
					const fact = (value: number) => ({ value, raw, unknown: null });
					return {
						raw,
						startsWhileHeld: fact(measured.startsWhileHeld),
						pendingPeak: fact(measured.pendingPeak),
						concurrentTurnPeak: fact(measured.concurrentTurnPeak),
						automaticTurns: fact(measured.automaticTurns),
						repeatedUnchangedWakes: fact(measured.repeatedUnchangedWakes),
					};
				}
			} catch (cause) {
				cancel(cause);
				throw failure!.cause;
			}
		},
		async finishFailures(token: object) {
			try {
				const held = original(token);
				check();
				gate.checkHeld(token);
				assert(held.segment === "failures" && held.phase === "held", "OWNER_SC085_FAILURE_ORDER");
				held.phase = "finishing";
				await gate.finishFailures(token);
				// Let the original awaiting Core admission settle its own intention.
				await Promise.resolve();
				check();
				const measured = audit.sc085FailureEvidence(held.cursor);
				assert(
					measured.starts === 0 && measured.turns === 0 && measured.requests === 0,
					"OWNER_SC085_FAILURE_STARTED_TURN",
				);
				const end = qualifySc085OriginalStamp(receiving, context, {
					kind: "window",
					cursor: measured.endCursor,
					edge: "start",
				});
				const { endCursor, ...evidence } = measured;
				const raw = record({ kind: "ordinary-sc085-failures-finished/1", hold: held.raw, evidence, end });
				assert(audit.observeSince(endCursor).events.length === 0, "OWNER_SC085_FAILURE_REENTRANCY");
				held.phase = "finished";
				if (deadlineTimer !== undefined) audit.clock.clearTimeout(deadlineTimer);
				deadlineTimer = undefined;
				return raw;
			} catch (cause) {
				cancel(cause);
				throw failure!.cause;
			}
		},
	});
	return Object.freeze({ methods, cancel });
}
