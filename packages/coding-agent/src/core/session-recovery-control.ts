import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { CompactionPreparation } from "./compaction/compaction.ts";
import { NativeOperationScope } from "./ordinary-compaction.ts";
import type { NativeRecoveryAppend } from "./session-recovery-persistence.ts";

/** Pi incarnation, not the kernel boot or owner lease identity. Stable across reload. */
export const PI_PROCESS_INCARNATION_ID = randomUUID();
/** Bounded settlement I/O, not a renewed inference or whole-cohort recovery deadline. */
export const MAINTENANCE_RECOVERY_IO_TIMEOUT_MS = 10_000;
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
	readonly epoch: RecoveryEpoch;
	/** Current native READY, not a fence-release or observer signal. */
	isReady(): boolean;
	/** Read-only assertion of the private native WAL/commit attempt; cannot enter it. */
	assertMaintenanceScope(subject: Readonly<AcceptedRecoveryMaintenance>): void;
	deliverAccepted(input: AcceptedRecoveryInput): Promise<RecoveryOccurrence>;
	resumeAccepted(input: AcceptedRecoveryInput, entryId: string): Promise<RecoveryOccurrence>;
	finalizeAccepted(input: AcceptedRecoveryInput, entryId: string): Promise<void>;
	settleFromWitness(input: AcceptedRecoveryInput, witnessEntryId: string): Promise<void>;
}
export interface RecoveryIo {
	readonly deadlineMs?: number;
	readonly signal?: AbortSignal;
}
export interface RecoveryTaskAbort {
	readonly requestId: string;
	readonly at: number;
	readonly bootId: string;
	readonly originalInputIds: readonly string[];
	readonly maintenanceRequestId: string;
	committed: boolean;
}
export type RecoveryEpoch = Readonly<{ processIncarnationId: string; bindingId: string; epoch: number }>;
export type MaintenanceOperation =
	| { kind: "compact"; reason: "manual"; targetModel?: never }
	| { kind: "compact"; reason: "model-switch"; targetModel: Readonly<{ provider: string; id: string }> }
	| { kind: "tree-nav"; targetEntryId: string | null; summarize: boolean }
	| { kind: "auto-compact-retry"; retryAnchor: string };
export type RepairRef = Readonly<{
	originalInputId: string;
	recoveryGeneration: string;
	executionBranchEntryId: string;
	repairReceiptSha256: string;
}>;
export interface MaintenanceRequest {
	readonly version: 1;
	readonly admissionKind: "maintenance";
	readonly sessionId: string;
	readonly requestId: string;
	readonly epoch: RecoveryEpoch;
	readonly operation: MaintenanceOperation;
	readonly baseLeafId: string | null;
	readonly baseHistorySha256: string;
	readonly viewSha256: string;
	readonly issuedAtMs: number;
	readonly deadlineMs: number;
	readonly repair?: RepairRef;
}
export interface NativePlanRef {
	readonly entryId: string;
	readonly bytesSha256: string;
	readonly planSha256: string;
}
export interface MaintenanceCompletion {
	readonly outcome: "completed" | "noop" | "cancelled" | "failed";
	readonly errorCode?: string;
	readonly checkpointEntryId: string;
	readonly entries: ReadonlyArray<{ readonly entryId: string; readonly bytesSha256: string; readonly seq: number }>;
}
export interface MaintenanceRecord {
	readonly request: Readonly<MaintenanceRequest>;
	readonly operationSha256: string;
	revision: number;
	activeEpoch: RecoveryEpoch;
	permitRevision: number;
	state: "ADMITTED" | "ACTIVE" | "PREPARED" | "CONSUMED";
	plan?: NativePlanRef;
	completion?: MaintenanceCompletion;
}
export interface AcceptedRecoveryMaintenance {
	readonly admissionKind: "maintenance";
	readonly sessionId: string;
	readonly requestId: string;
	readonly epoch: RecoveryEpoch;
	readonly operationSha256: string;
	readonly permitRevision: number;
	readonly deadlineMs: number;
}
export type RecoveryGateSubject = Readonly<AcceptedRecoveryInput | AcceptedRecoveryMaintenance>;
export type ProviderPurpose = "turn" | "compact-summary" | "tree-summary" | "bug-report";
export interface MaintenanceKey {
	readonly sessionId: string;
	readonly requestId: string;
}
export const RECOVERY_MAINTENANCE_CODES = [
	"RECOVERY_MAINTENANCE_UNBOUND",
	"RECOVERY_MAINTENANCE_TOKEN_REUSED",
	"RECOVERY_MAINTENANCE_CONFLICT",
	"RECOVERY_MAINTENANCE_INVALID",
	"RECOVERY_MAINTENANCE_USER_TEXT",
	"RECOVERY_MAINTENANCE_HOOK_CONTENT",
	"RECOVERY_MAINTENANCE_KIND_MISMATCH",
	"RECOVERY_MAINTENANCE_PURPOSE_UNSUPPORTED",
	"RECOVERY_MAINTENANCE_INPUT_SELECTED",
	"RECOVERY_MAINTENANCE_BUSY",
	"RECOVERY_MAINTENANCE_SELF_CALL",
	"RECOVERY_MAINTENANCE_DEADLINE",
	"RECOVERY_MAINTENANCE_CANCELLED",
	"RECOVERY_MAINTENANCE_INTERRUPTED",
	"RECOVERY_MAINTENANCE_RETRY_EXHAUSTED",
	"RECOVERY_MAINTENANCE_REPAIR_REQUIRED",
	"RECOVERY_MAINTENANCE_UNCERTAIN",
] as const;
export type MaintenanceFailureCode =
	| (typeof RECOVERY_MAINTENANCE_CODES)[number]
	| "RECOVERY_EPOCH_REVOKED"
	| "RECOVERY_EXECUTION_BRANCH_REQUIRED";
