import { fileURLToPath } from "node:url";
import type { OrdinaryDiagnosticSink } from "./core/ordinary-operational-audit.ts";
import {
	assertOrdinaryOwner,
	OrdinaryOwnerContext,
	receiveOrdinaryOwner as receiveOriginalOwner,
} from "./core/ordinary-owner-context.ts";
import {
	type OrdinaryOperationalResourceInspection,
	type OrdinaryResourceRef,
	recordResourceInspection,
} from "./core/ordinary-resource-inspection.ts";
import type { Sc085OriginalReceiving } from "./core/ordinary-sc085-source/operational-admission.ts";
import { SessionOwnership } from "./core/session-ownership.ts";

export { ordinaryClock, prepareOrdinaryClock, readOrdinaryClockPreparation } from "./core/ordinary-clock.ts";
export type { NativeClockSample, OriginalClockWitness } from "./core/ordinary-clock-evidence.ts";
export { captureOrdinaryRequestPair, consumeOrdinaryPairedInput } from "./core/ordinary-request-pair.ts";
export type { Sc085OriginalReceiving } from "./core/ordinary-sc085-source/operational-admission.ts";
export {
	closeSc085OriginalChild,
	createOperationalAdmission,
	prepareSc085OriginalReceiving,
	qualifySc085BootstrapStamp,
	qualifySc085OriginalStamp,
	receiveSc085BootstrapSelection,
	receiveSc085ChildBinding,
} from "./core/ordinary-sc085-source/operational-admission.ts";
export type {
	OriginalOutsideFinalReceiver,
	OriginalOutsideFinalSelection,
	OriginalOutsideOriginalData,
} from "./core/ordinary-sc085-source/outside-final.ts";
export { createOperationalOutsideFinal } from "./core/ordinary-sc085-source/outside-final.ts";
export type {
	OriginalOutsideClockCoverage,
	OriginalOutsideFinalData,
	OriginalOutsideFinalResult,
	OriginalOutsideGraphSelection,
	OriginalOutsideStagedData,
	OriginalOutsideTerminalSelection,
} from "./core/ordinary-sc085-source/outside-final-data.ts";
export { serveOperationalOutsideFinal } from "./core/ordinary-sc085-source/outside-final-pipe.ts";

// Source classes freeze their prototypes. Resolve them at call time so original
// composition module cycles do not read uninitialized class bindings.

export { assertOrdinaryOwner };
export type { OrdinaryOwnerContext };
export type { OriginalCompactionReceipt } from "./core/ordinary-compaction.ts";
export type { NativeAuditStamp, OrdinaryDiagnosticSink } from "./core/ordinary-operational-audit.ts";
export type { NativeRequestSource } from "./core/ordinary-request-evidence.ts";
export type {
	OrdinaryOperationalResourceInspection,
	OrdinaryResourceRef,
	OriginalResourceProofName,
} from "./core/ordinary-resource-inspection.ts";
export {
	abortOrdinaryExposure,
	beginOrdinaryExposure,
	commitOrdinaryExposure,
	createOrdinaryRuntime,
	deliverOrdinaryExposure,
	receiveOrdinaryOperationalCollector,
	receiveOrdinarySenseComposition,
} from "./core/ordinary-runtime.ts";
export type {
	OrdinaryOperationalCore,
	OrdinaryOperationalExecutor,
	OrdinaryOperationalHooks,
} from "./core/ordinary-sense.ts";

/** This compiled Pi bridge, never the importing Sense host or an arbitrary path.
 * The independently received application record must admit these exact bytes AND
 * the protected package/dependency closure. This export grants no authority. */
export const ordinaryApplicationPath = fileURLToPath(import.meta.url);

/** EFFECTFUL. The host must finish independent artifact/authority preflight first.
 * Failed receiving already joins its partial original native owner/host. */
export function receiveOrdinaryOwner(
	profilePath: string,
	receiving?: Sc085OriginalReceiving,
): Promise<OrdinaryOwnerContext> {
	return receiveOriginalOwner(profilePath, ordinaryApplicationPath, receiving);
}

/** Inert source capability only, before receiving. Does not inspect/create a
 * native host, grant authority or claim installed/native clock qualification. */
export function preflightOrdinarySc085(): Readonly<{
	protocol: "sense-ops-sc085/1";
	validatedSetup: "sense-ops-sc085-validated-setup/1";
}> {
	return Object.freeze({ protocol: "sense-ops-sc085/1", validatedSetup: "sense-ops-sc085-validated-setup/1" });
}

/** Original provider exposes this exact five-method closure only after its
 * B/full-admission checks. The context independently checks its private route. */
export function ordinarySc085(owner: OrdinaryOwnerContext) {
	assertOrdinaryOwner(owner);
	const methods = owner.sc085;
	if (!methods) throw new Error("OWNER_SC085_RECEIVING_REQUIRED");
	return methods;
}

/** Private selected compaction only; not four-method crossing readiness. The
 * original receiving/owner/session, rather than caller callbacks, select the work. */
export async function compactOrdinarySession(
	owner: OrdinaryOwnerContext,
	receiving: Sc085OriginalReceiving,
	signal: AbortSignal,
) {
	assertOrdinaryOwner(owner);
	await OrdinaryOwnerContext.prototype.compactOriginal.call(owner, receiving, signal);
	return OrdinaryOwnerContext.prototype.compactionEvidence.call(owner);
}

/** Failure DATA remains readable after cancellation/retirement; lastRetained can
 * precede the current receipt if a later recorder operation failed. No replay. */
export function readOrdinaryCompactionReceipt(owner: OrdinaryOwnerContext) {
	return OrdinaryOwnerContext.prototype.compactionEvidence.call(owner);
}

/** Current native observations only. Original pre-exec proof is never reconstructed. */
export function inspectOrdinaryOperationalResources(
	original: OrdinaryOwnerContext,
	retainCurrent: (actualNonsecretFacts: unknown) => OrdinaryResourceRef,
): OrdinaryOperationalResourceInspection {
	OrdinaryOwnerContext.prototype.assertActive.call(original);
	return recordResourceInspection(
		{ ownerEpoch: original.owner.grant, allocationId: original.decision.allocation.id },
		() => {
			OrdinaryOwnerContext.prototype.assertActive.call(original);
			return SessionOwnership.prototype.inspectResources.call(original.owner);
		},
		retainCurrent,
	);
}

/** Original native stderr -> host durable recorder, before runtime construction. */
export function bindOrdinaryDiagnosticSink(owner: OrdinaryOwnerContext, sink: OrdinaryDiagnosticSink): void {
	assertOrdinaryOwner(owner);
	owner.operationalAudit.bindDiagnosticSink(sink);
}

/** Concrete source capability for pre-receive module checks. Function presence
 * alone is not artifact admission, native qualification or permission to receive. */
export function captureOrdinaryRequest(
	owner: OrdinaryOwnerContext,
	invoke: () => Promise<unknown>,
): Promise<{ requestId: string }> {
	assertOrdinaryOwner(owner);
	return owner.captureRequest(invoke);
}
