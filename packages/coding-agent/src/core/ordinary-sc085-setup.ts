import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OrdinaryExecutionRequest, OrdinaryExecutionResult } from "./ordinary-executor.ts";
import type { NativeAuditStamp } from "./ordinary-operational-audit.ts";
import type { OrdinaryExposureFrame, OrdinaryExposureReceipt, OrdinaryProviderOutcome } from "./ordinary-sense.ts";

export interface SetupRawRef {
	path: string;
	sha256: string;
}
export interface OrdinaryRefreshSettlement {
	refreshId: string;
	ownerEpoch: string;
	samples: {
		executionId: string;
		watchId: string;
		generation: number;
		request: { executionKey: string; stateNamespace: string; sampleTime: string; deadline: string };
		result: OrdinaryExecutionResult;
	}[];
	publication: { revision: number; hash: string };
}
export interface OrdinaryValidatedSetup {
	protocol: "sense-ops-sc085-validated-setup/1";
	owner: { ownerEpoch: string; sessionId: string; allocationId: string };
	setup: {
		id: string;
		index: -1;
		sample: SetupRawRef;
		publication: SetupRawRef;
		settlement: OrdinaryRefreshSettlement;
	};
	baseline: {
		decisionId: string;
		frameHash: string;
		finalRequest: SetupRawRef;
		coreExposure: SetupRawRef;
		native: OrdinaryProviderOutcome;
	};
}
export type OrdinaryObservedRefresh = Omit<OrdinaryValidatedSetup["setup"], "index"> & { index: number };
export interface OriginalSetupRequest {
	requestId: string;
	native: OrdinaryProviderOutcome;
	finalBytes: Uint8Array;
	exposure: { frame: OrdinaryExposureFrame; receipt: OrdinaryExposureReceipt; at: NativeAuditStamp };
}
interface Execution {
	watchId: string;
	generation: number;
	execution: OrdinaryExecutionRequest["execution"];
	input: OrdinaryExecutionRequest["input"];
	request: OrdinaryRefreshSettlement["samples"][number]["request"];
	result?: OrdinaryExecutionResult;
}

/** Private evidence association only. Neither this type nor a matching event
 * supplies admission. The original executor populates records BEFORE effects. */
export class OrdinarySc085Setup {
	readonly #owner: OrdinaryValidatedSetup["owner"];
	readonly #maxBytes: number;
	readonly #executions: Execution[] = [];
	readonly #seen = new WeakSet<OrdinaryExecutionRequest>();
	#bytes = 0;
	#lost = false;
	#used = false;
	#joined?: { raw: SetupRawRef; event: OrdinaryValidatedSetup; originalRequestId: string };
	#latest?: Execution;

	constructor(owner: OrdinaryValidatedSetup["owner"], maxBytes: number) {
		this.#owner = Object.freeze({ ...owner });
		this.#maxBytes = maxBytes;
	}

