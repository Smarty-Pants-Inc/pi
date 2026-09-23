import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "./agent-session-services.ts";
import { assertOriginalSenseEntry } from "./extensions/loader.ts";
import { hasOriginalClockEvidence, ordinaryClock } from "./ordinary-clock.ts";
import type { OrdinaryOperationalAudit } from "./ordinary-operational-audit.ts";
import {
	assertOrdinaryOwner,
	bindOrdinaryOptions,
	type OrdinaryOwnerContext,
	ordinaryOwnerOf,
} from "./ordinary-owner-context.ts";
import {
	assertOriginalCoreOwner,
	type OrdinaryExposureFrame,
	type OrdinaryExposureReceipt,
	type OrdinaryOperationalHooks,
	type OrdinarySenseEntry,
} from "./ordinary-sense.ts";
import type { TokenSettlement } from "./ordinary-token-budget.ts";

export interface OriginalOperationalCollector {
	request(row: ReturnType<OrdinaryOperationalAudit["requests"]>[number]): void;
	exposure(frame: OrdinaryExposureFrame, receipt: OrdinaryExposureReceipt): void;
	usage(receipt: TokenSettlement): void;
	readonly hooks: Readonly<OrdinaryOperationalHooks>;
}
interface OriginalComposition {
	context: OrdinaryOwnerContext;
	token: object;
	collectorToken?: object;
	collectorPhase: "pending" | "attaching" | "claimed" | "bound";
	collector?: Readonly<OriginalOperationalCollector>;
	factory?: CreateAgentSessionRuntimeFactory;
	coreOwner?: object;
	coreAttached: boolean;
	failure?: { cause: unknown };
	abortedExposure?: { ticket: object; cause: unknown };
}
const compositions = new WeakMap<OrdinaryOwnerContext, OriginalComposition>();
const compositionTokens = new WeakMap<object, OriginalComposition>();
const auditCompositions = new WeakMap<OrdinaryOperationalAudit, OriginalComposition>();
const exposureOwners = new WeakMap<object, OriginalComposition>();

function checkComposition(value: OriginalComposition): void {
	if (value.failure) throw value.failure.cause;
	assertOrdinaryOwner(value.context);
}

/** Only the original runtime can create the pending intent. The installed Sense
 * receiver must call this fixed verifier itself before consulting token members. */
export function receiveOrdinaryOperationalCollector(context: OrdinaryOwnerContext, token: unknown, recorder: unknown) {
	const original = compositions.get(context);
	if (!original || original.collectorPhase !== "attaching" || original.collectorToken !== token)
		throw new Error("OWNER_COLLECTOR_ORIGINAL_INTENT_REQUIRED");
	original.collectorPhase = "claimed";
	checkComposition(original);
	if (context.originalOperationalRecorder() !== recorder)
		throw new Error("OWNER_COLLECTOR_ORIGINAL_RECORDER_REQUIRED");
	return Object.freeze({
		ownerIdentity: context,
		sessionId: context.owner.sessionId,
		ownerEpoch: context.owner.grant,
		allocationId: context.decision.allocation.id,
	});
}

/** Called at the source-owned CommonOwner construction, never a public factory. */
export function attachOrdinarySenseComposition(
	context: OrdinaryOwnerContext,
	entry: OrdinarySenseEntry,
	coreOwner: object,
): object | undefined {
	const original = compositions.get(context);
	if (!original || original.coreOwner) throw new Error("OWNER_SENSE_COMPOSITION_ONCE");
	assertOriginalSenseEntry(context, entry);
	assertOriginalCoreOwner(context, coreOwner);
	checkComposition(original);
	original.coreOwner = coreOwner;
	try {
		if (original.collectorToken) {
			const recorder = context.originalOperationalRecorder();
			original.collectorPhase = "attaching";
			const collector = entry.receiveOriginalOperationalCollector(original.collectorToken, recorder, context);
			if (
				(original.collectorPhase as OriginalComposition["collectorPhase"]) !== "claimed" ||
				!Object.isFrozen(collector) ||
				typeof collector.request !== "function" ||
				typeof collector.exposure !== "function" ||
				typeof collector.usage !== "function"
			)
				throw new Error("OWNER_COLLECTOR_ORIGINAL_RECEIVING_REQUIRED");
			original.collector = collector;
			original.collectorPhase = "bound";
			context.finishOriginalOperationalHooks();
		}
		checkComposition(original);
		return hasOriginalClockEvidence() ? original.token : undefined;
	} catch (cause) {
		original.failure ??= { cause };
		throw original.failure.cause;
	}
}

