// Historical callback-contract fixture ONLY. The effect method below is copied
// byte-for-byte from the frozen pre-C6 production SessionOwnership source; see
// COMPLETION-MIGRATION-DATA.json. This class is NOT an authentic owner factory.
// Only its minimal host scaffolding and modeled clock port differ. No new Promise
// rejection handler is supplied by tests: the retained production effect body
// calls the unchanged production observeRejectedSyncResult helper itself.
// No implementation here is exported by the package or used by production.
import { AsyncLocalStorage } from "node:async_hooks";
import { createGate, type GateControl } from "@earendil-works/pi-agent-core";
import type { ResponsesEvidence } from "@earendil-works/pi-ai/api/responses-evidence";
import {
	beginOrdinaryClockOperation,
	commitOrdinaryClockOperation,
	failOrdinaryClockOperation,
} from "../../src/core/ordinary-clock.ts";
import type { OriginalClockObservation } from "../../src/core/ordinary-clock-evidence.ts";
import type { OwnedCountRequest } from "../../src/core/ordinary-provider-transport.ts";
import type {
	OwnedJournal as CurrentOwnedJournal,
	OwnedEffectRequest,
	OwnedTreeFile,
	OwnedTreeLimits,
} from "../../src/core/owner-effects.ts";
import type { OwnedEffect } from "../../src/core/session-ownership.ts";
import { observeRejectedSyncResult } from "../../src/utils/observe-rejected-sync-result.ts";

export type HistoricalOperation = Omit<ReturnType<CurrentOwnedJournal["beginOperation"]>, "complete"> & {
	complete(failed: boolean, observe?: (complete: () => void) => void): Promise<void>;
};
export interface OwnedJournal {
	assertActive(): void;
	quarantine(): void;
	beginOperation(request: OwnedEffectRequest): HistoricalOperation;
}
interface PendingEffect {
	control: GateControl;
	settled: Promise<void>;
}
const context = new AsyncLocalStorage<HistoricalCompletionOwner>();
const effectOperations = new WeakMap<OwnedEffect, HistoricalOperation>();

// Modeled historical clock port for synchronous receipt.complete ONLY. Fixed
// current tickets replace the removed production capture export. Hostile observer
// results never enter this port; they reach the byte-exact effect method below.
function captureOrdinaryClockObservation(event: string, complete: () => void) {
	try {
		const ticket = beginOrdinaryClockOperation(event);
		complete();
		return { observation: commitOrdinaryClockOperation(ticket) };
	} catch (cause) {
		return failOrdinaryClockOperation(cause);
	}
}

export class HistoricalCompletionOwner {
	readonly #journal: OwnedJournal;
	readonly #pending = new Set<PendingEffect>();
	#phase: "active" | "quarantined" = "active";
	constructor(journal: OwnedJournal) {
		this.#journal = journal;
	}
	get phase() {
		return this.#phase;
	}
	assertActive(): void {
		if (this.#phase !== "active") throw new Error("STALE_OWNER");
		this.#journal.assertActive();
	}
	within<T>(action: () => T): T {
		this.assertActive();
		return context.run(this, action);
	}

	async effect<T>(
		request: OwnedEffectRequest,
		action: (effect: OwnedEffect) => Promise<T> | T,
		options: { signal?: AbortSignal; completed?: (original: OriginalClockObservation) => void } = {},
	): Promise<T> {
		const signal = options.signal;
		this.assertActive();
		signal?.throwIfAborted();
		const { gate, control } = createGate();
		const abort = () =>
			control.close(
				signal?.reason instanceof Error
					? signal.reason
					: new Error("OWNER_EFFECT_ABORT", { cause: signal?.reason }),
			);
		let settled!: () => void;
		const pending: PendingEffect = {
			control,
			settled: new Promise((resolve) => {
				settled = resolve;
			}),
		};
		let operation: ReturnType<OwnedJournal["beginOperation"]> | undefined;
		let result: T | undefined;
		const errors: unknown[] = [];
		// Own preparation before request access can reenter close. Native copies
		// and rechecks its exact admission again before attaching the obligation.
		this.#pending.add(pending);
		try {
			operation = this.#journal.beginOperation(request);
			const retained = operation;
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			const dispatch = <R>(action: () => R): R =>
				gate.admit(() => {
					this.assertActive();
					retained.check();
					return context.run(this, action);
				});
			const effect: OwnedEffect = Object.freeze({
				signal: gate.signal,
				dispatch,
				provider: (
					request: Request,
					wireModel: string,
					maxResponseBytes: number,
					beforeSend: (request: Request, bytes: Uint8Array) => Request,
					record: (evidence: Readonly<ResponsesEvidence>) => void,
					count?: OwnedCountRequest,
				) => dispatch(() => retained.provider(request, wireModel, maxResponseBytes, beforeSend, record, count)),
				readFile: (path: string) => dispatch(() => retained.readFile(path)),
				writeFile: (path: string, bytes: Uint8Array, previous?: Uint8Array) => {
					const next = Buffer.from(bytes),
						before = previous === undefined ? undefined : Buffer.from(previous);
					dispatch(() => retained.writeFile(path, next, before));
				},
				listDirectories: (path: string) => dispatch(() => retained.listDirectories(path)),
				readTree: (path: string, limits: OwnedTreeLimits) => dispatch(() => retained.readTree(path, limits)),
				createSnapshot: (parent: string, revision: string, files: readonly OwnedTreeFile[]) => {
					const copied = files.map(({ path, mode, bytes }) => ({ path, mode, bytes: Buffer.from(bytes) }));
					return dispatch(() => retained.createSnapshot(parent, revision, copied));
				},
				removeSnapshot: (path: string) => dispatch(() => retained.removeSnapshot(path)),
			});
			effectOperations.set(effect, retained);
			gate.signal.throwIfAborted();
			result = await context.run(this, () => action(effect));
		} catch (error) {
			errors.push(error);
		}
		let observerResult: unknown;
		try {
			await operation?.complete(
				errors.length > 0,
				options.completed && !errors.length
					? (complete) => {
							// Persistence has settled, but this original receipt is not yet
							// accepted. Capture its one-use completion, not worker readiness.
							const original = captureOrdinaryClockObservation("native-operation-completion", complete);
							observerResult = options.completed!(original.observation);
							if (observerResult !== undefined) throw new Error("OWNER_COMPLETION_OBSERVER_SYNC");
						}
					: undefined,
			);
		} catch (error) {
			errors.push(error);
			this.#phase = "quarantined";
			try {
				this.#journal.quarantine();
			} catch (cleanup) {
				errors.push(cleanup);
			}
			// No new completion/persistence attempt. A before-edge failure uses
			// only the retained receipt; constructor/species limits remain C6.
			observeRejectedSyncResult(observerResult);
		}
		signal?.removeEventListener("abort", abort);
		this.#pending.delete(pending);
		settled();
		if (errors.length === 1) throw errors[0];
		if (errors.length) throw new AggregateError(errors, "OWNER_EFFECT_SETTLEMENT");
		return result as T;
	}
}
