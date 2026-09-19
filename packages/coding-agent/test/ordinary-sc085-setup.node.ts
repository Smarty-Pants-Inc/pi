import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { OrdinaryExecutionRequest, OrdinaryExecutionResult } from "../src/core/ordinary-executor.ts";
import { OrdinaryOperationalAudit } from "../src/core/ordinary-operational-audit.ts";
import type { OrdinaryValidatedSetup, SetupRawRef } from "../src/core/ordinary-sc085-setup.ts";
import type {
	OrdinaryExposureFrame,
	OrdinaryExposureReceipt,
	OrdinaryProviderOutcome,
} from "../src/core/ordinary-sense.ts";
import type { TokenReservation } from "../src/core/ordinary-token-budget.ts";

// Synthetic custody fixtures only, not original native execution or authority.
function fixture(
	options: {
		complete?: boolean;
		duplicateExecution?: boolean;
		key?: boolean;
		cohort?: boolean;
		register?: (audit: OrdinaryOperationalAudit) => void;
	} = {},
) {
	const owner = { ownerEpoch: "owner", sessionId: "session", allocationId: "allocation" };
	const scope = {
		harness: "pi" as const,
		tenantId: "tenant",
		principalId: "principal",
		sessionId: "session",
		branchId: "branch",
		workspaceDir: "/workspace",
	};
	const audit = new OrdinaryOperationalAudit(owner, 64, 65536, {
		profileSha256: "a",
		recipe: "test",
		packageSha256: "b",
		applicationSha256: "c",
		senseSha256: "d",
		provider: "test",
		model: "test",
		api: "test",
		baseUrl: "https://synthetic.invalid",
	});
	options.register?.(audit);
	const request: OrdinaryExecutionRequest = {
		ownerEpoch: owner.ownerEpoch,
		scope: { ...scope, watchId: "watch", generation: 7 },
		execution: {
			source: "build-status",
			revision: "revision",
			policyId: "policy",
			runtimeId: "bun",
			snapshotDir: "/snapshot",
			run: ["bun", "observe.ts"],
		},
		...(options.key === false ? {} : { executionKey: "original-core-key" }),
		stateNamespace: "original-setup-namespace",
		input: {},
		sampleTime: "original-sample",
		deadline: "original-deadline",
		signal: new AbortController().signal,
		limits: {
			minEveryMs: 1,
			maxEveryMs: 100,
			timeoutMs: 100,
			maxConcurrent: 1,
			maxWatches: 1,
			maxBodyBytes: 100,
			maxStderrBytes: 100,
			maxInputBytes: 100,
			frameBudgetBytes: 100,
			wakeCooldownMs: 1,
		},
	};
	const requests = [request];
	if (options.cohort) {
		for (let i = 1; i <= 7; i++)
			requests.push({
				...request,
				scope: { ...request.scope, watchId: `ops-passive-${i}` },
				executionKey: `peer-key-${i}`,
				stateNamespace: `peer-namespace-${i}`,
			});
		request.scope.watchId = "ops-primary";
		requests.reverse(); // Primary deliberately LAST; no positional authority.
	}
	const result: OrdinaryExecutionResult = {
		outcome: "OK",
		body: "baseline",
		startedAt: "original-start",
		completedAt: "original-end",
	};
	const finish = audit.beginSetupExecution(request);
	if (options.complete !== false) finish(result);
	if (options.duplicateExecution) audit.beginSetupExecution({ ...request })(result);
	for (const peer of requests) if (peer !== request) audit.beginSetupExecution(peer)(result);
	const text = "original baseline frame";
	const frameHash = createHash("sha256").update(text).digest("hex");
	const finalBytes = new TextEncoder().encode(
		JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text }] }] }),
	);
	const reservation: TokenReservation = {
		scope: {
			...owner,
			decisionDigest: "a",
			provider: "test",
			model: "test",
			contextTokens: 100,
			outputTokens: 10,
			attempts: 1,
			notBeforeMs: 0,
			expiresMs: 100,
		},
		requestId: "native-baseline",
		payloadHash: createHash("sha256").update(finalBytes).digest("hex"),
		reservedTokens: 100,
	};
	const capture = { decisionId: "baseline-decision", capturedAt: "original", frameText: text, frameHash };
	const native: OrdinaryProviderOutcome = {
		capture,
		kind: "decision",
		attempt: 1,
		payloadHash: reservation.payloadHash,
		outcome: "accepted",
		providerResponseId: "response",
		acceptanceBasis: "native-responses-result",
	};
	const frame: OrdinaryExposureFrame = {
		protocol: 1,
		scope,
		ownerEpoch: "owner",
		revision: 3,
		composedAt: "original",
		outcome: "OK",
		text,
		hash: frameHash,
		views: [
			{
				id: "watch",
				source: "build-status",
				generation: 7,
				definitionRevision: "revision",
				sample: { ...result, fingerprint: "original-fingerprint" },
			},
		],
	};
	const exposure: OrdinaryExposureReceipt = {
		scope,
		ownerEpoch: "owner",
		requestId: "common-baseline",
		decisionId: capture.decisionId,
		attemptId: `${capture.decisionId}:1`,
		commitOrder: 1,
		frameRevision: 3,
		frameHash,
		capturedAt: "original",
		outcome: "accepted",
		frameOutcome: "OK",
		views: [{ id: "watch", generation: 7, fingerprint: "original-fingerprint" }],
	};
	frame.views = requests.map((peer) => ({ ...frame.views[0], id: peer.scope.watchId! }));
	exposure.views = requests.map((peer) => ({ ...exposure.views[0], id: peer.scope.watchId! }));
	audit.capture(capture);
	audit.request(reservation, finalBytes);
	audit.dispatch(reservation);
	audit.exposure(frame, exposure);
	audit.outcome(native);
	audit.settlement({
		reservation,
		responseId: "response",
		streamEnded: true,
		terminal: "completed",
		usage: null,
		disposition: "unknown",
	});
	audit.retired(reservation);
	const retained = new Map<string, Uint8Array>();
	let id = 0;
	const store = (bytes: Uint8Array): SetupRawRef => {
		const ref = { path: `fixture-${++id}`, sha256: createHash("sha256").update(bytes).digest("hex") };
		retained.set(ref.path, Uint8Array.from(bytes));
		return ref;
	};
	const record = (value: unknown) => store(new TextEncoder().encode(JSON.stringify(value)));
	const settlement = {
		refreshId: "setup-refresh",
		ownerEpoch: "owner",
		samples: [
			{
				executionId: "core-execution-id",
				watchId: "watch",
				generation: 7,
				request: {
					executionKey: "original-core-key",
					stateNamespace: request.stateNamespace,
					sampleTime: request.sampleTime,
					deadline: request.deadline,
				},
				result: { ...result },
			},
		],
		publication: { revision: 3, hash: frameHash },
	};
	settlement.samples = requests.map((peer, index) => ({
		...settlement.samples[0],
		watchId: peer.scope.watchId!,
		executionId: `core-execution-${index}`,
		request: {
			executionKey: peer.executionKey!,
			stateNamespace: peer.stateNamespace,
			sampleTime: peer.sampleTime,
			deadline: peer.deadline,
		},
	}));
	const event: OrdinaryValidatedSetup = {
		protocol: "sense-ops-sc085-validated-setup/1",
		owner,
		setup: {
			id: "setup-refresh",
			index: -1,
			settlement,
			sample: record({
				kind: "ops-refresh-samples",
				refreshId: "setup-refresh",
				ownerEpoch: "owner",
				samples: settlement.samples,
			}),
			publication: record({
				kind: "ops-refresh-publication",
				refreshId: "setup-refresh",
				ownerEpoch: "owner",
				...settlement.publication,
			}),
		},
		baseline: {
			decisionId: capture.decisionId,
			frameHash,
			native: structuredClone(native),
			finalRequest: store(finalBytes),
			coreExposure: record({ kind: "ops-common-exposure", frame, receipt: exposure }),
		},
	};
	return { audit, event, retained, record, request, requests, result };
}