export function assertOriginalRuntimeFactory(
	context: OrdinaryOwnerContext,
	factory: CreateAgentSessionRuntimeFactory,
): void {
	const original = compositions.get(context);
	if (!original || original.factory !== factory) throw new Error("OWNER_RUNTIME_ORIGINAL_FACTORY_REQUIRED");
	checkComposition(original);
}

export function receivedOrdinaryOperationalHooks(context: OrdinaryOwnerContext): Readonly<OrdinaryOperationalHooks> {
	const original = compositions.get(context);
	if (!original || original.collectorPhase !== "bound" || !original.collector)
		throw new Error("OWNER_COLLECTOR_ORIGINAL_RECEIVING_REQUIRED");
	checkComposition(original);
	return original.collector.hooks;
}

export function originalOperationalCollectorToken(context: OrdinaryOwnerContext): object | undefined {
	const original = compositions.get(context);
	if (!original) throw new Error("OWNER_RUNTIME_COMPOSITION_REQUIRED");
	checkComposition(original);
	return original.collectorToken;
}

export function receiveOrdinarySenseComposition(token: unknown, coreOwner: object, clock: unknown): object {
	const original = token !== null && typeof token === "object" ? compositionTokens.get(token) : undefined;
	if (!original || original.coreOwner !== coreOwner || clock !== ordinaryClock || original.coreAttached)
		throw new Error("OWNER_SENSE_ORIGINAL_COMPOSITION_REQUIRED");
	original.coreAttached = true;
	checkComposition(original);
	if (original.collectorPhase !== "bound") throw new Error("OWNER_SENSE_ORIGINAL_COLLECTOR_REQUIRED");
	const capability = Object.freeze({});
	exposureOwners.set(capability, original);
	return capability;
}

function exposureComposition(capability: object): OriginalComposition {
	const original = exposureOwners.get(capability);
	if (!original) throw new Error("OWNER_EXPOSURE_ORIGINAL_OWNER_REQUIRED");
	checkComposition(original);
	return original;
}

export function assertOrdinaryExposureAudit(owner: object, audit: OrdinaryOperationalAudit): void {
	if (exposureOwners.get(owner)?.context.operationalAudit !== audit)
		throw new Error("OWNER_EXPOSURE_ORIGINAL_AUDIT_REQUIRED");
}

export function beginOrdinaryExposure(
	owner: object,
	frame: OrdinaryExposureFrame,
	receipt: OrdinaryExposureReceipt,
): object {
	return exposureComposition(owner).context.operationalAudit.beginExposure(owner, frame, receipt);
}
export function commitOrdinaryExposure(owner: object, ticket: object): void {
	exposureComposition(owner).context.operationalAudit.commitExposure(owner, ticket);
}
export function deliverOrdinaryExposure(owner: object, ticket: object): void {
	exposureComposition(owner).context.operationalAudit.deliverExposure(owner, ticket);
}
export function abortOrdinaryExposure(owner: object, ticket: object, cause: unknown): never {
	const original = exposureOwners.get(owner);
	if (!original) throw new Error("OWNER_EXPOSURE_ORIGINAL_OWNER_REQUIRED");
	// Foreign, missing, old or already-delivered tickets cannot poison this owner.
	original.context.operationalAudit.assertExposureAbort(owner, ticket);
	if (original.abortedExposure) throw original.abortedExposure.cause;
	const aborted = { ticket, cause: original.failure ? original.failure.cause : cause };
	original.abortedExposure = aborted;
	// Spend cleanup before entering it. Reentry/duplicate abort never quarantines
	// again, even when the first cause is undefined or native cleanup is uncertain.
	try {
		original.context.operationalAudit.abortExposure(owner, ticket, aborted.cause);
	} catch (first) {
		aborted.cause = first;
	}
	original.failure ??= { cause: aborted.cause };
	try {
		original.context.owner.quarantine();
	} catch (cleanup) {
		aborted.cause = new AggregateError([aborted.cause, cleanup], "OWNER_EXPOSURE_QUARANTINE_FAILED", {
			cause: aborted.cause,
		});
	}
	throw aborted.cause;
}