	/** Called after original native request validation, before process/state effects.
	 * Unsupported legacy requests lose setup evidence, not ordinary execution. */
	begin(original: OrdinaryExecutionRequest): (result: OrdinaryExecutionResult) => void {
		if (this.#lost || (this.#used && !this.#joined)) return () => {};
		const afterSetup = this.#used;
		const request = {
			executionKey: original.executionKey,
			stateNamespace: original.stateNamespace,
			sampleTime: original.sampleTime,
			deadline: original.deadline,
		};
		const { watchId, generation } = original.scope;
		if (
			this.#seen.has(original) ||
			original.ownerEpoch !== this.#owner.ownerEpoch ||
			original.scope.sessionId !== this.#owner.sessionId ||
			typeof request.executionKey !== "string" ||
			!request.executionKey ||
			!watchId ||
			!Number.isSafeInteger(generation) ||
			generation === undefined ||
			generation < 1 ||
			(!afterSetup && this.#executions.length >= 64)
		) {
			this.#lost = true;
			return () => {};
		}
		this.#seen.add(original);
		const captured: Execution = {
			watchId,
			generation,
			execution: structuredClone(original.execution),
			input: structuredClone(original.input),
			request: { ...request, executionKey: request.executionKey },
		};
		const capturedBytes = Buffer.byteLength(JSON.stringify(captured));
		if (!afterSetup) this.#bytes += capturedBytes;
		if (capturedBytes > this.#maxBytes || this.#bytes > this.#maxBytes) {
			this.#lost = true;
			return () => {};
		}
		if (!afterSetup) this.#executions.push(captured);
		return (result) => {
			if (this.#lost || (this.#used && !afterSetup)) return;
			if (captured.result) {
				this.#lost = true;
				return;
			}
			const copy = structuredClone(result),
				resultBytes = Buffer.byteLength(JSON.stringify(copy));
			if (!afterSetup) this.#bytes += resultBytes;
			if (capturedBytes + resultBytes > this.#maxBytes || this.#bytes > this.#maxBytes) {
				this.#lost = true;
				return;
			}
			captured.result = copy;
			// Core's checkpoint drains older work. Retain its latest completed
			// original execution, not all 1000 refreshes or event-supplied facts.
			if (afterSetup) this.#latest = captured;
		};
	}

	/** Only the registered original-runtime receiver calls this with its original
	 * retained custody/recorder. No namespace or executor facts are set from event. */
	receive(
		event: OrdinaryValidatedSetup,
		original: OriginalSetupRequest,
		retained: ReadonlyMap<string, Uint8Array>,
		record: (value: unknown) => SetupRawRef,
		checkCurrent: () => void,
	): SetupRawRef {
		assert(!this.#used && !this.#lost, "OWNER_SC085_SETUP_UNAVAILABLE");
		this.#used = true;
		checkCurrent();
		const selected = structuredClone(event);
		const exact = (value: object, names: string[]) => {
			assert(isDeepStrictEqual(Object.keys(value).sort(), names.sort()), "OWNER_SC085_SETUP_KEYS");
		};
		exact(selected, ["protocol", "owner", "setup", "baseline"]);
		exact(selected.owner, ["ownerEpoch", "sessionId", "allocationId"]);
		exact(selected.setup, ["id", "index", "sample", "publication", "settlement"]);
		exact(selected.baseline, ["decisionId", "frameHash", "finalRequest", "coreExposure", "native"]);
		exact(selected.setup.settlement, ["refreshId", "ownerEpoch", "samples", "publication"]);
		exact(selected.setup.settlement.publication, ["revision", "hash"]);
		const bytes = (ref: SetupRawRef) => {
			exact(ref, ["path", "sha256"]);
			assert(
				ref &&
					typeof ref.path === "string" &&
					ref.path &&
					typeof ref.sha256 === "string" &&
					/^[a-f0-9]{64}$/.test(ref.sha256),
				"OWNER_SC085_SETUP_REF",
			);
			const value = retained.get(ref.path);
			assert(value && createHash("sha256").update(value).digest("hex") === ref.sha256, "OWNER_SC085_SETUP_RETAINED");
			return Uint8Array.from(value);
		};
		const json = (ref: SetupRawRef): unknown =>
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(ref)));
		const { setup, baseline } = selected;
		const { settlement } = setup;
		assert(
			selected.protocol === "sense-ops-sc085-validated-setup/1" &&
				isDeepStrictEqual(selected.owner, this.#owner) &&
				setup.index === -1 &&
				setup.id &&
				setup.id === settlement.refreshId &&
				settlement.ownerEpoch === this.#owner.ownerEpoch,
			"OWNER_SC085_SETUP_IDENTITY",
		);
		assert(
			isDeepStrictEqual(json(setup.sample), {
				kind: "ops-refresh-samples",
				refreshId: setup.id,
				ownerEpoch: this.#owner.ownerEpoch,
				samples: settlement.samples,
			}),
			"OWNER_SC085_SETUP_SAMPLES",
		);
		assert(
			isDeepStrictEqual(json(setup.publication), {
				kind: "ops-refresh-publication",
				refreshId: setup.id,
				ownerEpoch: this.#owner.ownerEpoch,
				...settlement.publication,
			}),
			"OWNER_SC085_SETUP_PUBLICATION",
		);
		assert(
			isDeepStrictEqual(baseline.native, original.native) &&
				baseline.decisionId === original.native.capture?.decisionId &&
				baseline.frameHash === original.native.capture?.frameHash &&
				original.native.kind === "decision" &&
				original.native.outcome === "accepted" &&
				original.native.providerResponseId &&
				original.native.acceptanceBasis === "native-responses-result",
			"OWNER_SC085_SETUP_BASELINE",
		);
		assert(isDeepStrictEqual(bytes(baseline.finalRequest), original.finalBytes), "OWNER_SC085_SETUP_REQUEST_BYTES");
		const { frame, receipt } = original.exposure;
		assert(
			isDeepStrictEqual(json(baseline.coreExposure), { kind: "ops-common-exposure", frame, receipt }),
			"OWNER_SC085_SETUP_EXPOSURE",
		);
		assert(
			frame.ownerEpoch === this.#owner.ownerEpoch &&
				receipt.ownerEpoch === this.#owner.ownerEpoch &&
				frame.scope.sessionId === this.#owner.sessionId &&
				receipt.scope.sessionId === this.#owner.sessionId &&
				frame.hash === baseline.frameHash &&
				frame.hash === settlement.publication.hash &&
				frame.revision === settlement.publication.revision &&
				frame.revision === receipt.frameRevision &&
				receipt.frameHash === frame.hash &&
				receipt.outcome === "accepted" &&
				frame.outcome === "OK" &&
				receipt.decisionId === baseline.decisionId &&
				receipt.attemptId === `${baseline.decisionId}:${baseline.native.attempt}`,
			"OWNER_SC085_SETUP_EXPOSURE_JOIN",
		);
		assert(
			settlement.samples.length === 1 && frame.views.length === 1 && receipt.views.length === 1,
			"OWNER_SC085_SETUP_COHORT",
		);
		const sample = settlement.samples[0];
		exact(sample, ["executionId", "watchId", "generation", "request", "result"]);
		exact(sample.request, ["executionKey", "stateNamespace", "sampleTime", "deadline"]);
		assert(typeof sample.executionId === "string" && sample.executionId, "OWNER_SC085_SETUP_EXECUTION_ID");
		const matches = this.#executions.filter(
			(execution) =>
				execution.watchId === sample.watchId &&
				execution.generation === sample.generation &&
				isDeepStrictEqual(execution.request, sample.request) &&
				execution.result &&
				isDeepStrictEqual(execution.result, sample.result),
		);
		assert(matches.length === 1, "OWNER_SC085_SETUP_ORIGINAL_EXECUTION");
		const view = frame.views[0],
			exposed = receipt.views[0];
		assert(
			view.id === sample.watchId &&
				view.generation === sample.generation &&
				view.source === matches[0].execution.source &&
				view.definitionRevision === matches[0].execution.revision &&
				exposed.id === view.id &&
				exposed.generation === view.generation &&
				exposed.fingerprint === view.sample.fingerprint &&
				view.sample.outcome === sample.result.outcome &&
				view.sample.body === sample.result.body &&
				view.sample.startedAt === sample.result.startedAt &&
				view.sample.completedAt === sample.result.completedAt &&
				view.sample.diagnosticRef === sample.result.diagnosticRef,
			"OWNER_SC085_SETUP_RESULT_EXPOSURE",
		);
		checkCurrent();
		const receiptValue = {
			kind: "ordinary-sc085-validated-setup/1",
			owner: this.#owner,
			event: selected,
			originalRequestId: original.requestId,
			originalExecution: structuredClone(matches[0]),
			coreExecutionId: sample.executionId,
			executionIdBasis: "core-refresh-correlation-not-native-authority",
			originalExposure: structuredClone(original.exposure),
		};
		const raw = structuredClone(record(structuredClone(receiptValue)));
		assert(isDeepStrictEqual(json(raw), receiptValue), "OWNER_SC085_SETUP_RECORDED");
		checkCurrent();
		this.#joined = { raw, event: selected, originalRequestId: original.requestId };
		return { ...raw };
	}

	checkpoint(value: OrdinaryObservedRefresh, retained: ReadonlyMap<string, Uint8Array>) {
		assert(this.#joined && this.#latest?.result && !this.#lost, "OWNER_SC085_CHECKPOINT_UNAVAILABLE");
		const event = structuredClone(value),
			settlement = event.settlement;
		assert(
			isDeepStrictEqual(Object.keys(event).sort(), ["id", "index", "publication", "sample", "settlement"]) &&
				isDeepStrictEqual(Object.keys(settlement).sort(), ["ownerEpoch", "publication", "refreshId", "samples"]) &&
				isDeepStrictEqual(Object.keys(settlement.publication).sort(), ["hash", "revision"]) &&
				Number.isSafeInteger(settlement.publication.revision) &&
				settlement.publication.revision >= 0 &&
				/^[a-f0-9]{64}$/.test(settlement.publication.hash),
			"OWNER_SC085_CHECKPOINT_FIELDS",
		);
		assert(
			event.index === 1000 &&
				event.id === settlement.refreshId &&
				settlement.ownerEpoch === this.#owner.ownerEpoch &&
				settlement.samples.length === 1,
			"OWNER_SC085_CHECKPOINT_IDENTITY",
		);
		for (const [ref, expected] of [
			[
				event.sample,
				{
					kind: "ops-refresh-samples",
					refreshId: event.id,
					ownerEpoch: this.#owner.ownerEpoch,
					samples: settlement.samples,
				},
			],
			[
				event.publication,
				{
					kind: "ops-refresh-publication",
					refreshId: event.id,
					ownerEpoch: this.#owner.ownerEpoch,
					...settlement.publication,
				},
			],
		] as const) {
			assert(isDeepStrictEqual(Object.keys(ref).sort(), ["path", "sha256"]), "OWNER_SC085_CHECKPOINT_REF");
			const bytes = retained.get(ref.path);
			assert(
				bytes &&
					bytes.length <= this.#maxBytes &&
					createHash("sha256").update(bytes).digest("hex") === ref.sha256 &&
					isDeepStrictEqual(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), expected),
				"OWNER_SC085_CHECKPOINT_RETAINED",
			);
		}
		const sample = settlement.samples[0],
			setup = this.#joined.event.setup.settlement.samples[0],
			original = this.#latest;
		assert(
			isDeepStrictEqual(Object.keys(sample).sort(), ["executionId", "generation", "request", "result", "watchId"]) &&
				typeof sample.executionId === "string" &&
				sample.executionId.length > 0,
			"OWNER_SC085_CHECKPOINT_SAMPLE",
		);
		const baseline = this.#executions.find(
			(execution) =>
				execution.watchId === setup.watchId &&
				execution.generation === setup.generation &&
				isDeepStrictEqual(execution.request, setup.request) &&
				isDeepStrictEqual(execution.result, setup.result),
		);
		assert(
			baseline &&
				isDeepStrictEqual(original.execution, baseline.execution) &&
				isDeepStrictEqual(original.input, baseline.input),
			"OWNER_SC085_CHECKPOINT_DEFINITION_CHANGED",
		);
		assert(
			sample.watchId === setup.watchId &&
				sample.generation === setup.generation &&
				sample.request.executionKey === setup.request.executionKey &&
				sample.request.stateNamespace === setup.request.stateNamespace &&
				sample.watchId === original.watchId &&
				sample.generation === original.generation &&
				isDeepStrictEqual(sample.request, original.request) &&
				isDeepStrictEqual(sample.result, original.result),
			"OWNER_SC085_CHECKPOINT_ORIGINAL_EXECUTION",
		);
		return event;
	}

	baseline() {
		assert(this.#joined && !this.#lost, "OWNER_SC085_SETUP_UNAVAILABLE");
		return structuredClone(this.#joined);
	}
}
