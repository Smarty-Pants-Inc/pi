import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { ordinaryClock } from "./ordinary-clock.ts";
import type { OrdinaryExecutionRequest } from "./ordinary-executor.ts";
import { type NativeRequestSource, nonViewRequest, requestCost, requestDigest } from "./ordinary-request-evidence.ts";
import {
	type OrdinaryObservedRefresh,
	OrdinarySc085Setup,
	type OrdinaryValidatedSetup,
	type SetupRawRef,
} from "./ordinary-sc085-setup.ts";
import type {
	OrdinaryCapture,
	OrdinaryExposureFrame,
	OrdinaryExposureReceipt,
	OrdinaryProviderOutcome,
} from "./ordinary-sense.ts";
import type { TokenReservation, TokenSettlement } from "./ordinary-token-budget.ts";

export type OrdinaryDiagnosticSink = (
	original: OrdinaryExecutionRequest,
	stderr: Uint8Array,
) => Promise<string | undefined>;

export interface NativeAuditStamp {
	monotonicMs: number;
	wallMs: number;
	/** Local observations are not a qualified mapping into the caller's Clock. */
	clockId: string;
	uncertaintyMs: null;
}
/** Select retained originals, never a timestamp supplied by the host caller. */
export type Sc085StampSelector =
	| { kind: "request"; requestId: string; phase: "prepared" | "dispatch" | "settled" | "retired" }
	| { kind: "exposure"; requestId: string }
	| { kind: "window"; cursor: object; edge: "start" | "end" };

export interface NativeSessionAuditState {
	activeRun: boolean;
	preflights: number;
	compacting: boolean;
	retrying: boolean;
	steering: number;
	followUp: number;
	attempt: number | null;
}
export interface NativeTuiAuditState {
	pendingUserInputs: number;
	userInputInFlight: boolean;
	compactionQueuedMessages: number;
	/** Includes unsettled prompt promises which can still restore the queue. */
	compactionQueueTransfers: number;
}
export interface NativeAuditEvent {
	sequence: number;
	source: "agent" | "session" | "owner" | "provider" | "tui";
	kind: string;
	at: NativeAuditStamp;
	runId: number | null;
	turnId: number | null;
	nativeState: Readonly<{ activeRun: boolean; steering: number; followUp: number }> | null;
	sessionState: NativeSessionAuditState | null;
	tuiState: NativeTuiAuditState | null;
	wakePending: boolean | null;
	requestId: string | null;
}
interface RequestAudit {
	reservation: TokenReservation;
	bytes: Uint8Array;
	settlement?: TokenSettlement;
	retired: boolean;
	preparedAt: NativeAuditStamp;
	dispatchAt?: NativeAuditStamp;
	settledAt?: NativeAuditStamp;
	retiredAt?: NativeAuditStamp;
	runId: number | null;
	turnId: number | null;
}

/** Private original-owner evidence store, not a grant or an ops controller.
 * Bounded loss is sticky and explicit; no polling-derived completeness claim.
 * Bodies stay in memory and are never appended to the session or include headers. */
export class OrdinaryOperationalAudit {
	readonly #scope: Readonly<{ ownerEpoch: string; sessionId: string; allocationId: string }>;
	readonly #source: Readonly<NativeRequestSource> | null;
	readonly clock = ordinaryClock;
	readonly clockIdentity: Readonly<{
		id: string;
		ownerEpoch: string;
		allocationId: string;
		timeOriginMs: number;
		source: "node:perf_hooks.performance";
		correspondence: "original-runtime-clock-source";
		uncertaintyMs: null;
		restartComparable: false;
	}>;
	readonly #maxEvents: number;
	readonly #maxRequestBytes: number;
	readonly #setup: OrdinarySc085Setup;
	#setupNotificationReceived = false;
	#setupReceiverRegistered = false;
	readonly #requests = new Map<TokenReservation, RequestAudit>();
	readonly #captures = new WeakMap<OrdinaryCapture, OrdinaryCapture>();
	readonly #outcomes = new Map<string, OrdinaryProviderOutcome>();
	readonly #exposures = new Map<
		string,
		{ frame: OrdinaryExposureFrame; receipt: OrdinaryExposureReceipt; at: NativeAuditStamp }
	>();
	readonly #cursors = new WeakMap<
		object,
		{
			window: object;
			sequence: number;
			at: NativeAuditStamp;
			runId: number | null;
			turnId: number | null;
			nativeState: Readonly<{ activeRun: boolean; steering: number; followUp: number }> | null;
			sessionState: Readonly<NativeSessionAuditState> | null;
			wakePending: boolean | null;
		}
	>();
	#exposureBytes = 0;
	#exposureLost = false;
	readonly #notified = new Set<string>();
	#requestSink?: (receipt: ReturnType<OrdinaryOperationalAudit["requests"]>[number]) => void;
	#exposureSink?: (frame: OrdinaryExposureFrame, receipt: OrdinaryExposureReceipt) => void;
	#diagnosticSink?: OrdinaryDiagnosticSink;
	#executionStarted = false;
	#diagnosticFailure?: { cause: unknown };
	readonly #diagnosticRequests = new WeakSet<OrdinaryExecutionRequest>();
	#events: NativeAuditEvent[] = [];
	#sequence = 0;
	#lost = false;
	#activeWindow?: object;
	#windowStart = 0;
	#closed = false;
	#coreClockSupplied = false;
	#retainedBytes = 0;
	#run = 0;
	#turn = 0;
	#currentRun: number | null = null;
	#currentTurn: number | null = null;
	#nativeState: Readonly<{ activeRun: boolean; steering: number; followUp: number }> | null = null;
	#initialNativeState: Readonly<{ activeRun: boolean; steering: number; followUp: number }> | null = null;
	#runStarts = 0;
	#turnStarts = 0;
	#activeRunPeak = 0;
	#nativeAttached = false;
	#unmatchedTurnEnd = false;
	#sessionState: NativeSessionAuditState | null = null;
	#initialSessionState: NativeSessionAuditState | null = null;
	#wakePending: boolean | null = null;
	#initialWakePending: boolean | null = null;
	#wakePeak = 0;
	#preflightPeak = 0;
	#turnPeak = 0;
	#windowStartedAt: NativeAuditStamp | null = null;
	#tui?: { source: object; snapshot: () => NativeTuiAuditState };
	#tuiState: NativeTuiAuditState | null = null;
	#initialTuiState: NativeTuiAuditState | null = null;
	#tuiPeak = 0;
	#tuiDetached = false;