export type MaintenanceRefusal = Readonly<{ ok: false; code: MaintenanceFailureCode; message: string }>;
export type MaintenanceResult<T = MaintenanceRecord> = Readonly<{ ok: true; value: T }> | MaintenanceRefusal;
export interface BegunMaintenance {
	readonly record: MaintenanceRecord;
	readonly token: AcceptedRecoveryMaintenance;
}
export interface MaintenanceSnapshot {
	readonly revision: number;
	readonly record?: MaintenanceRecord;
}
export interface PendingMaintenance {
	readonly revision: number;
	readonly records: readonly MaintenanceRecord[];
}
export interface MaintenanceLedgerEntry {
	record: MaintenanceRecord;
	/** Internal durable disposition, NOT permission carried by public JSON or a token. */
	settlementOnly: boolean;
	cancelRequested: boolean;
}
export interface MaintenanceJoinReconciliation extends RecoveryIo {
	/** The ACTUAL native operation/run + summary requests + persistence release, not isIdle,
	 * abort notification, observer completion, or a timeout surrogate. B3 owns this promise. */
	readonly joined: Promise<void>;
	/** Native scans its own WAL, validates the exact plan/entries and completes B6 barriers.
	 * It returns a control-only plan for unprepared failure/cancel/interruption; never inference.
	 * A durable prepare found after an unknown ACK wins over late cancel/expiry. */
	settle(
		record: Readonly<MaintenanceRecord>,
		prepare: (plan: NativePlanRef) => Promise<MaintenanceResult>,
	): Promise<MaintenanceCompletion>;
	/** Current-binding recovery pass, including issued intents/repair/branch restoration.
	 * Consumption precedes this callback; HELD release/reconsideration follows it. */
	reconcile(record: Readonly<MaintenanceRecord>): Promise<void>;
	readonly taskAbortRequestId?: string;
}

/** Exact B5 port for B3's composition. All mutations share input-admission's synchronous
 * revision owner. No provider, hook, join, callback or B6 wait runs inside a transaction.
 * B3 keeps native HELD and its private shared attempt; a copied accepted token is not one.
 * read/list are bounded snapshots, never a second scheduler or a poller. */
