import type { AgentSession } from "./agent-session.ts";
import type { ExtensionAPI, ExtensionFactory } from "./extensions/types.ts";
import { hasOriginalClockEvidence } from "./ordinary-clock.ts";
import { createOrdinaryDefinitionPorts, type OrdinarySenseScope } from "./ordinary-definitions.ts";
import { createOrdinaryExecutor } from "./ordinary-executor.ts";
import { assertOrdinaryOwner, type OrdinaryOwnerContext } from "./ordinary-owner-context.ts";
import { createOrdinaryProviderIntegration } from "./ordinary-provider.ts";
import type { consumeOrdinaryPairedInput } from "./ordinary-request-pair.ts";
import type { OrdinaryValidatedSetup, SetupRawRef } from "./ordinary-sc085-setup.ts";
import {
	appendOwnedTerminalEntry,
	persistOwnedTerminalSession,
	type SessionManager,
} from "./session-manager.ts";
import type { OwnedJournalView } from "./session-ownership.ts";

// Structural types for the one deployment-pinned bundle, not package discovery
// or a second implementation of the common registry, runner or request guard.
export interface OrdinaryCapture {
	decisionId: string;
	capturedAt: string;
	frameText: string | null;
	frameHash: string | null;
}
export interface OrdinarySubmission {
	capture: OrdinaryCapture | null;
	kind: "decision" | "auxiliary";
	attempt: number;
	payloadHash: string;
	outcome: "accepted" | "rejected" | "unknown";
	status?: number;
}
export interface OrdinaryProviderOutcome extends OrdinarySubmission {
	providerResponseId: string | null;
	acceptanceBasis: "native-responses-result";
}
export interface OrdinaryExposureFrame {
	protocol: 1;
	scope: OrdinarySenseScope;
	ownerEpoch: string;
	revision: number;
	composedAt: string;
	outcome: "OK" | "FRAME_UNAVAILABLE";
	views: readonly {
		id: string;
		source: string;
		generation: number;
		definitionRevision: string;
		sample: {
			outcome:
				| "OK"
				| "EMPTY"
				| "INITIALIZING"
				| "OVERDUE"
				| "EXIT_NONZERO"
				| "TIMEOUT"
				| "OUTPUT_LIMIT"
				| "INVALID_OUTPUT"
				| "CANCELLED"
				| "UNAVAILABLE";
			body: string;
			fingerprint: string;
			startedAt: string | null;
			completedAt: string | null;
			diagnosticRef?: string;
		};
	}[];
	text: string;
	hash: string;
}
export interface OrdinaryExposureReceipt {
	scope: OrdinarySenseScope;
	ownerEpoch: string;
	requestId: string;
	decisionId: string;
	attemptId: string;
	commitOrder: number;
	frameRevision: number;
	frameHash: string;
	capturedAt: string;
	outcome: "accepted" | "rejected" | "unknown";
	frameOutcome: "OK" | "FRAME_UNAVAILABLE";
	views: readonly { id: string; generation: number; fingerprint: string }[];
}
/** Minimal host view of the original Core. Native code only forwards this handle. */
export interface OrdinaryOperationalCore {
	readonly control: (request: unknown) => Promise<unknown>;
	readonly refresh: () => Promise<void>;
	readonly close: () => Promise<void>;
	readonly observeRefresh: (invoke: () => Promise<void>, signal: AbortSignal) => Promise<unknown>;
}
export type OrdinaryOperationalExecutor = Pick<ReturnType<typeof createOrdinaryExecutor>, "execute">;
export interface OrdinaryOperationalHooks {
	executor(original: OrdinaryOperationalExecutor): OrdinaryOperationalExecutor;
	/** Acquisition before initialization; readiness is only runtime creation completion. */
	opened(core: OrdinaryOperationalCore): void;
	wakeIntention(event: { ownerEpoch: string; pending: boolean }): void;
	/** Original-runtime receiver registration, not a baseline/namespace setter. */
	sc085SetupReceiver?(receive: (event: OrdinaryValidatedSetup) => Promise<SetupRawRef>): void;
}

interface CommonOwner {
	scope: OrdinarySenseScope;
	epoch: string;
	isCurrent(): boolean;
}
interface CommonBridge {
	extension: ExtensionFactory;
	bindSession(session: AgentSession): void;
	canSubmit(): boolean;
	takeCapture(): OrdinaryCapture | null;
	submitted(receipt: OrdinarySubmission | OrdinaryProviderOutcome): void;
	close(): Promise<void>;
}
export interface OrdinarySenseEntry {
	/** Fixed original function reference, not a caller-provided verifier. */
	consumeOrdinaryPairedInput: typeof consumeOrdinaryPairedInput;
	FileDefinitions: new (options: ReturnType<typeof createOrdinaryDefinitionPorts>["options"]) => object;
	selectPiBranch(
		pi: Pick<ExtensionAPI, "appendEntry">,
		context: { sessionManager: SessionManager },
		journal: OwnedJournalView,
		newLineage: boolean,
	): string;
	createOwnedPiSenseExtension(options: {
		operational?: Readonly<OrdinaryOperationalHooks>;
		owner: CommonOwner;
		manager: SessionManager;
		journal: OwnedJournalView;
		core: {
			definitions: object;
			executor: ReturnType<typeof createOrdinaryExecutor>;
			clock: {
				monotonic(): number;
				wallTime(): number;
				setTimeout(callback: () => void, ms: number): unknown;
				clearTimeout(handle: unknown): void;
			};
			budget: { acceptsReservation(bytes: number): boolean; isValid(): boolean };
			admission: { requestWake(owner: CommonOwner, recheck: () => boolean): Promise<"started" | "suppressed"> };
			capabilities: {
				profile: string;
				verification: "unverified";
				execution: "restricted";
				replacement: boolean;
				autonomousWake: boolean;
				limits: OrdinaryOwnerContext["decision"]["record"]["limits"];
			};
			fault(code: string): void;
			wakeIntention?(event: { ownerEpoch: string; pending: boolean }): void;
			exposureTransition?(
				frame: OrdinaryExposureFrame,
				receipt: OrdinaryExposureReceipt,
				transition: () => void,
			): void;
			exposure?(frame: OrdinaryExposureFrame, receipt: OrdinaryExposureReceipt): void;
		};
		canSubmit(): boolean;
		providerAcceptanceQualified(): boolean;
	}): CommonBridge;
	installPiRequestGuard(
		session: AgentSession,
		options: {
			takeCapture(): OrdinaryCapture | null;
			endpoint: string;
			maxRequestBytes: number;
			canSubmit(): boolean;
			fetch: typeof globalThis.fetch;
			onSubmission(receipt: OrdinarySubmission): void;
			providerEvidence: { record(receipt: OrdinaryProviderOutcome): void; failed(): void };
		},
	): () => void;
}