	constructor(
		scope: { ownerEpoch: string; sessionId: string; allocationId: string },
		maxEvents: number,
		maxRequestBytes: number,
		source?: NativeRequestSource,
	) {
		if (
			!Number.isSafeInteger(maxEvents) ||
			maxEvents < 1 ||
			maxEvents > 65536 ||
			!Number.isSafeInteger(maxRequestBytes) ||
			maxRequestBytes < 1 ||
			maxRequestBytes > 16 * 1024 * 1024
		)
			throw new Error("OWNER_AUDIT_LIMIT");
		this.#scope = Object.freeze({ ...scope });
		this.#source = source ? Object.freeze({ ...source }) : null;
		this.clockIdentity = Object.freeze({
			id: randomUUID(),
			ownerEpoch: scope.ownerEpoch,
			allocationId: scope.allocationId,
			timeOriginMs: performance.timeOrigin,
			source: "node:perf_hooks.performance",
			correspondence: "original-runtime-clock-source",
			uncertaintyMs: null,
			restartComparable: false,
		});
		this.#maxEvents = maxEvents;
		this.#maxRequestBytes = maxRequestBytes;
		this.#setup = new OrdinarySc085Setup(this.#scope, maxRequestBytes);
		Object.freeze(this);
	}

	/** Original executor only, after request validation and before native effects. */
	beginSetupExecution(original: OrdinaryExecutionRequest) {
		if (this.#closed || this.#lost) return () => {};
		return this.#setup.begin(original);
	}

	/** Original runtime registration only, using the evidence custody retained by B.
	 * No authority is created here; the owner supplies its own current check. */
	registerValidatedSetupReceiver(
		register: (receive: (event: OrdinaryValidatedSetup) => Promise<SetupRawRef>) => void,
		retained: Pick<ReadonlyMap<string, Uint8Array>, "get">,
		record: (value: unknown) => SetupRawRef,
		checkCurrent: () => void,
	): void {
		checkCurrent();
		if (
			this.#setupReceiverRegistered ||
			this.#closed ||
			this.#lost ||
			this.#sessionState ||
			this.#executionStarted ||
			this.#requests.size
		) {
			throw new Error("OWNER_SC085_SETUP_REGISTRATION");
		}
		this.#setupReceiverRegistered = true;
		try {
			register(async (event) => this.receiveValidatedSetup(event, retained, record, checkCurrent));
			checkCurrent();
			if (this.#closed || this.#lost) throw new Error("OWNER_SC085_SETUP_AUDIT_LOST");
		} catch (cause) {
			this.#setupNotificationReceived = true;
			throw cause;
		}
	}

	/** Private runtime receiving uses original retained custody, not arbitrary paths.
	 * Matching this event proves association only, never source authority. */
	receiveValidatedSetup(
		event: OrdinaryValidatedSetup,
		retained: Pick<ReadonlyMap<string, Uint8Array>, "get">,
		record: (value: unknown) => SetupRawRef,
		checkCurrent: () => void,
	): SetupRawRef {
		if (this.#setupNotificationReceived) throw new Error("OWNER_SC085_SETUP_DUPLICATE");
		this.#setupNotificationReceived = true;
		const current = () => {
			checkCurrent();
			if (this.#closed || this.#lost) throw new Error("OWNER_SC085_SETUP_AUDIT_LOST");
		};
		current();
		const candidates = this.requests().filter(
			(row) => row.nativeAccepted && row.native && isDeepStrictEqual(row.native.receipt, event.baseline.native),
		);
		if (candidates.length !== 1 || !candidates[0].native) throw new Error("OWNER_SC085_SETUP_ORIGINAL_REQUEST");
		const row = candidates[0];
		return this.#setup.receive(
			event,
			{
				requestId: row.requestId,
				native: candidates[0].native.receipt,
				finalBytes: row.finalBytes,
				exposure: this.requestExposure(row.requestId),
			},
			retained,
			record,
			current,
		);
	}

	validateSc085Checkpoint(value: OrdinaryObservedRefresh, retained: ReadonlyMap<string, Uint8Array>) {
		if (this.#closed || this.#lost) throw new Error("OWNER_SC085_SETUP_AUDIT_LOST");
		return this.#setup.checkpoint(value, retained);
	}

	validatedSetup() {
		if (this.#closed || this.#lost) throw new Error("OWNER_SC085_SETUP_AUDIT_LOST");
		return this.#setup.baseline();
	}

	/** Called only at the original Core options construction. Not readiness. */
	clockForCore() {
		if (this.#coreClockSupplied || this.#closed) throw new Error("OWNER_AUDIT_CLOCK_BOUND");
		this.#coreClockSupplied = true;
		return this.clock;
	}

	#stamp(): NativeAuditStamp {
		return {
			monotonicMs: this.clock.monotonic(),
			wallMs: this.clock.wallTime(),
			clockId: this.clockIdentity.id,
			uncertaintyMs: null,
		};
	}

	capture(value: OrdinaryCapture | null): void {
		if (value && !this.#closed) {
			if (this.#captures.has(value)) {
				this.#lost = true;
				return;
			}
			this.#captures.set(value, { ...value });
		}
	}

	/** Arm the existing host recorder before invocation. Notification follows the
	 * actual three-way join, not polling or an invoke Promise's completion. */
	bindRequestSink(sink: (receipt: ReturnType<OrdinaryOperationalAudit["requests"]>[number]) => void): void {
		if (this.#closed || this.#requestSink || this.#requests.size) throw new Error("OWNER_AUDIT_SINK_BOUND");
		this.#requestSink = sink;
	}

	/** Host binds before Core/runtime creation; no default writer or author API. */
	bindDiagnosticSink(sink: OrdinaryDiagnosticSink): void {
		if (
			this.#closed ||
			this.#diagnosticSink ||
			this.#executionStarted ||
			this.#sessionState ||
			typeof sink !== "function"
		) {
			throw new Error("OWNER_AUDIT_DIAGNOSTIC_BOUND");
		}
		this.#diagnosticSink = sink;
	}

	#assertDiagnosticHealthy(): void {
		if (this.#diagnosticFailure) throw this.#diagnosticFailure.cause;
	}

	/** Capture the original executor invocation before native work. Only that
	 * executor publishes complete stderr after its original runProcess join. */
	beginDiagnostic(original: OrdinaryExecutionRequest): (stderr: Uint8Array) => Promise<string | undefined> {
		if (this.#diagnosticFailure) throw this.#diagnosticFailure.cause;
		if (
			this.#closed ||
			this.#diagnosticRequests.has(original) ||
			original.ownerEpoch !== this.#scope.ownerEpoch ||
			original.scope.sessionId !== this.#scope.sessionId
		)
			throw new Error("OWNER_AUDIT_DIAGNOSTIC_REQUEST");
		this.#executionStarted = true;
		this.#diagnosticRequests.add(original);
		const sink = this.#diagnosticSink;
		const limit = original.limits.maxStderrBytes;
		let used = false;
		return async (stderr) => {
			if (!sink) return undefined;
			try {
				this.#assertDiagnosticHealthy();
				if (
					used ||
					this.#closed ||
					!Number.isSafeInteger(limit) ||
					limit < 0 ||
					!stderr.length ||
					stderr.length > limit
				) {
					throw new Error("OWNER_AUDIT_DIAGNOSTIC_BYTES");
				}
				used = true;
				const ref = await sink(original, Uint8Array.from(stderr));
				this.#assertDiagnosticHealthy();
				if (this.#closed) throw new Error("OWNER_AUDIT_DIAGNOSTIC_CLOSED");
				if (ref !== undefined && (typeof ref !== "string" || !ref)) throw new Error("OWNER_AUDIT_DIAGNOSTIC_REF");
				return ref;
			} catch (cause) {
				this.#lost = true;
				this.#diagnosticFailure ??= { cause };
				throw this.#diagnosticFailure.cause;
			}
		};
	}

	/** Forward only the original validated Core callback. The Foundation adapter
	 * retains/matches it; Pi does not implement a second common-exposure matcher. */
	bindExposureSink(sink: (frame: OrdinaryExposureFrame, receipt: OrdinaryExposureReceipt) => void): void {
		if (this.#closed || this.#exposureSink || this.#requests.size) throw new Error("OWNER_AUDIT_SINK_BOUND");
		this.#exposureSink = sink;
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
			const retained = structuredClone({ frame, receipt, at: this.#stamp() });
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

	#notify(): void {
		if (!this.#requestSink || this.#lost) return;
		try {
			for (const receipt of this.requests()) {
				if (this.#lost) break;
				if (!receipt.nativeAccepted || this.#notified.has(receipt.requestId)) continue;
				this.#notified.add(receipt.requestId);
				this.#requestSink(receipt);
			}
		} catch {
			this.#lost = true;
		}
	}

	/** Direct passive CoreOptions callback, installed before the original Core opens.
	 * The common producer ignores sink errors, so retain failures here instead. */
	wakeIntention(event: { ownerEpoch: string; pending: boolean }): void {
		if (this.#closed) return;
		try {
			if (
				event.ownerEpoch !== this.#scope.ownerEpoch ||
				typeof event.pending !== "boolean" ||
				(this.#wakePending === null && event.pending) ||
				this.#wakePending === event.pending
			) {
				this.#lost = true;
				return;
			}
			this.#wakePending = event.pending;
			if (this.#activeWindow) this.#wakePeak = Math.max(this.#wakePeak, Number(event.pending));
			this.event("owner", "common-wake-intention");
		} catch {
			this.#lost = true;
		}
	}

	/** Original TUI only: attach before input handlers are installed. No polling. */
	bindTui(source: object, snapshot: () => NativeTuiAuditState): void {
		if (this.#closed || this.#tui) {
			this.#lost = true;
			throw new Error("OWNER_AUDIT_TUI_BOUND");
		}
		this.#tui = { source, snapshot };
		this.tui(source, "attached");
	}

	/** Called synchronously after each staging mutation, before external callbacks. */
	tui(source: object, kind: string): void {
		if (this.#closed || this.#tuiDetached || !this.#tui || source !== this.#tui.source) {
			this.#lost = true;
			return;
		}
		try {
			const state = this.#tui.snapshot();
			if (
				typeof state.userInputInFlight !== "boolean" ||
				![state.pendingUserInputs, state.compactionQueuedMessages, state.compactionQueueTransfers].every(
					(value) => Number.isSafeInteger(value) && value >= 0,
				)
			)
				throw new Error("OWNER_AUDIT_TUI_STATE");
			if (
				(kind === "window-start" || kind === "window-finish" || kind === "owner-close") &&
				this.#tuiState &&
				Object.keys(this.#tuiState).some(
					(key) => this.#tuiState![key as keyof NativeTuiAuditState] !== state[key as keyof NativeTuiAuditState],
				)
			) {
				this.#lost = true;
			}
			this.#tuiState = { ...state };
			if (this.#activeWindow)
				this.#tuiPeak = Math.max(
					this.#tuiPeak,
					state.pendingUserInputs +
						Number(state.userInputInFlight) +
						state.compactionQueuedMessages +
						state.compactionQueueTransfers,
				);
			this.event("tui", kind);
			if (kind === "detached") {
				this.#tuiDetached = true;
				this.#lost = true;
			}
		} catch {
			this.#lost = true;
		}
	}

	session(kind: string, state: NativeSessionAuditState): void {
		if (this.#closed) return;
		this.#sessionState = { ...state };
		if (this.#activeWindow) this.#preflightPeak = Math.max(this.#preflightPeak, state.preflights);
		this.event("session", kind);
	}

	native(event: Readonly<{ type: string; activeRun: boolean; steering: number; followUp: number }>): void {
		if (this.#closed) return;
		this.#nativeState = { activeRun: event.activeRun, steering: event.steering, followUp: event.followUp };
		if (event.type === "attached") this.#nativeAttached = true;
		if (event.type === "run_start") {
			if (this.#currentRun !== null) this.#lost = true;
			this.#currentRun = ++this.#run;
			if (this.#activeWindow) this.#runStarts++;
		}
		if (event.type === "turn_start") {
			if (this.#currentTurn !== null) this.#lost = true;
			this.#currentTurn = ++this.#turn;
			if (this.#activeWindow) {
				this.#turnStarts++;
				this.#turnPeak = 1;
			}
		}
		if (this.#activeWindow) this.#activeRunPeak = Math.max(this.#activeRunPeak, Number(event.activeRun));
		if (event.type === "turn_end" && this.#currentTurn === null) this.#unmatchedTurnEnd = true;
		this.event("agent", event.type);
		if (event.type === "turn_end") this.#currentTurn = null;
		if (event.type === "run_settled") {
			this.#currentRun = null;
			this.#currentTurn = null;
		}
	}

	event(source: NativeAuditEvent["source"], kind: string, requestId: string | null = null): void {
		if (this.#closed) return;
		this.#sequence++;
		if (!this.#activeWindow) return;
		if (this.#events.length >= this.#maxEvents) {
			this.#lost = true;
			return;
		}
		try {
			this.#events.push({
				sequence: this.#sequence,
				source,
				kind,
				requestId,
				runId: this.#currentRun,
				turnId: this.#currentTurn,
				nativeState: this.#nativeState,
				sessionState: this.#sessionState,
				tuiState: this.#tuiState,
				wakePending: this.#wakePending,
				at: this.#stamp(),
			});
		} catch {
			this.#lost = true;
		}
	}

	begin(): object {
		if (this.#closed || this.#activeWindow) throw new Error("OWNER_AUDIT_WINDOW");
		if (this.#tui) this.tui(this.#tui.source, "window-start");
		this.#initialTuiState = this.#tuiState;
		this.#tuiPeak = this.#tuiState
			? this.#tuiState.pendingUserInputs +
				Number(this.#tuiState.userInputInFlight) +
				this.#tuiState.compactionQueuedMessages +
				this.#tuiState.compactionQueueTransfers
			: 0;
		this.#activeWindow = Object.freeze({});
		this.#windowStart = this.#sequence;
		this.#windowStartedAt = this.#stamp();
		this.#turnPeak = Number(this.#currentTurn !== null);
		this.#events = [];
		this.#initialNativeState = this.#nativeState;
		this.#initialSessionState = this.#sessionState;
		this.#initialWakePending = this.#wakePending;
		this.#wakePeak = Number(this.#wakePending ?? false);
		this.#preflightPeak = this.#sessionState?.preflights ?? 0;
		this.#runStarts = this.#turnStarts = 0;
		this.#activeRunPeak = Number(this.#nativeState?.activeRun ?? false);
		return this.#activeWindow;
	}

	finish(window: object) {
		if (window !== this.#activeWindow || !window) throw new Error("OWNER_AUDIT_WINDOW");
		if (this.#tui && !this.#closed) this.tui(this.#tui.source, "window-finish");
		this.#activeWindow = undefined;
		const tuiComplete = this.#initialTuiState !== null && !this.#lost && !this.#tuiDetached;
		return {
			scope: this.#scope,
			startSequence: this.#windowStart,
			endSequence: this.#sequence,
			startedAt: this.#windowStartedAt ? { ...this.#windowStartedAt } : null,
			finishedAt: this.#stamp(),
			clockIdentity: this.clockIdentity,
			coreClockSupplied: this.#coreClockSupplied,
			events: structuredClone(this.#events),
			lost: this.#lost,
			coverage: "unknown" as const,
			tuiEventsComplete: tuiComplete,
			initialTuiState: this.#initialTuiState ? { ...this.#initialTuiState } : null,
			finalTuiState: this.#tuiState ? { ...this.#tuiState } : null,
			tuiStagingPeak: tuiComplete ? this.#tuiPeak : null,
			missing: [
				...(tuiComplete ? [] : ["TUI submitted-input transitions"]),
				"qualified clock mapping",
				...(this.#initialWakePending === null ? ["initial common wake-intention state"] : []),
			],
			nativeEventsComplete: this.#nativeAttached && !this.#lost,
			initialNativeState: this.#initialNativeState ? { ...this.#initialNativeState } : null,
			finalNativeState: this.#nativeState ? { ...this.#nativeState } : null,
			runStarts: this.#runStarts,
			turnStarts: this.#turnStarts,
			unmatchedTurnEnd: this.#unmatchedTurnEnd,
			activeRunPeak: this.#nativeAttached && !this.#lost ? this.#activeRunPeak : null,
			initialSessionState: this.#initialSessionState ? { ...this.#initialSessionState } : null,
			finalSessionState: this.#sessionState ? { ...this.#sessionState } : null,
			preflightPeak: this.#initialSessionState && !this.#lost ? this.#preflightPeak : null,
			initialWakePending: this.#initialWakePending,
			finalWakePending: this.#wakePending,
			pendingIntentPeak: this.#initialWakePending !== null && !this.#lost ? this.#wakePeak : null,
			concurrentTurnPeak: this.#nativeAttached && !this.#lost && !this.#unmatchedTurnEnd ? this.#turnPeak : null,
		};
	}

	request(reservation: TokenReservation, bytes: Uint8Array): void {
		if (
			this.#closed ||
			this.#requests.has(reservation) ||
			this.#requests.size >= 8 ||
			[...this.#requests.keys()].some((original) => original.requestId === reservation.requestId) ||
			reservation.scope.ownerEpoch !== this.#scope.ownerEpoch ||
			reservation.scope.sessionId !== this.#scope.sessionId ||
			reservation.scope.allocationId !== this.#scope.allocationId ||
			createHash("sha256").update(bytes).digest("hex") !== reservation.payloadHash
		)
			throw new Error("OWNER_AUDIT_REQUEST");
		const fits = bytes.length <= this.#maxRequestBytes - this.#retainedBytes;
		if (!fits) this.#lost = true;
		this.#retainedBytes += fits ? bytes.length : 0;
		this.#requests.set(reservation, {
			reservation,
			bytes: fits ? Uint8Array.from(bytes) : new Uint8Array(),
			retired: false,
			preparedAt: this.#stamp(),
			runId: this.#currentRun,
			turnId: this.#currentTurn,
		});
		this.event("provider", "inference-prepared", reservation.requestId);
	}

	/** Actual final native authorization boundary, before original socket bytes. */
	dispatch(reservation: TokenReservation): void {
		const request = this.#requests.get(reservation);
		if (!request || request.dispatchAt) throw new Error("OWNER_AUDIT_DISPATCH");
		request.dispatchAt = this.#stamp();
		this.event("provider", "inference-dispatch-authorized", reservation.requestId);
	}

	settlement(value: TokenSettlement): void {
		const request = this.#requests.get(value.reservation);
		if (!request || request.settlement) throw new Error("OWNER_AUDIT_SETTLEMENT");
		if (
			value.responseId &&
			[...this.#requests.values()].some(
				(other) => other !== request && other.settlement?.responseId === value.responseId,
			)
		) {
			this.#lost = true;
		}
		request.settlement = value;
		request.settledAt = this.#stamp();
		this.#notify();
	}

	retired(reservation: TokenReservation): void {
		const request = this.#requests.get(reservation);
		if (!request || request.retired) throw new Error("OWNER_AUDIT_RETIREMENT");
		request.retired = true;
		request.retiredAt = this.#stamp();
		this.event("provider", "inference-operation-retired", reservation.requestId);
		this.#notify();
	}

	outcome(value: OrdinaryProviderOutcome): void {
		if (this.#closed) {
			this.#lost = true;
			return;
		}
		if (
			!value.capture ||
			!this.#captures.has(value.capture) ||
			value.kind !== "decision" ||
			!value.providerResponseId ||
			value.acceptanceBasis !== "native-responses-result"
		)
			return;
		const original = this.#captures.get(value.capture)!;
		if (
			original.decisionId !== value.capture.decisionId ||
			original.capturedAt !== value.capture.capturedAt ||
			original.frameText !== value.capture.frameText ||
			original.frameHash !== value.capture.frameHash
		) {
			this.#lost = true;
			return;
		}
		const key = value.providerResponseId;
		if (this.#outcomes.has(key) || this.#outcomes.size >= 8) {
			this.#lost = true;
			return;
		}
		this.#outcomes.set(key, structuredClone(value));
		this.event("provider", "provider-outcome-observed");
		this.#notify();
	}

	/** Join by actual parser response identity AND final bytes, not equal prompts,
	 * callback order, HTTP status or a caller-supplied acceptance boolean. */
	joinedRequest(reservation: TokenReservation) {
		const request = this.#requests.get(reservation);
		if (!request) throw new Error("OWNER_AUDIT_REQUEST");
		return this.#requestRow(request);
	}

	requests() {
		return [...this.#requests.values()].map((request) => this.#requestRow(request));
	}

	#requestRow(request: RequestAudit) {
		const settlement = request.settlement;
		const outcome = settlement?.responseId ? this.#outcomes.get(settlement.responseId) : undefined;
		const capture = outcome?.capture;
		const correlated =
			!this.#lost &&
			request.retired &&
			settlement?.streamEnded &&
			settlement.terminal !== null &&
			settlement.terminal !== "failed" &&
			settlement.disposition !== "over-budget" &&
			outcome?.outcome === "accepted" &&
			outcome.payloadHash === request.reservation.payloadHash;
		const noView = capture?.frameHash === null && capture.frameText === null;
		return {
			scope: this.#scope,
			requestId: request.reservation.requestId,
			clockIdentity: this.clockIdentity,
			coreClockSupplied: this.#coreClockSupplied,
			source: this.#source,
			requestTimes: {
				prepared: { ...request.preparedAt },
				dispatch: request.dispatchAt ? { ...request.dispatchAt } : null,
				settled: request.settledAt ? { ...request.settledAt } : null,
				retired: request.retiredAt ? { ...request.retiredAt } : null,
			},
			runId: request.runId,
			turnId: request.turnId,
			native: outcome ? { harness: "pi" as const, receipt: structuredClone(outcome) } : null,
			absenceOfViewAudit:
				correlated && noView
					? {
							requestId: request.reservation.requestId,
							decisionId: capture.decisionId,
							attemptId: `${capture.decisionId}:${outcome.attempt}`,
							providerResponseId: outcome.providerResponseId,
							payloadHash: request.reservation.payloadHash,
							frameText: null,
							frameHash: null,
							basis: "original-guarded-final-request" as const,
						}
					: null,
			decisionDigest: request.reservation.scope.decisionDigest,
			decisionId: capture?.decisionId ?? null,
			frameHash: capture?.frameHash ?? null,
			attempt: outcome?.attempt ?? null,
			attemptId: capture && outcome ? `${capture.decisionId}:${outcome.attempt}` : null,
			providerResponseId: settlement?.responseId ?? null,
			payloadHash: request.reservation.payloadHash,
			finalBytes: request.bytes.slice(),
			nativeOperationRetired: request.retired,
			kind: noView
				? ("without-view" as const)
				: capture?.frameHash && capture.frameText
					? ("with-view" as const)
					: ("unknown" as const),
			nativeAccepted: Boolean(correlated),
			acceptedRequestAudit: Boolean(correlated && noView),
			commonExposure: null,
			commonExposureRequired: !noView,
			usage: settlement?.usage ? structuredClone(settlement.usage) : null,
			cost: null,
			latencyMs: null,
			qualifiedClock: null,
			matchedRequestPair: null,
		};
	}

	/** Exact original decision/attempt join, not the latest observed frame. */
	requestExposure(requestId: string) {
		const row = this.requestEvidence(requestId);
		const original = this.#exposures.get(JSON.stringify([row.decisionId, row.attemptId]));
		if (
			!original ||
			this.#closed ||
			this.#lost ||
			this.#exposureLost ||
			!row.nativeAccepted ||
			row.kind !== "with-view" ||
			original.receipt.outcome !== "accepted" ||
			original.receipt.frameOutcome !== "OK" ||
			original.frame.outcome !== "OK" ||
			original.frame.hash !== row.frameHash ||
			original.frame.hash !== original.receipt.frameHash ||
			original.frame.revision !== original.receipt.frameRevision ||
			original.frame.text !== row.native?.receipt.capture?.frameText
		) {
			throw new Error("OWNER_AUDIT_ORIGINAL_EXPOSURE");
		}
		return { requestId: row.requestId, scope: this.#scope, ...structuredClone(original) };
	}

	/** A subinterval cursor borrows the already-running original audit window.
	 * It does not reset counters, open another meter or supply clock qualification. */
	mark(): object {
		if (
			this.#closed ||
			this.#lost ||
			!this.#activeWindow ||
			!this.#coreClockSupplied ||
			!this.#nativeAttached ||
			this.#wakePending === null ||
			!this.#sessionState
		) {
			throw new Error("OWNER_AUDIT_COVERAGE");
		}
		const cursor = Object.freeze({});
		this.#cursors.set(cursor, {
			window: this.#activeWindow,
			sequence: this.#sequence,
			at: this.#stamp(),
			runId: this.#currentRun,
			turnId: this.#currentTurn,
			nativeState: this.#nativeState ? Object.freeze({ ...this.#nativeState }) : null,
			sessionState: this.#sessionState ? Object.freeze({ ...this.#sessionState }) : null,
			wakePending: this.#wakePending,
		});
		return cursor;
	}

	observeSince(cursor: object) {
		const start = this.#cursors.get(cursor);
		if (!start || this.#closed || this.#lost || start.window !== this.#activeWindow || this.#unmatchedTurnEnd) {
			throw new Error("OWNER_AUDIT_COVERAGE");
		}
		const events = this.#events.filter((event) => event.sequence > start.sequence);
		if (events.length !== this.#sequence - start.sequence) throw new Error("OWNER_AUDIT_COVERAGE");
		// Retain the exact endpoint used by this event snapshot. A later qualified
		// selector must not extend its measured duration past the covered events.
		const endCursor = this.mark();
		const end = this.#cursors.get(endCursor)!;
		return {
			scope: this.#scope,
			clockIdentity: this.clockIdentity,
			start: { ...start.at },
			end: { ...end.at },
			endCursor,
			events: structuredClone(events),
			nativeState: this.#nativeState ? { ...this.#nativeState } : null,
			sessionState: this.#sessionState ? { ...this.#sessionState } : null,
			wakePending: this.#wakePending,
		};
	}

	/** Physical rapid-phase evidence from this original continuous window. This
	 * does not qualify timestamps or assert the required observation duration.
	 * The owning sealer must join the enrolled automatic request and independently
	 * qualified hold/release/exposure/end stamps before publishing any Fact. */
	sc085RapidEvidence(heldCursor: object, releaseCursor: object, requestId: string) {
		const held = this.#cursors.get(heldCursor),
			released = this.#cursors.get(releaseCursor);
		const interval = this.observeSince(heldCursor);
		if (
			!held ||
			!released ||
			held.window !== released.window ||
			released.window !== this.#activeWindow ||
			held.sequence > released.sequence ||
			held.at.monotonicMs > released.at.monotonicMs
		) {
			throw new Error("OWNER_SC085_RELEASE_INTERVAL");
		}
		const initial = held.sessionState;
		if (
			!initial ||
			!held.nativeState ||
			held.nativeState.activeRun ||
			held.nativeState.steering ||
			held.nativeState.followUp ||
			held.runId !== null ||
			held.turnId !== null ||
			initial.activeRun ||
			initial.preflights ||
			initial.compacting ||
			initial.retrying ||
			initial.steering ||
			initial.followUp ||
			held.wakePending !== false
		) {
			throw new Error("OWNER_SC085_HOLD_NOT_IDLE");
		}
		const request = this.requestEvidence(requestId),
			exposure = this.requestExposure(requestId);
		if (
			request.runId === null ||
			request.turnId === null ||
			request.requestTimes.prepared.monotonicMs < released.at.monotonicMs ||
			exposure.at.monotonicMs < released.at.monotonicMs ||
			exposure.at.monotonicMs > interval.end.monotonicMs ||
			!request.requestTimes.retired ||
			request.requestTimes.retired.monotonicMs > interval.end.monotonicMs
		) {
			throw new Error("OWNER_SC085_AUTOMATIC_INTERVAL");
		}
		const final = interval.sessionState;
		if (
			!final ||
			!interval.nativeState ||
			interval.nativeState.activeRun ||
			interval.nativeState.steering ||
			interval.nativeState.followUp ||
			final.activeRun ||
			final.preflights ||
			final.compacting ||
			final.retrying ||
			final.steering ||
			final.followUp ||
			interval.wakePending !== false ||
			this.#currentRun !== null ||
			this.#currentTurn !== null
		)
			throw new Error("OWNER_SC085_OBSERVATION_NOT_SETTLED");
		const events = interval.events;
		const starts = events.filter((event) => event.source === "agent" && event.kind === "run_start");
		const automatic = starts.filter((event) => event.runId === request.runId && event.sequence > released.sequence);
		if (
			automatic.length !== 1 ||
			!events.some(
				(event) =>
					event.source === "agent" &&
					event.kind === "run_settled" &&
					event.runId === request.runId &&
					event.sequence > automatic[0].sequence,
			)
		) {
			throw new Error("OWNER_SC085_AUTOMATIC_RUN_JOIN");
		}
		let turns = 0,
			concurrentTurnPeak = 0,
			pendingPeak = 0;
		for (const event of events) {
			if (event.wakePending === null || !event.nativeState || !event.sessionState)
				throw new Error("OWNER_AUDIT_COVERAGE");
			pendingPeak = Math.max(pendingPeak, Number(event.wakePending));
			if (event.source !== "agent") continue;
			if (event.kind === "turn_start") {
				turns++;
				concurrentTurnPeak = Math.max(concurrentTurnPeak, turns);
			}
			if (event.kind === "turn_end") turns--;
			if (turns < 0 || (event.kind === "run_settled" && turns !== 0)) throw new Error("OWNER_AUDIT_COVERAGE");
		}
		if (turns !== 0) throw new Error("OWNER_AUDIT_COVERAGE");
		return {
			scope: this.#scope,
			clockIdentity: this.clockIdentity,
			requestId,
			heldAt: { ...held.at },
			releasedAt: { ...released.at },
			exposureAt: { ...exposure.at },
			observedUntil: interval.end,
			observedCursor: interval.endCursor,
			startSequence: held.sequence,
			releaseSequence: released.sequence,
			endSequence: this.#sequence,
			events,
			startsWhileHeld: starts.filter((event) => event.sequence <= released.sequence).length,
			pendingPeak,
			concurrentTurnPeak,
			automaticTurns: events.filter(
				(event) => event.source === "agent" && event.kind === "turn_start" && event.runId === request.runId,
			).length,
			otherRunStarts: starts.filter((event) => event.runId !== request.runId).length,
			// Read physical intention transitions over the whole post-exposure
			// interval. Retiring one request does not prove unchanged wake silence.
			repeatedUnchangedWakes: events.filter(
				(event) =>
					event.source === "owner" &&
					event.kind === "common-wake-intention" &&
					event.wakePending === true &&
					event.at.monotonicMs >= exposure.at.monotonicMs,
			).length,
			qualifiedClock: null,
		};
	}

	/** Physical isolated failure evidence, not a finished-hold or clock claim. */
	sc085FailureEvidence(heldCursor: object) {
		const held = this.#cursors.get(heldCursor),
			interval = this.observeSince(heldCursor);
		const initial = held?.sessionState,
			final = interval.sessionState;
		if (
			!held ||
			!initial ||
			!final ||
			!held.nativeState ||
			held.nativeState.activeRun ||
			held.nativeState.steering ||
			held.nativeState.followUp ||
			held.runId !== null ||
			held.turnId !== null ||
			initial.activeRun ||
			initial.preflights ||
			initial.compacting ||
			initial.retrying ||
			initial.steering ||
			initial.followUp ||
			held.wakePending !== false ||
			!interval.nativeState ||
			interval.nativeState.activeRun ||
			interval.nativeState.steering ||
			interval.nativeState.followUp ||
			final.activeRun ||
			final.preflights ||
			final.compacting ||
			final.retrying ||
			final.steering ||
			final.followUp ||
			interval.wakePending !== false ||
			this.#currentRun !== null ||
			this.#currentTurn !== null
		) {
			throw new Error("OWNER_SC085_FAILURE_INTERVAL");
		}
		return {
			...interval,
			starts: interval.events.filter((event) => event.source === "agent" && event.kind === "run_start").length,
			turns: interval.events.filter((event) => event.source === "agent" && event.kind === "turn_start").length,
			requests: interval.events.filter((event) => event.source === "provider" && event.kind === "inference-prepared")
				.length,
			qualifiedClock: null,
		};
	}

	/** Private Source binding resolves only this audit's original records. Raw
	 * null uncertainty stays null; independent qualification must retain a
	 * separate view referencing this sample and its received qualification. */
	resolveSc085Stamp(selector: Sc085StampSelector) {
		if (this.#closed || this.#lost || !this.#coreClockSupplied) throw new Error("OWNER_SC085_CLOCK_COVERAGE");
		let stamp: NativeAuditStamp | null;
		switch (selector.kind) {
			case "request": {
				if (!["prepared", "dispatch", "settled", "retired"].includes(selector.phase))
					throw new Error("OWNER_SC085_CLOCK_SELECTOR");
				stamp = this.requestEvidence(selector.requestId).requestTimes[selector.phase];
				break;
			}
			case "exposure":
				stamp = this.requestExposure(selector.requestId).at;
				break;
			case "window": {
				if (selector.edge !== "start" && selector.edge !== "end") throw new Error("OWNER_SC085_CLOCK_SELECTOR");
				// observeSince validates the opaque cursor and uninterrupted window.
				const interval = this.observeSince(selector.cursor);
				stamp = interval[selector.edge];
				break;
			}
			default:
				throw new Error("OWNER_SC085_CLOCK_SELECTOR");
		}
		if (
			!stamp ||
			stamp.clockId !== this.clockIdentity.id ||
			stamp.uncertaintyMs !== null ||
			!Number.isFinite(stamp.monotonicMs) ||
			stamp.monotonicMs < 0 ||
			!Number.isFinite(stamp.wallMs)
		) {
			throw new Error("OWNER_SC085_CLOCK_STAMP");
		}
		return { scope: this.#scope, clockIdentity: this.clockIdentity, stamp: { ...stamp } };
	}

	/** Host reads retained originals, not rows supplied back by a caller. */
	requestEvidence(requestId: string) {
		const original = [...this.#requests.values()].find((request) => request.reservation.requestId === requestId);
		if (!original) throw new Error("OWNER_REQUEST_HISTORY_UNAVAILABLE: original request");
		const row = this.#requestRow(original);
		const capture = row.native?.receipt.capture;
		if (!row.nativeAccepted || !capture || !this.#source)
			throw new Error("OWNER_REQUEST_HISTORY_UNAVAILABLE: accepted source");
		if (
			capture.frameText !== null &&
			requestDigest(new TextEncoder().encode(capture.frameText)) !== capture.frameHash
		) {
			throw new Error("OWNER_REQUEST_HISTORY_UNAVAILABLE: original frame hash");
		}
		const nonViewBytes = nonViewRequest(original.bytes, capture.frameText);
		return {
			...row,
			nonViewBytes,
			nonViewHash: requestDigest(nonViewBytes),
			projection: "responses-final-input-overlay-only-v1" as const,
			cost: requestCost(row.usage, original.bytes.length),
			billing: null,
		};
	}

	compareRequests(withoutRequestId: string, withRequestId: string) {
		if (withoutRequestId === withRequestId) throw new Error("OWNER_REQUEST_HISTORY_MISMATCH: same request");
		const without = this.requestEvidence(withoutRequestId),
			withView = this.requestEvidence(withRequestId);
		if (without.kind !== "without-view" || withView.kind !== "with-view")
			throw new Error("OWNER_REQUEST_HISTORY_MISMATCH: view kind");
		if (
			!isDeepStrictEqual(without.source, withView.source) ||
			!Buffer.from(without.nonViewBytes).equals(Buffer.from(withView.nonViewBytes))
		) {
			throw new Error("OWNER_REQUEST_HISTORY_MISMATCH: serialized context/model/config/artifact");
		}
		return {
			basis: "original-retained-final-requests" as const,
			scope: this.#scope,
			source: this.#source,
			withoutRequestId,
			withRequestId,
			withoutPayloadHash: without.payloadHash,
			withPayloadHash: withView.payloadHash,
			nonViewHash: without.nonViewHash,
			projection: without.projection,
		};
	}

	requestCost(requestId: string) {
		return this.requestEvidence(requestId).cost;
	}

	close(retired = false): void {
		if (this.#tui) this.tui(this.#tui.source, "owner-close");
		if (
			this.#tuiState &&
			(this.#tuiState.pendingUserInputs ||
				this.#tuiState.userInputInFlight ||
				this.#tuiState.compactionQueuedMessages ||
				this.#tuiState.compactionQueueTransfers)
		)
			this.#lost = true;
		if (!retired || this.#nativeState?.activeRun || this.#sessionState?.preflights || this.#wakePending)
			this.#lost = true;
		this.event("owner", "audit-detached");
		this.#closed = true;
	}
}
