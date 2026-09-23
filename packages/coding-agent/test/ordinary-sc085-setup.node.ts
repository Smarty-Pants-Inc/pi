import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, vi } from "vitest";
import type { OrdinaryExecutionRequest, OrdinaryExecutionResult } from "../src/core/ordinary-executor.ts";
import { OrdinaryOperationalAudit } from "../src/core/ordinary-operational-audit.ts";
import type { OrdinaryOwnerContext } from "../src/core/ordinary-owner-context.ts";
import type { OrdinarySc085Setup, OrdinaryValidatedSetup, SetupRawRef } from "../src/core/ordinary-sc085-setup.ts";
import type { Sc085OriginalReceiving } from "../src/core/ordinary-sc085-source/operational-admission.ts";
import type {
	OrdinaryExposureFrame,
	OrdinaryExposureReceipt,
	OrdinaryProviderOutcome,
} from "../src/core/ordinary-sense.ts";
import type { TokenReservation } from "../src/core/ordinary-token-budget.ts";

// MOCK dependency isolation only. Actual audit/private-ledger bodies run; owner,
// canonical hooks and Sc085 custody are substituted at MODULE boundaries. No
// production registry is enrolled and no authentic context/token is constructed.
// These cases do NOT test original-owner authentication, canonical composition,
// native execution or physical custody. Separate unmocked boundary cases test refusals.
interface ModeledRoute {
	context: OrdinaryOwnerContext;
	receiving: Sc085OriginalReceiving;
	active: boolean;
	failure?: { cause: unknown };
	helpers: number;
	reads: number;
	nestedHelpers: number;
	hooks: { sc085SetupReceiver(receive: (event: OrdinaryValidatedSetup) => Promise<SetupRawRef>): void };
	storage: { retained: { get(path: string): Uint8Array | undefined }; record(value: unknown): SetupRawRef };
}
const modeled = vi.hoisted(() => ({
	contexts: new WeakMap<object, ModeledRoute>(),
	receivings: new WeakMap<object, ModeledRoute>(),
}));
function current(route: ModeledRoute): void {
	if (route.active) route.failure ??= { cause: new Error("OPS_SYNCHRONOUS_AUTHORITY_REENTRY") };
	if (route.failure) throw route.failure.cause;
	route.helpers++;
}
function original(context: OrdinaryOwnerContext): ModeledRoute {
	const route = modeled.contexts.get(context);
	assert(route, "MOCK_CONTEXT_REQUIRED");
	return route;
}
vi.mock("../src/core/ordinary-owner-context.ts", () => ({
	assertOrdinaryOwner: (context: OrdinaryOwnerContext) => {
		original(context);
	},
}));
vi.mock("../src/core/ordinary-runtime.ts", () => ({
	receivedOrdinaryOperationalHooks: (context: OrdinaryOwnerContext) => original(context).hooks,
	publishOrdinaryRequest: () => {},
	publishOrdinaryExposure: () => {},
	assertOrdinaryExposureAudit: () => {
		throw new Error("MOCK_QUALIFIED_EXPOSURE_UNSUPPORTED");
	},
}));
vi.mock("../src/core/ordinary-sc085-source/operational-admission.ts", () => ({
	checkSc085Operation: (receiving: Sc085OriginalReceiving, context: OrdinaryOwnerContext) => {
		const route = original(context);
		assert.equal(receiving, route.receiving);
		current(route);
	},
	receiveSc085OriginalStorage: (receiving: Sc085OriginalReceiving, context: OrdinaryOwnerContext) => {
		const route = original(context);
		assert.equal(receiving, route.receiving);
		current(route);
		return route.storage;
	},
	guardSc085OriginalCallback: <T>(receiving: Sc085OriginalReceiving, action: () => T): T => {
		const route = modeled.receivings.get(receiving);
		assert(route, "MOCK_RECEIVING_REQUIRED");
		current(route);
		route.active = true;
		try {
			const result = action();
			if (route.failure) throw route.failure.cause;
			return result;
		} catch (cause) {
			route.failure ??= { cause };
			throw route.failure.cause;
		} finally {
			route.active = false;
		}
	},
}));