/** Called by the ordinary resource loader, before SDK construction/session_start. */
export function createOrdinarySenseExtension(
	context: OrdinaryOwnerContext,
	entry: OrdinarySenseEntry,
): ExtensionFactory {
	assertOrdinaryOwner(context);
	for (const member of [
		entry.FileDefinitions,
		entry.selectPiBranch,
		entry.createOwnedPiSenseExtension,
		entry.installPiRequestGuard,
	]) {
		if (typeof member !== "function") throw new Error("OWNER_SENSE_ENTRY_CONTRACT");
	}
	const manager = context.owner.manager;
	const journal = context.owner.journalView();
	// No fake ExtensionContext or pre-bind ExtensionAPI action. This is the same
	// original manager used later by the actual ExtensionRunner context.
	const branchId = context.within(() =>
		entry.selectPiBranch(
			{
				appendEntry: (type, data) => {
					context.assertActive();
					manager.appendCustomEntry(type, data);
				},
			},
			{ sessionManager: manager },
			journal,
			false,
		),
	);
	context.assertActive();
	const record = context.decision.record;
	const scope: OrdinarySenseScope = Object.freeze({
		harness: "pi",
		tenantId: record.admission.owner.tenantId,
		principalId: record.admission.owner.principalId,
		sessionId: manager.getSessionId(),
		branchId,
		workspaceDir: manager.getCwd(),
	});
	const owner: CommonOwner = Object.freeze({
		scope,
		epoch: context.owner.grant,
		isCurrent: () => context.isCurrent(),
	});
	const definitions = createOrdinaryDefinitionPorts(context, scope);
	const executor = createOrdinaryExecutor(context, scope, definitions);
	const bridge = context.within(() =>
		entry.createOwnedPiSenseExtension({
			owner,
			manager,
			journal,
			operational: context.operational,
			core: {
				definitions: new entry.FileDefinitions(definitions.options),
				executor,
				clock: context.operationalAudit.clockForCore(),
				budget: {
					isValid: () => context.hasNativeTokenReservation(),
					acceptsReservation: (bytes) => context.acceptsFrameReservation(bytes),
				},
				admission: {
					requestWake: async (candidate, recheck) =>
						candidate === owner ? context.requestWake(recheck) : "suppressed",
				},
				capabilities: {
					profile: record.recipe,
					verification: "unverified",
					execution: "restricted",
					replacement: false,
					autonomousWake: record.admission.allocation.scopeOpen && record.admission.allocation.automatic > 0,
					limits: record.limits,
				},
				fault: () => context.owner.quarantine(),
				wakeIntention: (event) => context.operationalAudit.wakeIntention(event),
				...(hasOriginalClockEvidence()
					? {
							exposureTransition: (
								frame: OrdinaryExposureFrame,
								receipt: OrdinaryExposureReceipt,
								transition: () => void,
							) => context.operationalAudit.exposureTransition(frame, receipt, transition),
						}
					: {}),
				exposure: (frame, receipt) => context.operationalAudit.exposure(frame, receipt),
			},
			canSubmit: () => context.canSubmitNative(),
			providerAcceptanceQualified: () => false,
		}),
	);
	context.assertActive();
	const provider = createOrdinaryProviderIntegration(context, entry, bridge);
	context.installSense({
		owner: context.owner,
		bindSession: (session) => bridge.bindSession(session),
		installProviderGuard: (session) => provider.install(session),
		canSubmit: () => bridge.canSubmit(),
		providerIdle: () => provider.isIdle(),
		joinProvider: () => provider.join(),
		async close() {
			const results = await Promise.allSettled([
				Promise.resolve().then(() => bridge.close()),
				Promise.resolve().then(() => provider.close()),
			]);
			const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length) throw new AggregateError(errors, "OWNER_SENSE_CLOSE_FAILED", { cause: errors[0] });
			const state = await executor.retained();
			await context.owner.terminal(async () => {
				await appendOwnedTerminalEntry(manager, "smarty-sense:ordinary-retention-v1", {
					protocol: 1,
					allocation: record.admission.allocation.id,
					ownerEpoch: context.owner.grant,
					retention: record.admission.retention,
					disposition: "retained",
					snapshots: definitions.retained(),
					state,
				});
				await persistOwnedTerminalSession(manager);
			});
		},
	});
	return bridge.extension;
}