test("baseline joins retained original executor/result and accepted request/exposure, not final checkpoint", () => {
	const f = fixture();
	// Mutating the caller's old request/result after capture cannot rewrite originals.
	f.request.stateNamespace = "mutated";
	f.result.body = "mutated";
	const raw = f.audit.receiveValidatedSetup(f.event, f.retained, f.record, () => {});
	assert(f.retained.has(raw.path));
	const joined = f.audit.validatedSetup();
	assert.equal(joined.originalRequestId, "native-baseline");
	assert.equal(joined.event.setup.settlement.samples[0].request.stateNamespace, "original-setup-namespace");
	joined.event.setup.settlement.samples[0].request.stateNamespace = "caller-mutation";
	assert.equal(
		f.audit.validatedSetup().event.setup.settlement.samples[0].request.stateNamespace,
		"original-setup-namespace",
	);
	assert.throws(() => f.audit.receiveValidatedSetup(f.event, f.retained, f.record, () => {}), /DUPLICATE/);
});

for (const field of ["executionKey", "stateNamespace", "sampleTime", "deadline"] as const) {
	test(`rehashing a notification cannot replace original execution ${field}`, () => {
		const f = fixture();
		f.event.setup.settlement.samples[0].request[field] = "forged";
		f.event.setup.sample = f.record({
			kind: "ops-refresh-samples",
			refreshId: f.event.setup.id,
			ownerEpoch: "owner",
			samples: f.event.setup.settlement.samples,
		});
		assert.throws(() => f.audit.receiveValidatedSetup(f.event, f.retained, f.record, () => {}), /ORIGINAL_EXECUTION/);
		assert.throws(() => f.audit.validatedSetup(), /UNAVAILABLE/);
	});
}

