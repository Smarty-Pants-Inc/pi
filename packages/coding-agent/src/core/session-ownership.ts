import { AsyncLocalStorage } from "node:async_hooks";
import { basename, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { createGate, type GateControl } from "@earendil-works/pi-agent-core";
import type { ResponsesEvidence } from "@earendil-works/pi-ai/api/responses-evidence";
import { observeRejectedSyncResult } from "../utils/observe-rejected-sync-result.ts";
import { captureOrdinaryClockObservation } from "./ordinary-clock.ts";
import type { OriginalClockObservation } from "./ordinary-clock-evidence.ts";
import type { OwnedCountRequest, OwnedProviderExchange } from "./ordinary-provider-transport.ts";
import {
	type OwnedEffectRequest,
	OwnedJournal,
	type OwnedProcessRequest,
	type OwnedTreeFile,
	type OwnedTreeLimits,
	type OwnerAdmission,
	type OwnerAdmissionPolicy,
	type OwnerAllocationClaim,
	type OwnerHost,
} from "./owner-effects.ts";
import { persistOwnedTerminalSession, SessionManager } from "./session-manager.ts";

const inspectOriginalJournalResources = OwnedJournal.prototype.inspectResources;
const inspectOriginalJournalPermission = OwnedJournal.prototype.inspectPermission;
const constructionKey = Symbol("session-ownership");
const owners = new WeakMap<SessionManager, SessionOwnership>();
const context = new AsyncLocalStorage<SessionOwnership>();
const effectOperations = new WeakMap<OwnedEffect, ReturnType<OwnedJournal["beginOperation"]>>();

type Phase = "opening" | "active" | "draining" | "terminal" | "closed" | "quarantined";

export interface OwnedEffect {
	readonly signal: AbortSignal;
	/** Synchronous final dispatch: no await or callback precedes the effect. */
	dispatch<T>(action: () => T): T;
	provider(
		request: Request,
		wireModel: string,
		maxResponseBytes: number,
		beforeSend: (request: Request, bytes: Uint8Array) => Request,
		record: (evidence: Readonly<ResponsesEvidence>) => void,
		count?: OwnedCountRequest,
	): OwnedProviderExchange;
	readFile(relativePath: string): Buffer;
	writeFile(relativePath: string, bytes: Uint8Array, previous?: Uint8Array): void;
	listDirectories(relativePath: string): string[];
	readTree(relativePath: string, limits: OwnedTreeLimits): OwnedTreeFile[];
	createSnapshot(relativeParent: string, revision: string, files: readonly OwnedTreeFile[]): string;
	removeSnapshot(relativePath: string): void;
}

export interface OwnedProcessOptions {
	signal?: AbortSignal;
	stdin?: string | Uint8Array;
	timeoutMs?: number;
	capture?: boolean;
	onData?: (stream: "stdout" | "stderr", bytes: Buffer) => void | Promise<void>;
}

export interface OwnedProcessResult {
	pid: number;
	stdout: string;
	stderr: string;
	code: number;
	signal: number;
	setupError: { stage: number; errno: number } | undefined;
}

/** Same-owner durable journal surface for the common Sense adapter. Closing a
 * component view does not release the owner or its host. */
export interface OwnedJournalView {
	readonly path: string;
	isUsable(): boolean;
	read(): unknown[];
	flush(manager: Pick<SessionManager, "getSessionId" | "getSessionFile" | "getHeader" | "getEntries">): void;
	quarantine(): void;
	close(): void;
}

interface PendingEffect {
	control: GateControl;
	settled: Promise<void>;
}

/** Data lookup does not brand a caller-supplied manager as owned. */
export function ownershipOf(manager: SessionManager): SessionOwnership | undefined {
	return owners.get(manager);
}

/** Utilities must retain this value in their factory closure, not look up the
 * replacement session when a delayed callback finally dispatches. */
export function currentSessionOwnership(): SessionOwnership | undefined {
	return context.getStore();
}

export class SessionOwnership {
	readonly manager: SessionManager;
	readonly host: OwnerHost;
	readonly #journal: OwnedJournal;
	readonly #allocated: boolean;
	readonly #pending = new Set<PendingEffect>();
	readonly #terminalReady: Promise<void>;
	#allowTerminal!: () => void;
	#phase: Phase = "opening";
	#closeTask?: Promise<void>;
	#closesAt?: number;

	private constructor(
		key: symbol,
		host: OwnerHost,
		manager: SessionManager,
		journal: OwnedJournal,
		allocated = false,
	) {
		if (key !== constructionKey) throw new Error("OWNER_NATIVE_CONSTRUCTION");
		this.host = host;
		this.manager = manager;
		this.#journal = journal;
		this.#allocated = allocated;
		this.#terminalReady = new Promise((resolve) => {
			this.#allowTerminal = resolve;
		});
		owners.set(manager, this);
		Object.freeze(this);
	}

	static create(host: OwnerHost, cwd: string): SessionOwnership {
		return SessionOwnership.#create(host, cwd);
	}

	/** The deterministic exclusion name prevents reuse; it conveys no permission.
	 * Native custody persists the explicit claim before any ticket is returned. */
	static createAllocated(host: OwnerHost, cwd: string, allocation: OwnerAllocationClaim): SessionOwnership {
		if (!/^[0-9a-f]{64}$/.test(allocation.id)) throw new Error("OWNER_ALLOCATION_ID");
		return SessionOwnership.#create(host, cwd, allocation);
	}

	static #create(host: OwnerHost, cwd: string, allocation?: OwnerAllocationClaim): SessionOwnership {
		// Reuse native header construction without filesystem or runtime work.
		const header = SessionManager.inMemory(
			cwd,
			allocation ? { id: `allocation-${allocation.id}` } : undefined,
		).getHeader();
		if (!header) throw new Error("OWNER_HEADER_REQUIRED");
		const name = `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`;
		const journal = OwnedJournal.acquire(host, header.id, name, false, header);
		try {
			const manager = SessionManager.openOwned(cwd, journal);
			manager.persistCurrent();
			if (allocation) journal.claimAllocation(allocation);
			return new SessionOwnership(constructionKey, host, manager, journal, allocation !== undefined);
		} catch (error) {
			try {
				journal.quarantine();
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "OWNER_CREATION_FAILED");
			}
			throw error;
		}
	}

	static async open(host: OwnerHost, file: string, originalRoot?: number): Promise<SessionOwnership> {
		if (dirname(file) !== host.profile.storage.root) throw new Error("OWNER_JOURNAL_SCOPE");
		const name = basename(file);
		const separator = name.indexOf("_");
		if (separator < 0 || !name.endsWith(".jsonl")) throw new Error("OWNER_JOURNAL_SCOPE");
		const id = name.slice(separator + 1, -6);
		const journal = OwnedJournal.acquire(host, id, name, true);
		try {
			await journal.recover(originalRoot);
			const manager = SessionManager.openOwned(host.profile.sandbox.toolRoot, journal);
			return new SessionOwnership(constructionKey, host, manager, journal);
		} catch (error) {
			try {
				journal.quarantine();
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "OWNER_OPEN_FAILED");
			}
			throw error;
		}
	}

	/** Materialization and publication are synchronous under A and B's native
	 * leases. B remains inactive; a later runtime binding failure cannot undo it. */
	forkSelected(leaf: string | null, allocation?: OwnerAllocationClaim): SessionOwnership {
		this.assertActive();
		if (this.#allocated && !allocation) throw new Error("OWNER_FRESH_ALLOCATION_REQUIRED");
		if (allocation && !/^[0-9a-f]{64}$/.test(allocation.id)) throw new Error("OWNER_ALLOCATION_ID");
		const header = SessionManager.inMemory(
			this.manager.getCwd(),
			allocation ? { id: `allocation-${allocation.id}` } : undefined,
		).getHeader();
		if (!header) throw new Error("OWNER_HEADER_REQUIRED");
		const name = `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`;
		const journal = OwnedJournal.acquire(this.host, header.id, name, false, header);
		try {
			const manager = this.manager.forkSelected(leaf, journal);
			if (allocation) journal.claimAllocation(allocation);
			return new SessionOwnership(constructionKey, this.host, manager, journal, allocation !== undefined);
		} catch (error) {
			try {
				journal.quarantine();
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "OWNER_FORK_FAILED");
			}
			throw error;
		}
	}

	journalView(): OwnedJournalView {
		this.assertActive();
		let closed = false;
		const check = () => {
			if (closed) throw new Error("OWNER_JOURNAL_VIEW_CLOSED");
			this.assertActive();
		};
		const checkWrite = () => {
			if (closed) throw new Error("OWNER_JOURNAL_VIEW_CLOSED");
			if (this.#phase === "active") this.assertActive();
			else if (this.#phase === "terminal") this.#journal.assertWritable();
			else throw new Error("STALE_OWNER");
		};
		return Object.freeze({
			path: this.#journal.file,
			isUsable: () => {
				try {
					check();
					return true;
				} catch {
					return false;
				}
			},
			read: () => {
				check();
				const text = new TextDecoder("utf-8", { fatal: true }).decode(this.#journal.read());
				if (!text.endsWith("\n")) throw new Error("OWNER_JOURNAL_PARTIAL_TAIL");
				return text
					.slice(0, -1)
					.split("\n")
					.map((line): unknown => JSON.parse(line));
			},
			flush: (manager: Pick<SessionManager, "getSessionId" | "getSessionFile" | "getHeader" | "getEntries">) => {
				checkWrite();
				if (manager !== this.manager) {
					this.quarantine();
					throw new Error("OWNER_JOURNAL_SCOPE");
				}
				try {
					this.manager.persistCurrent();
				} catch (error) {
					try {
						this.quarantine();
					} catch (cleanup) {
						throw new AggregateError([error, cleanup], "OWNER_JOURNAL_QUARANTINE_FAILED");
					}
					throw error;
				}
			},
			quarantine: () => {
				closed = true;
				this.quarantine();
			},
			close: () => {
				closed = true;
			},
		});
	}

	quarantine(): void {
		this.#phase = "quarantined";
		const errors: unknown[] = [];
		try {
			this.#journal.quarantine();
		} catch (error) {
			errors.push(error);
		}
		for (const effect of this.#pending) {
			try {
				effect.control.close(new Error("STALE_OWNER"));
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length) throw new AggregateError(errors, "OWNER_QUARANTINE_FAILED");
	}

	/** Bootstrap-only receiving, not a public credential setter or resolver. */
	receiveCredential(): Buffer {
		this.assertActive();
		return this.#journal.receiveCredential();
	}

	checkCredential(): void {
		this.assertActive();
		this.#journal.checkCredential();
	}

	/** Borrow the original host aggregate; this never extends or transfers release. */
	inspectResources() {
		this.assertActive();
		return Object.freeze({
			...inspectOriginalJournalResources.call(this.#journal),
			sessionId: this.#journal.sessionId,
		});
	}

	/** Native lease read only; never spend a turn to test permission. */
	inspectPermission() {
		this.assertActive();
		return Object.freeze({
			...inspectOriginalJournalPermission.call(this.#journal),
			ownerEpoch: this.#journal.grant,
			sessionId: this.#journal.sessionId,
		});
	}

	spendAutomaticTurn(): void {
		this.assertActive();
		this.#journal.spendAutomaticTurn();
	}

	stopAutomaticTurns(): void {
		this.#journal.stopAutomaticTurns();
	}

	get phase(): Phase {
		return this.#phase;
	}
	get grant(): string {
		return this.#journal.grant;
	}
	get sessionId(): string {
		return this.#journal.sessionId;
	}

	/** Internal host receiving, not an author policy setter. A durable fork gets
	 * no ticket until its host independently issues a fresh explicit plan. */
	admit(policy: OwnerAdmissionPolicy): OwnerAdmission {
		if (this.#phase !== "opening") throw new Error("OWNER_ACTIVATION_STATE");
		return this.host.admit(this.#journal, policy);
	}

	activate(admission: OwnerAdmission): void {
		if (this.#phase !== "opening") throw new Error("OWNER_ACTIVATION_STATE");
		this.#journal.activate(admission);
		this.#phase = "active";
	}

	assertActive(): void {
		if (this.#phase !== "active") throw new Error("STALE_OWNER");
		this.#journal.assertActive();
	}

	/** Bind factory and callback preparation to this incarnation. Retained
	 * callbacks keep A, including after B becomes the visible session. */
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
			await operation?.complete(errors.length > 0, options.completed && !errors.length
				? (complete) => {
					// Persistence has settled, but this original receipt is not yet
					// accepted. Capture its one-use completion, not worker readiness.
					const original = captureOrdinaryClockObservation("native-operation-completion", complete);
					observerResult = options.completed!(original.observation);
					if (observerResult !== undefined) throw new Error("OWNER_COMPLETION_OBSERVER_SYNC");
				}
				: undefined);
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

	readFile(root: number, relativePath: string, signal?: AbortSignal): Promise<Buffer> {
		return this.effect({ kind: "read", root }, (effect) => effect.readFile(relativePath), { signal });
	}

	writeFile(
		root: number,
		relativePath: string,
		bytes: Uint8Array,
		previous?: Uint8Array,
		signal?: AbortSignal,
	): Promise<void> {
		return this.effect({ kind: "write", root }, (effect) => effect.writeFile(relativePath, bytes, previous), {
			signal,
		});
	}

	/** Native clone, real pipes, subtree drain and explicit retirement. No fake
	 * ChildProcess and no success inferred from leader exit or an abort race. */
	runProcess(request: OwnedProcessRequest, options: OwnedProcessOptions = {}): Promise<OwnedProcessResult> {
		const limit = this.host.profile.limits;
		const timeoutMs = options.timeoutMs;
		if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
			return Promise.reject(new Error("OWNER_PROCESS_TIMEOUT_LIMIT"));
		const timeout = Math.min(timeoutMs ?? limit.processTimeoutMs, limit.processTimeoutMs);
		const deadline = performance.now() + timeout;
		return this.effect(
			{ kind: "process", timeoutMs: timeout },
			async (effect) => {
				const { stdin, capture, onData } = options;
				const inputSize = typeof stdin === "string" ? Buffer.byteLength(stdin) : (stdin?.byteLength ?? 0);
				if (inputSize > limit.outputBytes) throw new Error("OWNER_STDIN_LIMIT");
				let pid = -1;
				let code = -1;
				let signal = 0;
				let stdout = "",
					stderr = "";
				const outDecoder = new StringDecoder("utf8"),
					errDecoder = new StringDecoder("utf8");
				let errorBytes = Buffer.alloc(0);
				let input = Buffer.from(stdin ?? "");
				let inputClosed = false;
				let callbackFailed = false;
				let captured = 0;
				let retired = false;
				const errors: unknown[] = [];
				const process = effect.dispatch(() => this.#journal.prepareProcess(request, timeout));
				effectOperations.get(effect)!.bindProcess(process);
				let stopDeadline = Infinity;
				let stopping = false;
				const stopFailed = (error: unknown) => {
					errors.push(error);
					this.#phase = "quarantined";
					try {
						this.#journal.quarantine();
					} catch (cleanup) {
						errors.push(cleanup);
					}
				};
				const stop = () => {
					if (stopping) return;
					stopping = true;
					stopDeadline = Math.min(
						Math.min(performance.now(), deadline) + limit.closeTimeoutMs,
						this.#closesAt ?? Infinity,
					);
					try {
						void process.stop().catch(stopFailed);
					} catch (error) {
						stopFailed(error);
					}
				};
				const abort = () => {
					errors.push(effect.signal.reason);
					stop();
				};
				effect.signal.addEventListener("abort", abort, { once: true });
				// ponytail: an awaited output callback cannot suppress the stop request.
				// Its actual settlement still owns the effect; this timer cannot release JA.
				const timer = setTimeout(
					() => {
						if (!stopping) {
							errors.push(new Error("OWNER_PROCESS_TIMEOUT"));
							stop();
						}
					},
					Math.max(0, deadline - performance.now()),
				);
				try {
					try {
						pid = effect.dispatch(() => process.dispatch());
					} catch (error) {
						errors.push(error);
						stop();
					}
					for (;;) {
						if (!stopping && (effect.signal.aborted || performance.now() >= deadline || errors.length)) {
							if (effect.signal.aborted) errors.push(effect.signal.reason);
							else if (performance.now() >= deadline) errors.push(new Error("OWNER_PROCESS_TIMEOUT"));
							stop();
						}
						if (performance.now() >= stopDeadline) throw new Error("OWNER_PROCESS_NOT_DRAINED");
						const status = await process.poll();
						code = status.code;
						signal = status.signal;
						if (status.error && !errors.length)
							errors.push(new Error(`OWNER_PROCESS_ERROR: errno=${status.error}`));
						if (errorBytes.length + status.execError.length > 8) throw new Error("OWNER_EXEC_ERROR_RECORD");
						errorBytes = Buffer.concat([errorBytes, status.execError]);
						for (const [stream, bytes] of [
							["stdout", status.stdout],
							["stderr", status.stderr],
						] as const) {
							const chunk = bytes.subarray(0, Math.max(0, limit.outputBytes - captured));
							captured += chunk.length;
							if (capture !== false) {
								if (stream === "stdout") stdout += outDecoder.write(chunk);
								else stderr += errDecoder.write(chunk);
							}
							if (!callbackFailed && chunk.length && onData) {
								try {
									await onData(stream, Buffer.from(chunk));
								} catch (error) {
									errors.push(error);
									callbackFailed = true;
								}
							}
						}
						// Accept neither a late sample nor a late retirement merely because
						// the timer callback has not run yet.
						if (!stopping && (status.sampleExpired || performance.now() >= deadline)) {
							errors.push(new Error("OWNER_PROCESS_TIMEOUT"));
							stop();
						}
						if (performance.now() >= stopDeadline) throw new Error("OWNER_PROCESS_NOT_DRAINED");
						if (status.drained) {
							await process.retire();
							retired = true; // Never replay an acknowledged retirement.
							if (!stopping && performance.now() >= deadline) {
								errors.push(new Error("OWNER_PROCESS_TIMEOUT"));
							}
							if (performance.now() >= stopDeadline) throw new Error("OWNER_PROCESS_NOT_DRAINED");
							break;
						}
						if (status.dispatched && !stopping && !inputClosed) {
							try {
								const written = effect.dispatch(() => process.write(input.subarray(0, 131_072)));
								input = input.subarray(written);
								if (!input.length) {
									effect.dispatch(() => process.write(Buffer.alloc(0)));
									inputClosed = true;
								}
							} catch (error) {
								errors.push(error);
							}
						}
						await delay(status.stdout.length || status.stderr.length ? 0 : 5);
					}
				} catch (error) {
					errors.push(error);
				} finally {
					clearTimeout(timer);
					effect.signal.removeEventListener("abort", abort);
					if (!retired || performance.now() >= stopDeadline) {
						stop();
						this.#phase = "quarantined";
						try {
							this.#journal.quarantine();
						} catch (error) {
							errors.push(error);
						}
					}
				}
				stdout += outDecoder.end();
				stderr += errDecoder.end();
				if (errorBytes.length && errorBytes.length !== 8) errors.push(new Error("OWNER_EXEC_ERROR_RECORD"));
				const setupError =
					errorBytes.length === 8
						? { stage: errorBytes.readInt32LE(0), errno: errorBytes.readInt32LE(4) }
						: undefined;
				if (setupError)
					errors.push(new Error(`OWNER_PROCESS_SETUP: stage=${setupError.stage} errno=${setupError.errno}`));
				if (errors.length) throw new AggregateError(errors, "OWNER_PROCESS_FAILED");
				return { pid, stdout, stderr, code, signal, setupError };
			},
			{ signal: options.signal },
		);
	}

	/** Called only by narrow native message/control persistence sites. The close
	 * owner opens this phase after all physical effects have actually settled. */
	async terminal<T>(write: () => T): Promise<T> {
		if (this.#phase === "active") return this.within(write);
		if (this.#phase !== "draining" && this.#phase !== "terminal") throw new Error("STALE_OWNER");
		await this.#terminalReady;
		if (this.#phase !== "terminal") throw new Error("STALE_OWNER");
		return this.#journal.terminal(write);
	}

	close(
		hooks: {
			stop?: () => Promise<void> | void;
			settle?: () => Promise<void> | void;
			persist?: () => Promise<void> | void;
		} = {},
	): Promise<void> {
		if (!this.#closeTask) {
			let resolve!: () => void;
			let reject!: (error: unknown) => void;
			this.#closeTask = new Promise<void>((done, failed) => {
				resolve = done;
				reject = failed;
			});
			// Publish the shared promise before synchronous abort listeners can
			// re-enter close. The native seal still runs before close returns.
			void this.#close(hooks).then(resolve, reject);
		}
		return this.#closeTask;
	}

	async #close(hooks: {
		stop?: () => Promise<void> | void;
		settle?: () => Promise<void> | void;
		persist?: () => Promise<void> | void;
	}): Promise<void> {
		if (this.#phase === "closed") return;
		const errors: unknown[] = [];
		// The received budget starts before seal and includes synchronous work.
		// This rejects late success; it cannot preempt a blocking native syscall.
		const closesAt = performance.now() + this.host.profile.limits.closeTimeoutMs;
		this.#closesAt = closesAt;
		const checkDeadline = () => {
			if (performance.now() >= closesAt) throw new Error("OWNER_CLOSE_NOT_SETTLED");
		};
		if (this.#phase === "quarantined") errors.push(new Error("OWNER_CLOSE_QUARANTINED"));
		let releaseAttempted = false;
		let closeFailure: AggregateError | undefined;
		this.#phase = "draining";
		let sealing: Promise<void>;
		try {
			sealing = this.#journal.seal().catch((error: unknown) => {
				errors.push(error);
			});
			checkDeadline();
		} catch (error) {
			errors.push(error);
			sealing = Promise.resolve();
		}
		for (const effect of this.#pending) effect.control.close(new Error("STALE_OWNER"));
		// Start cancellation before waiting. Do not await a callback that itself
		// needs terminal persistence until the physical drain has opened that phase.
		let stopped: Promise<void>;
		try {
			stopped = Promise.resolve(hooks.stop?.());
		} catch (error) {
			stopped = Promise.reject(error);
		}
		const observedStop = stopped.catch((error: unknown) => {
			errors.push(error);
		});
		const timeout = new AbortController();
		const deadline = delay(Math.max(0, closesAt - performance.now()), undefined, { signal: timeout.signal }).then(
			() => {
				throw new Error("OWNER_CLOSE_NOT_SETTLED");
			},
		);
		try {
			await Promise.race([sealing, deadline]);
			checkDeadline();
			const drain = Promise.all([...this.#pending].map((effect) => effect.settled));
			await Promise.race([drain, deadline]);
			checkDeadline();
			if (this.#pending.size) throw new Error("OWNER_CLOSE_NOT_SETTLED");
			if (this.phase === "quarantined") errors.push(new Error("OWNER_CLOSE_QUARANTINED"));
			this.#phase = errors.length ? "quarantined" : "terminal";
			this.#allowTerminal();
			await Promise.race([observedStop, deadline]);
			checkDeadline();
			try {
				await Promise.race([Promise.resolve(hooks.settle?.()), deadline]);
				checkDeadline();
			} catch (error) {
				errors.push(error);
			}
			if (!errors.length) {
				try {
					await Promise.race([this.#journal.terminal(async () => {
						await hooks.persist?.();
						checkDeadline();
						await persistOwnedTerminalSession(this.manager);
					}), deadline]);
					checkDeadline();
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length) {
				closeFailure = new AggregateError(errors, "OWNER_CLOSE_FAILED", { cause: errors[0] });
				throw closeFailure;
			}
			releaseAttempted = true;
			await Promise.race([this.#journal.release(), deadline]);
			checkDeadline();
			this.#phase = "closed";
		} catch (error) {
			// Preserve earlier seal/stop failures if a deadline becomes the final error.
			const failure = errors.length && !errors.includes(error) && error !== closeFailure
				? new AggregateError([...errors, error], "OWNER_CLOSE_FAILED", { cause: errors[0] }) : error;
			this.#phase = "quarantined";
			this.#allowTerminal();
			// Release can consume JA before its reply is lost. Do not follow an
			// attempted release with another control-record write.
			if (releaseAttempted) {
				// Cancellation only: never another control-record write or release.
				try {
					this.#journal.cancelLifecycle();
				} catch (cleanup) {
					throw new AggregateError([failure, cleanup], "OWNER_CLOSE_QUARANTINED", { cause: failure });
				}
			} else {
				try {
					this.#journal.quarantine();
				} catch (cleanup) {
					throw new AggregateError([failure, cleanup], "OWNER_CLOSE_QUARANTINED", { cause: failure });
				}
			}
			throw failure;
		} finally {
			timeout.abort();
		}
	}
}