function fixture(
	options: {
		complete?: boolean;
		duplicateExecution?: boolean;
		key?: boolean;
		cohort?: boolean;
		recordMode?: "mutate" | "fail" | "close";
		recorderFailure?: Error;
		attackedRead?: number;
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
	const retained = new Map<string, Uint8Array>();
	let id = 0;
	const store = (bytes: Uint8Array): SetupRawRef => {
		const ref = { path: `fixture-${++id}`, sha256: createHash("sha256").update(bytes).digest("hex") };
		retained.set(ref.path, Uint8Array.from(bytes));
		return ref;
	};
	const record = (value: unknown) => store(new TextEncoder().encode(JSON.stringify(value)));
	let receive!: (event: OrdinaryValidatedSetup) => Promise<SetupRawRef>;
	// Isolated dependency substitutes, NEVER sent to the real owner/receiving modules.
	const receiving = Object.freeze({}) as Sc085OriginalReceiving;
	const context = {
		operationalAudit: audit,
		originalSetupReceiving(setup: OrdinarySc085Setup) {
			audit.assertOriginalSetup(setup);
			current(route);
			return receiving;
		},
	} as unknown as OrdinaryOwnerContext;
	const route: ModeledRoute = {
		context,
		receiving,
		active: false,
		helpers: 0,
		reads: 0,
		nestedHelpers: 0,
		hooks: {
			sc085SetupReceiver(callback) {
				receive = callback;
			},
		},
		storage: {
			retained: {
				get(path) {
					if (++route.reads === options.attackedRead) {
						const before = route.helpers;
						for (let i = 0; i < 8; i++) {
							try {
								current(route);
							} catch {
								/* Modeled port swallows reentry refusal. */
							}
						}
						route.nestedHelpers += route.helpers - before;
					}
					if (route.failure) throw route.failure.cause;
					return retained.get(path);
				},
			},
			record(value) {
				if (options.recordMode === "fail") throw options.recorderFailure;
				if (options.recordMode === "mutate") {
					assert(value && typeof value === "object");
					Object.assign(value, { originalRequestId: "forged" });
				}
				const raw = record(value);
				if (options.recordMode === "close") audit.close();
				return raw;
			},
		},
	};
	modeled.contexts.set(context, route);
	modeled.receivings.set(receiving, route);
	audit.registerValidatedSetupReceiver(context);
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
	return { audit, context, receive, route, event, retained, record, request, requests, result };
}

test("baseline joins retained original executor/result and accepted request/exposure, not final checkpoint", async () => {
	const f = fixture();
	// Mutating the caller's old request/result after capture cannot rewrite originals.
	f.request.stateNamespace = "mutated";
	f.result.body = "mutated";
	const raw = await f.receive(f.event);
	assert(f.retained.has(raw.path));
	const joined = f.audit.validatedSetup();
	assert.equal(joined.originalRequestId, "native-baseline");
	assert.equal(joined.event.setup.settlement.samples[0].request.stateNamespace, "original-setup-namespace");
	joined.event.setup.settlement.samples[0].request.stateNamespace = "caller-mutation";
	assert.equal(
		f.audit.validatedSetup().event.setup.settlement.samples[0].request.stateNamespace,
		"original-setup-namespace",
	);
	await assert.rejects(f.receive(f.event), /DUPLICATE/);
});

for (const field of ["executionKey", "stateNamespace", "sampleTime", "deadline"] as const) {
	test(`rehashing a notification cannot replace original execution ${field}`, async () => {
		const f = fixture();
		f.event.setup.settlement.samples[0].request[field] = "forged";
		f.event.setup.sample = f.record({
			kind: "ops-refresh-samples",
			refreshId: f.event.setup.id,
			ownerEpoch: "owner",
			samples: f.event.setup.settlement.samples,
		});
		await assert.rejects(f.receive(f.event), /ORIGINAL_EXECUTION/);
		assert.throws(() => f.audit.validatedSetup(), /UNAVAILABLE/);
	});
}

test("missing completion, ambiguous execution and absent native Core key never qualify", async () => {
	for (const options of [{ complete: false }, { duplicateExecution: true }, { key: false }]) {
		const f = fixture(options);
		await assert.rejects(f.receive(f.event), /ORIGINAL_EXECUTION|UNAVAILABLE/);
	}
});

test("changed publication, foreign native receipt and final-checkpoint rebinding refuse", async () => {
	const publication = fixture();
	publication.event.setup.settlement.publication.revision++;
	publication.event.setup.publication = publication.record({
		kind: "ops-refresh-publication",
		refreshId: publication.event.setup.id,
		ownerEpoch: "owner",
		...publication.event.setup.settlement.publication,
	});
	await assert.rejects(publication.receive(publication.event), /EXPOSURE_JOIN/);
	const foreign = fixture();
	foreign.event.baseline.native.providerResponseId = "foreign";
	await assert.rejects(foreign.receive(foreign.event), /ORIGINAL_REQUEST/);
	await assert.rejects(foreign.receive(foreign.event), /DUPLICATE/);
	const final = fixture();
	Object.assign(final.event.setup, { index: 1000 });
	await assert.rejects(final.receive(final.event), /IDENTITY/);
});

test("exact setup keys and recorder mutation cannot redefine the retained baseline", async () => {
	const extra = fixture();
	Object.assign(extra.event.setup.settlement.samples[0].request, { extraNamespace: "forged" });
	extra.event.setup.sample = extra.record({
		kind: "ops-refresh-samples",
		refreshId: extra.event.setup.id,
		ownerEpoch: "owner",
		samples: extra.event.setup.settlement.samples,
	});
	await assert.rejects(extra.receive(extra.event), /KEYS/);
	const mutated = fixture({ recordMode: "mutate" });
	await assert.rejects(mutated.receive(mutated.event), /RECORDED/);
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

test("final checkpoint requires latest original completion and preserves setup namespace", async () => {
	// Each failure owns a separate MOCK operation: the guarded receiver latches its
	// first fault. Never reset that latch to reach the next legacy assertion.
	for (const scenario of ["valid", "index", "fields", "revision", "input", "latest"] as const) {
		const f = fixture();
		await f.receive(f.event);
		const request = { ...f.request, sampleTime: "final-time", deadline: "final-deadline" };
		const result = { ...f.result, body: "final-body", completedAt: "final-end" };
		// Preserve all 1000 completions for every independent checkpoint case.
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
		if (scenario === "valid") {
			assert.deepEqual(f.audit.validateSc085Checkpoint(value, f.context), value);
			continue;
		}
		let selected = value;
		if (scenario === "index") selected = { ...value, index: 999 };
		if (scenario === "fields") selected = Object.assign({}, value, { namespace: "forged" });
		if (scenario === "revision")
			f.audit.beginSetupExecution({ ...request, execution: { ...request.execution, revision: "foreign-revision" } })(
				result,
			);
		if (scenario === "input") f.audit.beginSetupExecution({ ...request, input: { foreign: true } })(result);
		if (scenario === "latest")
			f.audit.beginSetupExecution({ ...request, sampleTime: "later" })({ ...result, body: "later" });
		const expected =
			scenario === "index"
				? /IDENTITY/
				: scenario === "fields"
					? /FIELDS/
					: scenario === "latest"
						? /ORIGINAL_EXECUTION/
						: /DEFINITION_CHANGED/;
		let first: unknown;
		assert.throws(
			() => f.audit.validateSc085Checkpoint(selected, f.context),
			(cause) => {
				first = cause;
				return expected.test(String(cause));
			},
		);
		// The same failed operation cannot retry a corrected checkpoint.
		assert.throws(
			() => f.audit.validateSc085Checkpoint(value, f.context),
			(cause) => cause === first,
		);
	}
});

test("recorder failure, wrong retained bytes and owner loss cannot produce a baseline", async () => {
	const cause = new Error("original recorder failed");
	const failed = fixture({ recordMode: "fail", recorderFailure: cause });
	await assert.rejects(failed.receive(failed.event), (error) => error === cause);
	assert.throws(() => failed.audit.validatedSetup(), /UNAVAILABLE/);
	const wrong = fixture();
	wrong.retained.get(wrong.event.baseline.finalRequest.path)!.fill(0);
	await assert.rejects(wrong.receive(wrong.event), /RETAINED/);
	const closed = fixture({ recordMode: "close" });
	await assert.rejects(closed.receive(closed.event), /AUDIT_LOST/);
	assert.throws(() => closed.audit.validatedSetup(), /AUDIT_LOST/);
});

test("eight original peers join by identity with primary last and reordered checkpoint", async () => {
	const f = fixture({ cohort: true });
	await f.receive(f.event);
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
	assert.deepEqual(f.audit.validateSc085Checkpoint(checkpoint(), f.context).settlement.samples, settlement.samples);
	const passive = settlement.samples.find((sample) => sample.watchId === "ops-passive-7")!;
	passive.request.stateNamespace = "foreign";
	assert.throws(() => f.audit.validateSc085Checkpoint(checkpoint(), f.context), /ORIGINAL_EXECUTION/);
});

for (const attackedRead of [1, 5]) {
	test(`registered setup retained read ${attackedRead} refuses swallowed reentry without accepting a receipt`, async () => {
		// The fixed source receiver calls the isolated MOCK supplier guard per get.
		// Actual supplier-latch coverage remains in ordinary-operational-reentry.
		const f = fixture({ attackedRead });
		await assert.rejects(f.receive(f.event), /AUTHORITY_REENTRY/);
		assert.equal(f.route.reads, attackedRead);
		assert.equal(f.route.nestedHelpers, 0);
		assert.equal(f.route.active, false);
		assert.throws(() => f.audit.validatedSetup(), /UNAVAILABLE/);
		await assert.rejects(f.receive(f.event), /DUPLICATE/);
	});
}

for (const mutation of ["missing", "duplicate", "foreign", "passive-key", "passive-result"] as const) {
	test(`eight-peer setup refuses ${mutation} even with a valid primary`, async () => {
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
		await assert.rejects(f.receive(f.event), /COHORT|ORIGINAL_EXECUTION/);
	});
}