test("missing completion, ambiguous execution and absent native Core key never qualify", () => {
	for (const options of [{ complete: false }, { duplicateExecution: true }, { key: false }]) {
		const f = fixture(options);
		assert.throws(
			() => f.audit.receiveValidatedSetup(f.event, f.retained, f.record, () => {}),
			/ORIGINAL_EXECUTION|UNAVAILABLE/,
		);
	}
});

test("changed publication, foreign native receipt and final-checkpoint rebinding refuse", () => {
	const publication = fixture();
	publication.event.setup.settlement.publication.revision++;
	publication.event.setup.publication = publication.record({
		kind: "ops-refresh-publication",
		refreshId: publication.event.setup.id,
		ownerEpoch: "owner",
		...publication.event.setup.settlement.publication,
	});
	assert.throws(
		() =>
			publication.audit.receiveValidatedSetup(publication.event, publication.retained, publication.record, () => {}),
		/EXPOSURE_JOIN/,
	);
	const foreign = fixture();
	foreign.event.baseline.native.providerResponseId = "foreign";
	assert.throws(
		() => foreign.audit.receiveValidatedSetup(foreign.event, foreign.retained, foreign.record, () => {}),
		/ORIGINAL_REQUEST/,
	);
	assert.throws(
		() => foreign.audit.receiveValidatedSetup(foreign.event, foreign.retained, foreign.record, () => {}),
		/DUPLICATE/,
	);
	const final = fixture();
	Object.assign(final.event.setup, { index: 1000 });
	assert.throws(
		() => final.audit.receiveValidatedSetup(final.event, final.retained, final.record, () => {}),
		/IDENTITY/,
	);
});

test("exact setup keys and recorder mutation cannot redefine the retained baseline", () => {
	const extra = fixture();
	Object.assign(extra.event.setup.settlement.samples[0].request, { extraNamespace: "forged" });
	extra.event.setup.sample = extra.record({
		kind: "ops-refresh-samples",
		refreshId: extra.event.setup.id,
		ownerEpoch: "owner",
		samples: extra.event.setup.settlement.samples,
	});
	assert.throws(() => extra.audit.receiveValidatedSetup(extra.event, extra.retained, extra.record, () => {}), /KEYS/);
	const mutated = fixture();
	assert.throws(
		() =>
			mutated.audit.receiveValidatedSetup(
				mutated.event,
				mutated.retained,
				(value) => {
					assert(value && typeof value === "object");
					Object.assign(value, { originalRequestId: "forged" });
					return mutated.record(value);
				},
				() => {},
			),
		/RECORDED/,
	);
	assert.throws(() => mutated.audit.validatedSetup(), /UNAVAILABLE/);
});

