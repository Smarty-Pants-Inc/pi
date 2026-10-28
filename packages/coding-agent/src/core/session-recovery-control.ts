import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { CompactionPreparation } from "./compaction/compaction.ts";
import type { NativeRecoveryAppend } from "./session-recovery-persistence.ts";

/** Pi incarnation, not the kernel boot or owner lease identity. Stable across reload. */
export const PI_PROCESS_INCARNATION_ID = randomUUID();
export type SessionRecoveryPhase = "HELD" | "DELIVERING" | "RUNNING" | "READY" | "CANCELLING" | "BLOCKED" | "RETIRED";
export interface RecoveryPreOpenBinding {
	/** B2 validates actual custody/exclusion before native reads a retained header or history. */
	excludeWriter(request: { sessionFile: string }): Promise<{ assertCurrent(): void }>;
}
export interface SessionRecoveryOptions {
	required: boolean;
	/** Native opens this retained file only after preOpen has validated exclusion. */
	sessionFile?: string;
	preOpen?: RecoveryPreOpenBinding;
	/** Runtime replacement completes startup after rebind. */
	deferStartup?: boolean;
}

export interface AcceptedRecoveryInput {
	sessionId: string;
	originalInputId: string;
	admissionId: string;
	deliveryId: string;
	kind: "initial" | "recovery";
	text: string;
	payloadSha256: string;
	deadlineMs: number;
	/** Explicit receiver classification. Effect reads never acquire a native round. */
	consumption: { kind: "round" } | { kind: "effect-read"; effectKey: string };
}
export interface InputOutcomeRequest {
	sessionId: string;
	requestId: string;
	originalInputId: string;
	kind: "user-cancel" | "lifecycle-interrupt" | "settled";
	at: number;
	bootId: string;
	terminalEvidence?: NativeTerminalWitness;
	deadlineMs: number;
	signal?: AbortSignal;
}
export type InputOutcomeResult =
	| { durable: true; status: "recorded" | "existing"; revision: number }
	| { durable: true; status: "already-terminal"; revision: number; kind: "user-cancel" | "settled" }
	| {
			durable: false;
			reason: "conflict" | "deadline" | "aborted" | "store-unavailable" | "incomplete-history" | "superseded";
	  };
export interface NativeTerminalWitness {
	version: 1;
	sessionId: string;
	originalInputId: string;
	inputEntryId: string;
	runId: string;
	bootId: string;
	decision: "settled";
	finalEntries: Array<{ entryId: string; bytesSha256: string }>;
}
export interface RecoveryCarrier {
	entry: NativeRecoveryAppend;
	input: Readonly<AcceptedRecoveryInput>;
	/** Resolves only after the enclosing native persistence/owner terminal scope returned. */
	persistenceReleased: Promise<void>;
}
export interface RecoveryOccurrence {
	carrier: Promise<RecoveryCarrier>;
	completion: Promise<void>;
	/** B5's serialized final permission is checked here, not by a generic fence release. */
	permit(): Promise<void>;
}
export interface SessionRecoveryContext {
	readonly required: boolean;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly processIncarnationId: string;
	readonly epoch: number;
	deliverAccepted(input: AcceptedRecoveryInput): Promise<RecoveryOccurrence>;
	resumeAccepted(input: AcceptedRecoveryInput, entryId: string): Promise<RecoveryOccurrence>;
	finalizeAccepted(input: AcceptedRecoveryInput, entryId: string): Promise<void>;
	settleFromWitness(input: AcceptedRecoveryInput, witnessEntryId: string): Promise<void>;
}
/** Native consumes these ports; it does not implement B5, B6, or Fabric's repair algorithm. */
export interface SessionRecoveryBinding {
	deliver(context: SessionRecoveryContext): Promise<void>;
	beforeProvider(request: {
		input: Readonly<AcceptedRecoveryInput>;
		epoch: number;
		signal?: AbortSignal;
	}): Promise<{ permitted: boolean }>;
	projectContext(messages: AgentMessage[], input: Readonly<AcceptedRecoveryInput>): Promise<AgentMessage[]>;
	/** Must register/barrier every descriptor; registration alone is not durability. */
	commitNativeEntries(entries: readonly NativeRecoveryAppend[], input: Readonly<AcceptedRecoveryInput>): Promise<void>;
	recordInputOutcome(request: InputOutcomeRequest): Promise<InputOutcomeResult>;
	/** Captured synchronously before the first cancel await, including accepted queued originals. */
	getCancelTargets(): readonly AcceptedRecoveryInput[];
	/** B4/native boundary inventory, not an assistant-last heuristic. */
	validateTerminal(
		input: Readonly<AcceptedRecoveryInput>,
		finalEntries: readonly NativeRecoveryAppend[],
	): Promise<{ complete: boolean }>;
	/** Verify repaired compaction input/cut; absence is uncertainty, not permission to drop pairs. */
	validateCompaction?(
		input: Readonly<AcceptedRecoveryInput>,
		preparation: CompactionPreparation,
		firstKeptEntryId?: string,
	): Promise<void>;
}
export interface RecoveryControlHost {
	sessionId: string;
	sessionFile: string;
	stop(): void;
	join(): Promise<void>;
}