/** Collector operations have no caller registration route. The only installed
 * methods come from the same authenticated Sense receiver during attachment. */
export function publishOrdinaryRequest(
	audit: OrdinaryOperationalAudit,
	row: ReturnType<OrdinaryOperationalAudit["requests"]>[number],
): void {
	const original = auditCompositions.get(audit);
	if (!original) return;
	checkComposition(original);
	original.collector?.request(row);
}
export function publishOrdinaryExposure(
	audit: OrdinaryOperationalAudit,
	frame: OrdinaryExposureFrame,
	receipt: OrdinaryExposureReceipt,
): void {
	const original = auditCompositions.get(audit);
	if (!original) return;
	checkComposition(original);
	original.collector?.exposure(frame, receipt);
}
export function publishOrdinaryUsage(context: OrdinaryOwnerContext, receipt: TokenSettlement): void {
	const original = compositions.get(context);
	if (!original) return;
	checkComposition(original);
	original.collector?.usage(receipt);
}

export type {
	OrdinaryOperationalCore,
	OrdinaryOperationalExecutor,
	OrdinaryOperationalHooks,
} from "./ordinary-sense.ts";

/** The real ordinary factory closes over the received original owner. It never
 * obtains authority from the mutable current session or a replacement target. */
export async function createOrdinaryRuntime(
	owner: OrdinaryOwnerContext,
	agentDir: string,
	operational?: unknown,
	collectorToken?: object,
): Promise<AgentSessionRuntime> {
	if (operational !== undefined) throw new Error("OWNER_OPERATIONAL_CALLBACKS_UNSUPPORTED");
	assertOrdinaryOwner(owner);
	const original = owner.owner;
	try {
		if (compositions.has(owner)) throw new Error("OWNER_RUNTIME_COMPOSITION_ONCE");
		if (
			(collectorToken !== undefined && (collectorToken === null || typeof collectorToken !== "object")) ||
			(hasOriginalClockEvidence() && collectorToken === undefined)
		)
			throw new Error("OWNER_RUNTIME_COLLECTOR_REQUIRED");
		const token = Object.freeze({});
		const composition: OriginalComposition = {
			context: owner,
			token,
			collectorToken,
			collectorPhase: "pending",
			coreAttached: false,
		};
		compositions.set(owner, composition);
		compositionTokens.set(token, composition);
		auditCompositions.set(owner.operationalAudit, composition);
		const originalFactory: CreateAgentSessionRuntimeFactory = async (target) => {
			owner.assertActive();
			if (
				ordinaryOwnerOf(target) !== owner ||
				target.sessionManager !== original.manager ||
				target.cwd !== original.manager.getCwd() ||
				target.agentDir !== agentDir
			)
				throw new Error("OWNER_RUNTIME_OWNERSHIP");
			const services = await original.within(() =>
				createAgentSessionServices(
					bindOrdinaryOptions(
						{
							cwd: target.cwd,
							agentDir,
						},
						owner,
					),
				),
			);
			owner.assertActive();
			const allowed = owner.decision.record.provider;
			const model = services.modelRuntime.getModel(allowed.provider, allowed.model);
			if (!model || model.api !== allowed.api) throw new Error("OWNER_MODEL_UNAVAILABLE");
			const created = await original.within(() =>
				createAgentSessionFromServices(
					bindOrdinaryOptions(
						{
							services,
							sessionManager: original.manager,
							model,
							tools: ["read", "write", "edit", "sense"],
							sessionStartEvent: target.sessionStartEvent,
						},
						owner,
					),
				),
			);
			owner.assertActive();
			return { ...created, services, diagnostics: services.diagnostics };
		};
		composition.factory = originalFactory;
		const createRuntime = owner.bindFactory(originalFactory);
		return await createAgentSessionRuntime(
			createRuntime,
			bindOrdinaryOptions(
				{
					cwd: original.manager.getCwd(),
					agentDir,
					sessionManager: original.manager,
				},
				owner,
			),
		);
	} catch (error) {
		const composition = compositions.get(owner);
		if (composition) composition.failure ??= { cause: error };
		try {
			await owner.close();
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "OWNER_RUNTIME_CREATION_FAILED");
		}
		throw error;
	}
}