test("request and exposure selectors resolve retained samples without mutating their uncertainty", () => {
	const f = fixture();
	f.audit.clockForCore();
	const requestId = "native-baseline";
	for (const phase of ["prepared", "dispatch", "settled", "retired"] as const) {
		const selected = f.audit.resolveSc085Stamp({ kind: "request", requestId, phase });
		assert.deepEqual(selected.stamp, f.audit.requestEvidence(requestId).requestTimes[phase]);
		assert.equal(selected.stamp.uncertaintyMs, null);
		selected.stamp.clockId = "foreign";
		assert.equal(
			f.audit.resolveSc085Stamp({ kind: "request", requestId, phase }).stamp.clockId,
			f.audit.clockIdentity.id,
		);
	}
	assert.deepEqual(
		f.audit.resolveSc085Stamp({ kind: "exposure", requestId }).stamp,
		f.audit.requestExposure(requestId).at,
	);
});

test("final checkpoint requires latest original completion and preserves setup namespace", () => {
	const f = fixture();
	f.audit.receiveValidatedSetup(f.event, f.retained, f.record, () => {});
	const request = { ...f.request, sampleTime: "final-time", deadline: "final-deadline" };
	const result = { ...f.result, body: "final-body", completedAt: "final-end" };
	// The post-baseline capture remains bounded to the latest original completion.
	for (let index = 0; index < 1000; index++) f.audit.beginSetupExecution({ ...request })(result);
	const settlement = structuredClone(f.event.setup.settlement);
	settlement.refreshId = "final-refresh";
	settlement.samples[0].request.sampleTime = request.sampleTime;
	settlement.samples[0].request.deadline = request.deadline;
	settlement.samples[0].result = result;
	const value = {
		id: settlement.refreshId,
		index: 1000,
		settlement,
		sample: f.record({
			kind: "ops-refresh-samples",
			refreshId: settlement.refreshId,
			ownerEpoch: "owner",
			samples: settlement.samples,
		}),
		publication: f.record({
			kind: "ops-refresh-publication",
			refreshId: settlement.refreshId,
			ownerEpoch: "owner",
			...settlement.publication,
		}),
	};
	assert.deepEqual(f.audit.validateSc085Checkpoint(value, f.retained), value);
	assert.throws(() => f.audit.validateSc085Checkpoint({ ...value, index: 999 }, f.retained), /IDENTITY/);
	assert.throws(
		() => f.audit.validateSc085Checkpoint(Object.assign({}, value, { namespace: "forged" }), f.retained),
		/FIELDS/,
	);
	f.audit.beginSetupExecution({ ...request, execution: { ...request.execution, revision: "foreign-revision" } })(
		result,
	);
	assert.throws(() => f.audit.validateSc085Checkpoint(value, f.retained), /DEFINITION_CHANGED/);
	f.audit.beginSetupExecution({ ...request, input: { foreign: true } })(result);
	assert.throws(() => f.audit.validateSc085Checkpoint(value, f.retained), /DEFINITION_CHANGED/);
	f.audit.beginSetupExecution({ ...request, sampleTime: "later" })({ ...result, body: "later" });
	assert.throws(() => f.audit.validateSc085Checkpoint(value, f.retained), /ORIGINAL_EXECUTION/);
});

test("recorder failure, wrong retained bytes and owner loss cannot produce a baseline", () => {
	const failed = fixture();
	const cause = new Error("original recorder failed");
	assert.throws(
		() =>
			failed.audit.receiveValidatedSetup(
				failed.event,
				failed.retained,
				() => {
					throw cause;
				},
				() => {},
			),
		(error) => error === cause,
	);
	assert.throws(() => failed.audit.validatedSetup(), /UNAVAILABLE/);
	const wrong = fixture();
	wrong.retained.get(wrong.event.baseline.finalRequest.path)!.fill(0);
	assert.throws(
		() => wrong.audit.receiveValidatedSetup(wrong.event, wrong.retained, wrong.record, () => {}),
		/RETAINED/,
	);
	const closed = fixture();
	assert.throws(
		() =>
			closed.audit.receiveValidatedSetup(
				closed.event,
				closed.retained,
				(value) => {
					const raw = closed.record(value);
					closed.audit.close();
					return raw;
				},
				() => {},
			),
		/AUDIT_LOST/,
	);
	assert.throws(() => closed.audit.validatedSetup(), /AUDIT_LOST/);
});