export class SessionRecoveryError extends Error {
	readonly code: string;
	constructor(code: string, message = code, options?: ErrorOptions) {
		super(message === code ? code : `${code}: ${message}`, options);
		this.name = "SessionRecoveryError";
		this.code = code;
	}
}

/** One bounded attempt; observes a non-cooperative adapter's late result without opening a gate. */
async function bounded<T>(deadlineMs: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const remaining = deadlineMs - Date.now();
	if (remaining <= 0) throw new SessionRecoveryError("RECOVERY_DEADLINE");
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(() => action(controller.signal)),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					const error = new SessionRecoveryError("RECOVERY_DEADLINE");
					controller.abort(error);
					reject(error);
				}, remaining);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export class SessionRecoveryControl {
	readonly required: boolean;
	readonly host: RecoveryControlHost;
	readonly preOpen?: RecoveryPreOpenBinding;
	phase: SessionRecoveryPhase = "HELD";
	epoch = 0;
	binding?: SessionRecoveryBinding;
	source?: string;
	input?: Readonly<AcceptedRecoveryInput>;
	inputEntryId?: string;
	runId?: string;
	private permitted = false;
	private cancelAttempt?: {
		payloads: InputOutcomeRequest[];
		targets: readonly AcceptedRecoveryInput[];
		captureFailure?: unknown;
		promise?: Promise<void>;
	};
	private permission?: { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
	constructor(options: SessionRecoveryOptions | undefined, host: RecoveryControlHost) {
		this.required = options?.required === true;
		this.host = host;
		this.preOpen = options?.preOpen;
		if (!this.required) this.phase = "READY";
	}
	get held(): boolean {
		return this.required && this.phase !== "READY" && this.phase !== "RUNNING";
	}
	close(advanceEpoch = true): number {
		if (!this.required) return this.epoch;
		this.permission?.reject(new SessionRecoveryError("RECOVERY_EPOCH_REVOKED"));
		this.permission = undefined;
		this.permitted = false;
		this.phase = "HELD";
		this.binding = undefined;
		this.source = undefined;
		this.cancelAttempt = undefined;
		if (advanceEpoch) this.epoch++;
		return this.epoch;
	}
	bind(bindings: readonly { source: string; binding: SessionRecoveryBinding }[]): void {
		if (!this.required) return;
		if (bindings.length !== 1) throw this.block("RECOVERY_BINDING_REQUIRED");
		this.source = bindings[0].source;
		this.binding = bindings[0].binding;
		for (const name of [
			"deliver",
			"beforeProvider",
			"projectContext",
			"commitNativeEntries",
			"recordInputOutcome",
			"getCancelTargets",
			"validateTerminal",
		] as const)
			if (typeof this.binding[name] !== "function") throw this.block("RECOVERY_BINDING_INCOMPLETE");
	}
	block(code: string, cause?: unknown): SessionRecoveryError {
		if (this.phase !== "RETIRED") this.phase = "BLOCKED";
		this.permitted = false;
		const error = new SessionRecoveryError(code, code, { cause });
		this.permission?.reject(error);
		return error;
	}
	assertEpoch(epoch: number): void {
		if (epoch !== this.epoch || this.phase === "RETIRED") throw new SessionRecoveryError("RECOVERY_EPOCH_REVOKED");
	}
	select(value: AcceptedRecoveryInput, entryId?: string): Readonly<AcceptedRecoveryInput> {
		if (!this.required || !this.binding || this.phase !== "HELD") throw this.block("RECOVERY_OCCURRENCE_NOT_HELD");
		const input: AcceptedRecoveryInput = structuredClone(value);
		if (
			input.sessionId !== this.host.sessionId ||
			input.consumption.kind !== "round" ||
			!input.originalInputId ||
			!input.admissionId ||
			!input.deliveryId ||
			input.deliveryId.startsWith("pi-native-entry:v1:") ||
			!Number.isFinite(input.deadlineMs) ||
			input.deadlineMs <= Date.now() ||
			createHash("sha256").update(input.text).digest("hex") !== input.payloadSha256
		)
			throw this.block("RECOVERY_INPUT_BINDING_INVALID");
		Object.freeze(input.consumption);
		this.input = Object.freeze(input);
		this.inputEntryId = entryId;
		this.runId = randomUUID();
		this.phase = "DELIVERING";
		let resolve!: () => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<void>((done, failed) => {
			resolve = done;
			reject = failed;
		});
		void promise.catch(() => {});
		this.permission = { promise, resolve, reject };
		return this.input;
	}
	async permit(epoch: number): Promise<void> {
		this.assertEpoch(epoch);
		if (!this.input || !this.binding || this.phase !== "DELIVERING" || !this.inputEntryId)
			throw this.block("RECOVERY_CARRIER_NOT_COMMITTED");
		const result = await bounded(this.input.deadlineMs, (signal) =>
			this.binding!.beforeProvider({ input: this.input!, epoch, signal }),
		);
		this.assertEpoch(epoch);
		if (!result?.permitted || this.phase !== "DELIVERING") throw this.block("RECOVERY_PROVIDER_NOT_PERMITTED");
		this.permitted = true;
		this.phase = "RUNNING";
		this.permission?.resolve();
	}
	async beforeProvider(signal?: AbortSignal): Promise<void> {
		if (!this.required) return;
		const epoch = this.epoch;
		if (this.phase === "DELIVERING" && this.permission) {
			const pending = this.permission.promise;
			if (signal) {
				await new Promise<void>((resolve, reject) => {
					const abort = () => reject(signal.reason ?? new SessionRecoveryError("RECOVERY_ABORTED"));
					if (signal.aborted) return abort();
					signal.addEventListener("abort", abort, { once: true });
					void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
				});
			} else await pending;
		}
		this.assertEpoch(epoch);
		if (signal?.aborted || !this.permitted || !this.input || this.phase !== "RUNNING")
			throw new SessionRecoveryError("RECOVERY_PROVIDER_HELD");
		const result = await bounded(this.input.deadlineMs, (attemptSignal) =>
			this.binding!.beforeProvider({
				input: this.input!,
				epoch,
				signal: signal ? AbortSignal.any([signal, attemptSignal]) : attemptSignal,
			}),
		);
		this.assertEpoch(epoch);
		if (signal?.aborted || !result?.permitted || this.phase !== "RUNNING")
			throw this.block("RECOVERY_PROVIDER_NOT_PERMITTED");
	}
	async project(messages: AgentMessage[]): Promise<AgentMessage[]> {
		if (!this.required) return messages;
		if (!this.input || !this.binding) throw this.block("RECOVERY_CONTEXT_UNBOUND");
		const epoch = this.epoch;
		const projected = await this.binding.projectContext(structuredClone(messages), this.input);
		this.assertEpoch(epoch);
		if (this.phase !== "RUNNING" || !this.permitted) throw new SessionRecoveryError("RECOVERY_PROVIDER_HELD");
		if (!Array.isArray(projected)) throw this.block("RECOVERY_CONTEXT_MALFORMED");
		return projected;
	}
	async cancel(selfCall = false): Promise<void> {
		if (!this.required) throw new SessionRecoveryError("RECOVERY_NOT_REQUIRED");
		if (this.phase === "RETIRED") throw new SessionRecoveryError("RECOVERY_RETIRED");
		if (this.cancelAttempt?.promise) return this.cancelAttempt.promise;
		this.phase = "CANCELLING";
		this.permitted = false;
		this.permission?.reject(new SessionRecoveryError("RECOVERY_CANCELLING"));
		const binding = this.binding;
		if (!this.cancelAttempt) {
			let captureFailure: unknown;
			let targets: readonly AcceptedRecoveryInput[];
			try {
				targets = [
					...(binding?.getCancelTargets().map((target) => structuredClone(target)) ?? []),
					...(this.input ? [this.input] : []),
				];
				if (
					targets.some(
						(target) =>
							target.sessionId !== this.host.sessionId ||
							!target.originalInputId ||
							target.consumption.kind !== "round" ||
							!Number.isFinite(target.deadlineMs),
					)
				)
					throw new SessionRecoveryError("RECOVERY_CANCEL_INCOMPLETE_HISTORY");
			} catch (error) {
				captureFailure = error;
				targets = this.input ? [this.input] : [];
			}
			const unique = [...new Map(targets.map((target) => [target.originalInputId, target])).values()];
			this.cancelAttempt = {
				targets: unique,
				captureFailure,
				payloads: unique.map((target) => ({
					sessionId: this.host.sessionId,
					requestId: randomUUID(),
					originalInputId: target.originalInputId,
					kind: "user-cancel",
					at: Date.now(),
					bootId: PI_PROCESS_INCARNATION_ID,
					deadlineMs: target.deadlineMs,
				})),
			};
		}
		const attempt = this.cancelAttempt;
		const epoch = this.epoch;
		const perform = async () => {
			let failure: unknown;
			try {
				if (attempt.captureFailure || !binding || !attempt.payloads.length)
					throw new SessionRecoveryError("RECOVERY_CANCEL_INCOMPLETE_HISTORY", undefined, {
						cause: attempt.captureFailure,
					});
				const deadline = Math.min(Date.now() + 1000, ...attempt.targets.map((target) => target.deadlineMs));
				await bounded(deadline, async (signal) => {
					for (const payload of attempt.payloads) {
						const result = await binding.recordInputOutcome({ ...payload, deadlineMs: deadline, signal });
						if (!result.durable || (result.status === "already-terminal" && result.kind !== "user-cancel"))
							throw new SessionRecoveryError("RECOVERY_CANCEL_NOT_DURABLE");
					}
				});
			} catch (error) {
				failure = error;
			}
			if (failure && binding) {
				// Loss fallback: request L and stop immediately; a late write never reopens dispatch.
				const deadline = Math.min(Date.now() + 1000, ...attempt.targets.map((target) => target.deadlineMs));
				void bounded(deadline, async (signal) => {
					for (const payload of attempt.payloads)
						await binding.recordInputOutcome({
							...payload,
							kind: "lifecycle-interrupt",
							requestId: `${payload.requestId}:lifecycle`,
							deadlineMs: deadline,
							signal,
						});
				}).catch(() => {});
			}
			this.assertEpoch(epoch);
			this.host.stop();
			let joined = false;
			if (!selfCall) {
				try {
					await bounded(Math.min(Date.now() + 1000, ...attempt.targets.map((target) => target.deadlineMs)), () =>
						this.host.join(),
					);
					joined = true;
				} catch {}
			}
			this.assertEpoch(epoch);
			this.phase = "BLOCKED";
			if (failure)
				throw new SessionRecoveryError(
					"RECOVERY_CANCEL_NOT_DURABLE",
					selfCall
						? "Stop requested; cancellation NOT confirmed durable; self-call cannot join its run"
						: joined
							? "Stopped; cancellation NOT confirmed durable; task may resume after restart"
							: "Stop requested; computation has NOT joined; cancellation NOT confirmed durable",
					{ cause: failure },
				);
			if (selfCall)
				throw new SessionRecoveryError(
					"RECOVERY_CANCEL_SELF_JOIN_PENDING",
					"Cancellation durable; stop requested; self-call cannot join its run",
				);
			if (!joined)
				throw new SessionRecoveryError(
					"RECOVERY_CANCEL_STOP_INCOMPLETE",
					"Cancellation durable; computation has NOT joined",
				);
		};
		const pending = perform();
		attempt.promise = pending;
		try {
			await pending;
		} finally {
			attempt.promise = undefined;
		}
	}
	async interrupt(reason: string, selfCall = false): Promise<void> {
		if (!this.required) return;
		const binding = this.binding;
		const input = this.input;
		const epoch = ++this.epoch;
		this.phase = "HELD";
		this.permitted = false;
		this.permission?.reject(new SessionRecoveryError("RECOVERY_LIFECYCLE_INTERRUPTED"));
		this.permission = undefined;
		let failure: unknown;
		if (input && binding) {
			const deadlineMs = Math.min(Date.now() + 1000, input.deadlineMs);
			try {
				const result = await bounded(deadlineMs, (signal) =>
					binding.recordInputOutcome({
						sessionId: input.sessionId,
						originalInputId: input.originalInputId,
						requestId: `${this.runId}:lifecycle:${reason}`,
						kind: "lifecycle-interrupt",
						at: Date.now(),
						bootId: PI_PROCESS_INCARNATION_ID,
						deadlineMs,
						signal,
					}),
				);
				if (!result.durable) failure = result;
			} catch (error) {
				failure = error;
			}
		}
		this.assertEpoch(epoch);
		this.host.stop();
		if (!selfCall) {
			try {
				await bounded(Math.min(Date.now() + 1000, input?.deadlineMs ?? Infinity), () => this.host.join());
			} catch (error) {
				throw this.block("RECOVERY_LIFECYCLE_JOIN_INCOMPLETE", error);
			}
		}
		if (failure) throw this.block("RECOVERY_LIFECYCLE_OUTCOME_UNCONFIRMED", failure);
	}
	retire(): void {
		this.permission?.reject(new SessionRecoveryError("RECOVERY_RETIRED"));
		this.permitted = false;
		this.phase = "RETIRED";
		this.epoch++;
	}
}

/** Exact disjoint B6 carrier reference for a non-user native entry. */
export function nativeEntryDeliveryId(sessionId: string, entryId: string): string {
	return `pi-native-entry:v1:${createHash("sha256")
		.update(JSON.stringify([sessionId, entryId]))
		.digest("hex")}`;
}
export type RecoveryToolResult = ToolResultMessage;