export interface RecoveryMaintenanceAdapter {
	admitMaintenance(request: MaintenanceRequest, io?: RecoveryIo): Promise<MaintenanceResult>;
	beginMaintenance(
		key: MaintenanceKey,
		epoch: RecoveryEpoch,
		expectedRevision: number,
		io?: RecoveryIo,
	): Promise<MaintenanceResult<BegunMaintenance>>;
	prepareMaintenance(
		token: AcceptedRecoveryMaintenance,
		plan: NativePlanRef,
		io?: RecoveryIo,
	): Promise<MaintenanceResult>;
	consumeMaintenance(
		token: AcceptedRecoveryMaintenance,
		completion: MaintenanceCompletion,
		io?: RecoveryIo,
	): Promise<MaintenanceResult>;
	adoptMaintenance(
		key: MaintenanceKey,
		epoch: RecoveryEpoch,
		expectedRevision: number,
		io?: RecoveryIo,
	): Promise<MaintenanceResult<BegunMaintenance>>;
	read(key: MaintenanceKey, io?: RecoveryIo): Promise<MaintenanceResult<MaintenanceSnapshot>>;
	listPending(sessionId: string, limit: number, io?: RecoveryIo): Promise<MaintenanceResult<PendingMaintenance>>;
	withMaintenanceAttempt<T>(token: AcceptedRecoveryMaintenance, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
	assertMaintenanceGate(token: AcceptedRecoveryMaintenance, purpose: ProviderPurpose, viewSha256: string): void;
	cancelMaintenance(key: MaintenanceKey, epoch: RecoveryEpoch, io?: RecoveryIo): Promise<MaintenanceResult>;
	reconcileAfterJoin(
		key: MaintenanceKey,
		epoch: RecoveryEpoch,
		edge: MaintenanceJoinReconciliation,
	): Promise<MaintenanceResult>;
	captureTaskAbort(
		sessionId: string,
		requestId: string,
		epoch: RecoveryEpoch,
		at: number,
		bootId: string,
		io?: RecoveryIo,
	): Promise<MaintenanceResult<RecoveryTaskAbort>>;
	releaseLostMaintenance(key: MaintenanceKey, epoch: RecoveryEpoch, io?: RecoveryIo): Promise<MaintenanceResult<void>>;
}

export function isMaintenance(subject: RecoveryGateSubject): subject is Readonly<AcceptedRecoveryMaintenance> {
	return "admissionKind" in subject && subject.admissionKind === "maintenance";
}
export function sameRecoveryEpoch(left: RecoveryEpoch, right: RecoveryEpoch): boolean {
	return (
		left.processIncarnationId === right.processIncarnationId &&
		left.bindingId === right.bindingId &&
		left.epoch === right.epoch
	);
}
export interface NativeMaintenanceAttempt {
	readonly requestId: string;
	readonly operation: MaintenanceOperation;
	readonly issuedAtMs: number;
	readonly deadlineMs: number;
	readonly controller: AbortController;
	cancelRequested?: boolean;
	taskAbort?: { requestId: string; at: number; bootId: string };
	record?: MaintenanceRecord;
	token?: AcceptedRecoveryMaintenance;
	prepared: boolean;
	completion?: Promise<void>;
}
/** Native consumes these ports; it does not implement B5, B6, or Fabric's repair algorithm. */
export interface SessionRecoveryBinding {
	deliver(context: SessionRecoveryContext): Promise<void>;
	beforeProvider(request: {
		input: RecoveryGateSubject;
		epoch: RecoveryEpoch;
		purpose: ProviderPurpose;
		signal?: AbortSignal;
	}): Promise<{ permitted: boolean }>;
	projectContext(messages: AgentMessage[], input: RecoveryGateSubject, epoch: RecoveryEpoch): Promise<AgentMessage[]>;
	/** Must register/barrier every descriptor; registration alone is not durability. */
	commitNativeEntries(
		entries: readonly NativeRecoveryAppend[],
		input: RecoveryGateSubject | undefined,
		epoch: RecoveryEpoch,
	): Promise<readonly { entryId: string; bytesSha256: string; seq: number }[]>;
	maintenance: RecoveryMaintenanceAdapter;
	/** Synchronous publication before any current-epoch admission/outcome I/O. */
	advanceEpoch?(epoch: RecoveryEpoch): void;
	/** Existing B6 records only: never manufacture missing CONSUMED evidence. */
	validateMaintenanceReceipts(
		record: MaintenanceRecord,
		entries: readonly NativeRecoveryAppend[],
		epoch: RecoveryEpoch,
	): Promise<void>;
	/** Read-only ledger/B6 proof for retained descriptors without a live original authority. */
	verifyNativeEntries(entries: readonly NativeRecoveryAppend[], epoch: RecoveryEpoch): Promise<void>;
	/** Current-binding post-join pass. Must settle intents, repair, restore execution branch, then deliver. */
	reconcile(context: SessionRecoveryContext, reason: string): Promise<void>;
	/** One native release edge after current-binding reconciliation and B5 release. */
	reconsiderMain?(context: SessionRecoveryContext): void | Promise<void>;
	/** Read-only native/B5 repair resolution; never input execution permission. */
	repairMaintenance?(input: Readonly<AcceptedRecoveryInput>, executionLeafId: string | null): Promise<RepairRef>;
	recordInputOutcome(request: InputOutcomeRequest): Promise<InputOutcomeResult>;
	/** Captured synchronously before the first cancel await, including accepted queued originals. */
	getCancelTargets(): readonly AcceptedRecoveryInput[];
	/** B4/native boundary inventory, not an assistant-last heuristic. */
	validateTerminal(
		input: Readonly<AcceptedRecoveryInput>,
		finalEntries: readonly NativeRecoveryAppend[],
	): Promise<{ complete: boolean }>;
	/** Verify repaired compaction input/cut; absence is uncertainty, not permission to drop pairs. */
	validateCompaction(
		input: RecoveryGateSubject,
		preparation: CompactionPreparation,
		firstKeptEntryId: string | undefined,
		epoch: RecoveryEpoch,
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
	readonly bindingId = randomUUID();
	private readonly maintenanceScope = new NativeOperationScope();
	private maintenanceAttempt?: NativeMaintenanceAttempt;
	taskCancellationPending = false;
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
	get identity(): RecoveryEpoch {
		return Object.freeze({
			processIncarnationId: PI_PROCESS_INCARNATION_ID,
			bindingId: this.bindingId,
			epoch: this.epoch,
		});
	}
	reserveMaintenanceAdoption(record: MaintenanceRecord): NativeMaintenanceAttempt {
		if (!this.required || !this.binding || this.maintenanceAttempt || this.input || this.phase === "RETIRED")
			throw new SessionRecoveryError("RECOVERY_MAINTENANCE_BUSY");
		const attempt: NativeMaintenanceAttempt = {
			requestId: record.request.requestId,
			issuedAtMs: record.request.issuedAtMs,
			deadlineMs: record.request.deadlineMs,
			operation: record.request.operation,
			controller: new AbortController(),
			prepared: record.plan !== undefined,
			record,
		};
		this.maintenanceAttempt = attempt;
		this.phase = "HELD";
		return attempt;
	}
	assertNoMaintenance(): void {
		if (this.required && this.maintenanceAttempt) throw new SessionRecoveryError("RECOVERY_MAINTENANCE_BUSY");
	}
	get maintenanceActive(): boolean {
		return this.maintenanceAttempt !== undefined;
	}
	get currentMaintenance(): NativeMaintenanceAttempt | undefined {
		const attempt = this.maintenanceAttempt;
		return attempt && this.maintenanceScope.current() === attempt ? attempt : undefined;
	}
	get subject(): RecoveryGateSubject {
		const attempt = this.currentMaintenance;
		if (attempt) {
			this.maintenanceScope.assert(attempt);
			if (!attempt.token) throw new SessionRecoveryError("RECOVERY_MAINTENANCE_UNBOUND");
			return attempt.token;
		}
		if (!this.input) throw new SessionRecoveryError("RECOVERY_CONTEXT_UNBOUND");
		return this.input;
	}
	reserveMaintenance(
		operation: MaintenanceOperation,
		issuedAtMs: number,
		deadlineMs: number,
	): NativeMaintenanceAttempt {
		if (!this.required || !this.binding) throw new SessionRecoveryError("RECOVERY_MAINTENANCE_UNBOUND");
		if (this.maintenanceScope.current()) throw new SessionRecoveryError("RECOVERY_MAINTENANCE_SELF_CALL");
		if (this.maintenanceAttempt) throw new SessionRecoveryError("RECOVERY_MAINTENANCE_BUSY");
		if (this.phase === "BLOCKED" || this.phase === "RETIRED")
			throw new SessionRecoveryError("RECOVERY_MAINTENANCE_UNCERTAIN");
		if (operation.kind === "tree-nav" && this.input)
			throw new SessionRecoveryError("RECOVERY_MAINTENANCE_INPUT_SELECTED");
		if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now())
			throw new SessionRecoveryError("RECOVERY_MAINTENANCE_DEADLINE");
		const attempt: NativeMaintenanceAttempt = {
			requestId: randomUUID(),
			operation: Object.freeze(structuredClone(operation)),
			issuedAtMs,
			deadlineMs,
			controller: new AbortController(),
			prepared: false,
		};
		this.maintenanceAttempt = attempt; // Synchronous native reservation BEFORE any await.
		return attempt;
	}
	runMaintenance<T>(attempt: NativeMaintenanceAttempt, action: () => Promise<T>): Promise<T> {
		if (attempt !== this.maintenanceAttempt) throw new SessionRecoveryError("RECOVERY_MAINTENANCE_TOKEN_REUSED");
		return this.maintenanceScope.run(attempt, action);
	}
	observeOutsideMaintenance<T>(invoke: () => T): T {
		return this.maintenanceScope.exit(invoke);
	}
	maintenanceRequest<T>(invoke: () => T): T {
		const attempt = this.currentMaintenance;
		if (!attempt) throw new SessionRecoveryError("RECOVERY_MAINTENANCE_UNBOUND");
		return this.maintenanceScope.request(attempt, invoke);
	}
	assertMaintenance(compute = true): NativeMaintenanceAttempt {
		const attempt = this.currentMaintenance;
		if (!attempt || attempt !== this.maintenanceAttempt || !attempt.token || !attempt.record)
			throw new SessionRecoveryError("RECOVERY_MAINTENANCE_UNBOUND");
		this.maintenanceScope.assert(attempt);
		this.assertEpoch(attempt.token.epoch);
		if (this.phase !== "HELD") throw new SessionRecoveryError("RECOVERY_MAINTENANCE_UNCERTAIN");
		if (compute) {
			attempt.controller.signal.throwIfAborted();
			if (attempt.prepared || attempt.record.state !== "ACTIVE")
				throw new SessionRecoveryError("RECOVERY_MAINTENANCE_TOKEN_REUSED");
			if (Date.now() >= attempt.deadlineMs) throw new SessionRecoveryError("RECOVERY_MAINTENANCE_DEADLINE");
		}
		return attempt;
	}
	/** Commit/WAL settlement has no inference permission. The private native scope and
	 * current B5 reservation bind this descriptor even after B5 revoked computation. */
	assertMaintenanceCommit(subject: Readonly<AcceptedRecoveryMaintenance>): void {
		const attempt = this.currentMaintenance;
		if (!attempt || attempt !== this.maintenanceAttempt || !attempt.record || this.phase !== "HELD")
			throw new SessionRecoveryError("RECOVERY_MAINTENANCE_UNBOUND");
		this.maintenanceScope.assert(attempt);
		this.assertEpoch(subject.epoch);
		const record = attempt.record;
		if (
			subject.requestId !== attempt.requestId ||
			subject.sessionId !== this.host.sessionId ||
			!sameRecoveryEpoch(record.activeEpoch, subject.epoch) ||
			record.operationSha256 !== subject.operationSha256 ||
			record.permitRevision !== subject.permitRevision ||
			!["PREPARED", "CONSUMED"].includes(record.state)
		)
			throw new SessionRecoveryError("RECOVERY_MAINTENANCE_TOKEN_REUSED");
	}
	async checkMaintenance(compute = true): Promise<NativeMaintenanceAttempt> {
		const attempt = this.assertMaintenance(compute);
		const token = attempt.token!;
		const deadlineMs = compute ? attempt.deadlineMs : Date.now() + MAINTENANCE_RECOVERY_IO_TIMEOUT_MS;
		const result = await bounded(deadlineMs, (signal) =>
			this.binding!.maintenance.read(token, { deadlineMs, signal }),
		);
		this.assertMaintenance(compute);
		if (
			!result.ok ||
			!result.value.record ||
			!sameRecoveryEpoch(result.value.record.activeEpoch, token.epoch) ||
			result.value.record.permitRevision !== token.permitRevision ||
			result.value.record.operationSha256 !== token.operationSha256 ||
			result.value.record.state !== attempt.record!.state
		)
			throw new SessionRecoveryError("RECOVERY_MAINTENANCE_TOKEN_REUSED");
		return attempt;
	}
	async beginMaintenance(attempt: NativeMaintenanceAttempt, request: MaintenanceRequest): Promise<void> {
		this.maintenanceScope.assert(attempt);
		if (attempt !== this.maintenanceAttempt || attempt.record)
			throw new SessionRecoveryError("RECOVERY_MAINTENANCE_TOKEN_REUSED");
		this.assertEpoch(request.epoch);
		const io = { deadlineMs: request.deadlineMs, signal: attempt.controller.signal };
		const admitted = await bounded(io.deadlineMs, (signal) =>
			this.binding!.maintenance.admitMaintenance(request, { ...io, signal: AbortSignal.any([signal, io.signal]) }),
		);
		this.assertEpoch(request.epoch);
		if (!admitted.ok) throw new SessionRecoveryError(admitted.code, admitted.message);
		attempt.record = admitted.value;
		const begun = await bounded(io.deadlineMs, (signal) =>
			this.binding!.maintenance.beginMaintenance(request, request.epoch, admitted.value.revision, {
				...io,
				signal: AbortSignal.any([signal, io.signal]),
			}),
		);
		this.assertEpoch(request.epoch);
		if (!begun.ok) throw new SessionRecoveryError(begun.code, begun.message);
		attempt.record = begun.value.record;
		attempt.token = begun.value.token; // B5's private token identity MUST NOT be cloned or reconstructed.
		await this.checkMaintenance(false);
	}
	async prepareMaintenance(plan: NativePlanRef): Promise<void> {
		const attempt = await this.checkMaintenance(false);
		this.maintenanceScope.beginAppend(attempt);
		// The native prepare is already durable. Late cancel/expiry may not erase it.
		attempt.prepared = true;
		const deadlineMs = Date.now() + MAINTENANCE_RECOVERY_IO_TIMEOUT_MS;
		const result = await bounded(deadlineMs, (signal) =>
			this.binding!.maintenance.prepareMaintenance(attempt.token!, plan, { deadlineMs, signal }),
		);
		this.assertMaintenance(false);
		if (!result.ok) throw new SessionRecoveryError("RECOVERY_MAINTENANCE_UNCERTAIN", result.code);
		attempt.record = result.value;
		if (result.value.state !== "PREPARED") throw new SessionRecoveryError("RECOVERY_MAINTENANCE_UNCERTAIN");
	}
	async consumeMaintenance(completion: MaintenanceCompletion): Promise<void> {
		const attempt = await this.checkMaintenance(false);
		const deadlineMs = Date.now() + MAINTENANCE_RECOVERY_IO_TIMEOUT_MS;
		const result = await bounded(deadlineMs, (signal) =>
			this.binding!.maintenance.consumeMaintenance(attempt.token!, completion, { deadlineMs, signal }),
		);
		this.assertMaintenance(false);
		if (!result.ok || result.value.state !== "CONSUMED")
			throw new SessionRecoveryError("RECOVERY_MAINTENANCE_UNCERTAIN");
		attempt.record = result.value;
	}
	releaseMaintenance(attempt: NativeMaintenanceAttempt): void {
		if (attempt !== this.maintenanceAttempt) throw new SessionRecoveryError("RECOVERY_MAINTENANCE_TOKEN_REUSED");
		if (attempt.record && attempt.record.state !== "CONSUMED") throw this.block("RECOVERY_MAINTENANCE_UNCERTAIN");
		this.maintenanceScope.close(attempt);
		this.maintenanceAttempt = undefined;
	}
	async cancelMaintenance(): Promise<void> {
		const attempt = this.maintenanceAttempt;
		if (!attempt) return;
		attempt.cancelRequested = true;
		if (!attempt.prepared) attempt.controller.abort(new SessionRecoveryError("RECOVERY_MAINTENANCE_CANCELLED"));
		if (attempt.record) {
			const result = await this.binding!.maintenance.cancelMaintenance(
				{ sessionId: this.host.sessionId, requestId: attempt.requestId },
				this.identity,
				{ deadlineMs: Date.now() + MAINTENANCE_RECOVERY_IO_TIMEOUT_MS },
			);
			if (!result.ok) throw this.block("RECOVERY_MAINTENANCE_UNCERTAIN", result);
		}
		await attempt.completion;
		if (attempt.record && attempt.record.state !== "CONSUMED") throw this.block("RECOVERY_MAINTENANCE_UNCERTAIN");
	}
	clearSelected(): void {
		this.input = undefined;
		this.inputEntryId = undefined;
		this.runId = undefined;
		this.permitted = false;
		this.permission = undefined;
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
		this.maintenanceAttempt?.controller.abort(new SessionRecoveryError("RECOVERY_EPOCH_REVOKED"));
		this.clearSelected();
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
			"validateCompaction",
			"validateMaintenanceReceipts",
			"reconcile",
			"verifyNativeEntries",
		] as const)
			if (typeof this.binding[name] !== "function") throw this.block("RECOVERY_BINDING_INCOMPLETE");
		for (const name of [
			"admitMaintenance",
			"beginMaintenance",
			"prepareMaintenance",
			"consumeMaintenance",
			"adoptMaintenance",
			"read",
			"listPending",
			"withMaintenanceAttempt",
			"assertMaintenanceGate",
			"cancelMaintenance",
			"reconcileAfterJoin",
			"captureTaskAbort",
			"releaseLostMaintenance",
		] as const)
			if (typeof this.binding.maintenance?.[name] !== "function") throw this.block("RECOVERY_BINDING_INCOMPLETE");
		this.binding.advanceEpoch?.(this.identity);
	}
	block(code: string, cause?: unknown): SessionRecoveryError {
		if (this.phase !== "RETIRED") this.phase = "BLOCKED";
		this.permitted = false;
		const error = new SessionRecoveryError(code, code, { cause });
		this.permission?.reject(error);
		return error;
	}
	assertEpoch(epoch: number | RecoveryEpoch): void {
		if (
			(typeof epoch === "number" ? epoch !== this.epoch : !sameRecoveryEpoch(epoch, this.identity)) ||
			this.phase === "RETIRED"
		)
			throw new SessionRecoveryError("RECOVERY_EPOCH_REVOKED");
	}
	select(value: AcceptedRecoveryInput, entryId?: string): Readonly<AcceptedRecoveryInput> {
		if (this.maintenanceAttempt) throw new SessionRecoveryError("RECOVERY_MAINTENANCE_BUSY");
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
			this.binding!.beforeProvider({ input: this.input!, epoch: this.identity, purpose: "turn", signal }),
		);
		this.assertEpoch(epoch);
		if (!result?.permitted || this.phase !== "DELIVERING") throw this.block("RECOVERY_PROVIDER_NOT_PERMITTED");
		this.permitted = true;
		this.phase = "RUNNING";
		this.permission?.resolve();
	}
	async beforeProvider(signal?: AbortSignal, purpose: ProviderPurpose = "turn"): Promise<void> {
		if (!this.required) return;
		if (purpose === "bug-report" || !["turn", "compact-summary", "tree-summary"].includes(purpose))
			throw new SessionRecoveryError("RECOVERY_MAINTENANCE_PURPOSE_UNSUPPORTED");
		if (this.maintenanceAttempt) {
			const attempt = await this.checkMaintenance();
			const operation = attempt.operation;
			this.binding!.maintenance.assertMaintenanceGate(attempt.token!, purpose, attempt.record!.request.viewSha256);
			if (
				!(
					(purpose === "compact-summary" && operation.kind !== "tree-nav") ||
					(purpose === "tree-summary" && operation.kind === "tree-nav" && operation.summarize)
				)
			)
				throw new SessionRecoveryError("RECOVERY_MAINTENANCE_KIND_MISMATCH");
			const result = await bounded(attempt.deadlineMs, (deadlineSignal) =>
				this.binding!.beforeProvider({
					input: attempt.token!,
					epoch: this.identity,
					purpose,
					signal: AbortSignal.any([deadlineSignal, attempt.controller.signal, ...(signal ? [signal] : [])]),
				}),
			);
			await this.checkMaintenance();
			signal?.throwIfAborted();
			if (!result?.permitted) throw new SessionRecoveryError("RECOVERY_PROVIDER_NOT_PERMITTED");
			return;
		}
		if (purpose === "tree-summary") throw new SessionRecoveryError("RECOVERY_MAINTENANCE_UNBOUND");
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
				epoch: this.identity,
				purpose,
				signal: signal ? AbortSignal.any([signal, attemptSignal]) : attemptSignal,
			}),
		);
		this.assertEpoch(epoch);
		if (signal?.aborted || !result?.permitted || this.phase !== "RUNNING")
			throw this.block("RECOVERY_PROVIDER_NOT_PERMITTED");
	}
	async project(messages: AgentMessage[]): Promise<AgentMessage[]> {
		if (!this.required) return messages;
		if (this.maintenanceAttempt) {
			const attempt = await this.checkMaintenance();
			this.binding!.maintenance.assertMaintenanceGate(
				attempt.token!,
				attempt.operation.kind === "tree-nav" ? "tree-summary" : "compact-summary",
				attempt.record!.request.viewSha256,
			);
			const projected = await this.binding!.projectContext(structuredClone(messages), attempt.token!, this.identity);
			await this.checkMaintenance();
			if (!Array.isArray(projected)) throw this.block("RECOVERY_CONTEXT_MALFORMED");
			return projected;
		}
		if (!this.input || !this.binding) throw this.block("RECOVERY_CONTEXT_UNBOUND");
		const epoch = this.epoch;
		const projected = await this.binding.projectContext(structuredClone(messages), this.input, this.identity);
		this.assertEpoch(epoch);
		if (this.phase !== "RUNNING" || !this.permitted) throw new SessionRecoveryError("RECOVERY_PROVIDER_HELD");
		if (!Array.isArray(projected)) throw this.block("RECOVERY_CONTEXT_MALFORMED");
		return projected;
	}
	async cancel(selfCall = false): Promise<void> {
		if (!this.required) throw new SessionRecoveryError("RECOVERY_NOT_REQUIRED");
		if (this.phase === "RETIRED") throw new SessionRecoveryError("RECOVERY_RETIRED");
		if (this.cancelAttempt?.promise) return this.cancelAttempt.promise;
		if (this.maintenanceAttempt) {
			const attempt = this.maintenanceAttempt;
			this.taskCancellationPending = true;
			attempt.taskAbort ??= { requestId: randomUUID(), at: Date.now(), bootId: PI_PROCESS_INCARNATION_ID };
			if (attempt.record) {
				const abort = attempt.taskAbort;
				const result = await this.binding!.maintenance.captureTaskAbort(
					this.host.sessionId,
					abort.requestId,
					this.identity,
					abort.at,
					abort.bootId,
					{ deadlineMs: Date.now() + MAINTENANCE_RECOVERY_IO_TIMEOUT_MS },
				);
				if (!result.ok) throw this.block("RECOVERY_MAINTENANCE_UNCERTAIN", result);
			}
			await this.cancelMaintenance();
			this.taskCancellationPending = false;
			return;
		}
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
		this.clearSelected();
		const epoch = ++this.epoch;
		binding?.advanceEpoch?.(this.identity);
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
		this.maintenanceAttempt?.controller.abort(new SessionRecoveryError("RECOVERY_RETIRED"));
		this.clearSelected();
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