test("eight original peers join by identity with primary last and reordered checkpoint", () => {
	const f = fixture({ cohort: true });
	f.audit.receiveValidatedSetup(f.event, f.retained, f.record, () => {});
	assert.equal(f.audit.validatedSetup().event.setup.settlement.samples.length, 8);
	const settlement = structuredClone(f.event.setup.settlement);
	settlement.refreshId = "final-eight";
	settlement.samples.reverse();
	for (const request of f.requests) {
		const original = { ...request, sampleTime: "final-time", deadline: "final-deadline" };
		const result = { ...f.result, body: "final-body" };
		f.audit.beginSetupExecution(original)(result);
		const sample = settlement.samples.find((sample) => sample.watchId === request.scope.watchId)!;
		sample.request.sampleTime = original.sampleTime;
		sample.request.deadline = original.deadline;
		sample.result = result;
	}
	const checkpoint = () => ({
		id: settlement.refreshId,
		index: 1000 as const,
		settlement,
		sample: f.record({
			kind: "ops-refresh-samples",
			refreshId: settlement.refreshId,
			ownerEpoch: "owner",
			samples: settlement.samples,
		}),
		publication: f.record({
			kind: "ops-refresh-publication",
			refreshId: settlement.refreshId,
			ownerEpoch: "owner",
			...settlement.publication,
		}),
	});
	assert.deepEqual(f.audit.validateSc085Checkpoint(checkpoint(), f.retained).settlement.samples, settlement.samples);
	const passive = settlement.samples.find((sample) => sample.watchId === "ops-passive-7")!;
	passive.request.stateNamespace = "foreign";
	assert.throws(() => f.audit.validateSc085Checkpoint(checkpoint(), f.retained), /ORIGINAL_EXECUTION/);
});

for (const attackedRead of [1, 5]) {
	test(`registered setup retained read ${attackedRead} refuses swallowed reentry without accepting a receipt`, async () => {
		let receive!: (event: OrdinaryValidatedSetup) => Promise<SetupRawRef>;
		let active = false,
			reads = 0,
			helpers = 0,
			nestedHelpers = 0;
		let failure: Error | undefined;
		const check = () => {
			if (active) failure ??= new Error("OPS_SYNCHRONOUS_AUTHORITY_REENTRY");
			if (failure) throw failure;
			helpers++;
		};
		// Inert supplier port, with the same per-get boundary used by the owner.
		// Actual supplier latch behavior is tested in ordinary-operational-reentry.
		const retained = {
			get(path: string) {
				active = true;
				try {
					if (++reads === attackedRead) {
						const before = helpers;
						for (let i = 0; i < 8; i++) {
							try {
								check();
							} catch {
								/* Suppress the nested hook and swallow refusal. */
							}
						}
						nestedHelpers += helpers - before;
					}
					const bytes = f.retained.get(path);
					if (failure) throw failure;
					return bytes;
				} finally {
					active = false;
				}
			},
		};
		const f = fixture({
			register(audit) {
				audit.registerValidatedSetupReceiver(
					(callback) => {
						receive = callback;
					},
					retained,
					(value) => f.record(value),
					check,
				);
			},
		});
		await assert.rejects(receive(f.event), /AUTHORITY_REENTRY/);
		assert.equal(reads, attackedRead);
		assert.equal(nestedHelpers, 0);
		assert.equal(active, false);
		assert.throws(() => f.audit.validatedSetup(), /UNAVAILABLE/);
		await assert.rejects(receive(f.event), /DUPLICATE/);
	});
}

for (const mutation of ["missing", "duplicate", "foreign", "passive-key", "passive-result"] as const) {
	test(`eight-peer setup refuses ${mutation} even with a valid primary`, () => {
		const f = fixture({ cohort: true });
		const samples = f.event.setup.settlement.samples;
		const passive = samples.find((sample) => sample.watchId === "ops-passive-7")!;
		if (mutation === "missing") samples.splice(samples.indexOf(passive), 1);
		if (mutation === "duplicate") passive.watchId = "ops-primary";
		if (mutation === "foreign") passive.watchId = "foreign";
		if (mutation === "passive-key") passive.request.executionKey = "foreign";
		if (mutation === "passive-result") passive.result.body = "foreign";
		f.event.setup.sample = f.record({
			kind: "ops-refresh-samples",
			refreshId: f.event.setup.id,
			ownerEpoch: "owner",
			samples,
		});
		assert.throws(
			() => f.audit.receiveValidatedSetup(f.event, f.retained, f.record, () => {}),
			/COHORT|ORIGINAL_EXECUTION/,
		);
	});
}
