import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import type { OriginalCIInitialProjection, ReceivedCIData } from "./ci-authority.ts";
import type { RawRef } from "./fd-slot-expectation.ts";

export interface OriginalCIClockQuery {
	beforeNs: string;
	afterNs: string;
}
export interface ClockRetainedBytes {
	raw: RawRef;
	bytes: Uint8Array;
}
export interface ReceivedCIClock {
	authorization: ReceivedCIData;
	projection: { reply: ClockRetainedBytes; consumed: ClockRetainedBytes; records: ClockRetainedBytes[] };
}
function fields(value: unknown, keys: string): asserts value is Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "OPS_CI_CLOCK_OBJECT");
	assert.deepEqual(Object.keys(value).sort(), keys.split(" ").sort(), "OPS_CI_CLOCK_FIELDS");
}
function ns(value: unknown): bigint {
	assert(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value), "OPS_CI_CLOCK_INTEGER");
	return BigInt(value);
}
function ref(value: unknown): asserts value is RawRef {
	fields(value, "path sha256");
	assert(
		typeof value.path === "string" &&
			isAbsolute(value.path) &&
			normalize(value.path) === value.path &&
			value.path !== "/" &&
			!/[\u0000-\u001f\u007f]/.test(value.path) &&
			typeof value.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(value.sha256),
		"OPS_CI_CLOCK_REF",
	);
}
/** Called only inside the original receiveTuple guard. Retain detached bytes,
 * then re-read the SAME map; swallowed callback reentry is checked by that guard.
 * This does not validate physical qualification or replace live helper authority. */
export function retainOriginalCIClock(
	received: ReceivedCIClock,
	initial: OriginalCIInitialProjection,
	recorder: { retained: ReadonlyMap<string, Uint8Array>; retain?(ref: RawRef, bytes: Uint8Array): void },
): void {
	assert(typeof recorder.retain === "function", "OPS_CI_CLOCK_ORIGINAL_RETAIN_REQUIRED");
	const entries = [received.projection.reply, received.projection.consumed, ...received.projection.records];
	for (const entry of entries) {
		const completion: unknown = recorder.retain({ ...entry.raw }, Uint8Array.from(entry.bytes));
		assert(completion === undefined, "OPS_CI_CLOCK_RETENTION_SYNCHRONOUS");
	}
	const retained = (entry: ClockRetainedBytes) => {
		assert(
			createHash("sha256").update(entry.bytes).digest("hex") === entry.raw.sha256,
			"OPS_CI_CLOCK_PROJECTION_MUTATED",
		);
		const actual = recorder.retained.get(entry.raw.path);
		assert(actual && Buffer.from(actual).equals(Buffer.from(entry.bytes)), "OPS_CI_CLOCK_NOT_RETAINED");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(actual)) as unknown;
	};
	for (const entry of entries) retained(entry);
	const release = retained(initial.release);
	fields(
		release,
		"version kind entry captureSha256 initial authorizationId wrapper issuanceLink releasedNs releasedWallSeconds",
	);
	assert.deepEqual(release.initial, initial.initial.raw, "OPS_CI_CLOCK_INITIAL");
	retained(initial.initial);
	assert.deepEqual(release.wrapper, received.authorization, "OPS_CI_CLOCK_RELEASE_AUTHORIZATION");
	const reply = retained(received.projection.reply);
	fields(reply, "version kind request checkedNs controller phase outcome reason authorizationId clockGuard");
	const requestEntry = received.projection.records.find((entry) => {
		ref(reply.request);
		return entry.raw.path === reply.request.path && entry.raw.sha256 === reply.request.sha256;
	});
	assert(requestEntry, "OPS_CI_CLOCK_REQUEST_REQUIRED");
	const request = retained(requestEntry);
	fields(request, "version kind authorizationId operation nonce helper context clockQuery");
	const contextEntry = received.projection.records.find((entry) => {
		ref(request.context);
		return entry.raw.path === request.context.path && entry.raw.sha256 === request.context.sha256;
	});
	assert(contextEntry, "OPS_CI_CLOCK_CONTEXT_REQUIRED");
	const context = retained(contextEntry);
	fields(context, "version kind receiving entry release controller clock directory");
	assert.deepEqual(context.release, initial.release.raw, "OPS_CI_CLOCK_ORIGINAL_RELEASE");
	assert.deepEqual(context.entry, release.entry, "OPS_CI_CLOCK_ORIGINAL_ENTRY");
	// A later callback must not rewrite an earlier row or the original initial bytes.
	for (const entry of [...entries, initial.release, initial.initial]) retained(entry);
}

export function assertOriginalCIClockQuery(query: OriginalCIClockQuery): void {
	fields(query, "beforeNs afterNs");
	assert(ns(query.beforeNs) <= ns(query.afterNs), "OPS_CI_CLOCK_QUERY_ORDER");
}

/** Finite private transport DATA correspondence. The original pinned helper
 * owns nonce/liveness/deadline/consumed-ACK authority. Full physical clock and
 * exhaustive guard-chain receiving are not granted by this decoder. */
export function parseOriginalCIClock(
	raw: Uint8Array,
	query: OriginalCIClockQuery,
	operation: string,
	receiving: RawRef,
): ReceivedCIClock {
	assertOriginalCIClockQuery(query);
	assert(raw.byteLength <= 65536, "OPS_CI_CLOCK_OUTPUT_LIMIT");
	const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	const packet = json(raw);
	fields(packet, "version kind authorization reply consumed records");
	assert(packet.version === 1 && packet.kind === "original-ci-operational-clock-receiving", "OPS_CI_CLOCK_KIND");
	assert(Array.isArray(packet.records) && packet.records.length <= 16, "OPS_CI_CLOCK_RECORD_COUNT");
	let remaining = 32768;
	const paths = new Set<string>();
	const decode = (value: unknown): ClockRetainedBytes => {
		fields(value, "raw base64");
		ref(value.raw);
		assert(!paths.has(value.raw.path), "OPS_CI_CLOCK_DUPLICATE_PATH");
		paths.add(value.raw.path);
		assert(
			typeof value.base64 === "string" && value.base64.length <= 4 * Math.ceil(remaining / 3),
			"OPS_CI_CLOCK_ENCODING_LIMIT",
		);
		const bytes = Buffer.from(value.base64, "base64");
		assert(
			bytes.length > 0 && bytes.length <= remaining && bytes.toString("base64") === value.base64,
			"OPS_CI_CLOCK_ENCODING",
		);
		assert(createHash("sha256").update(bytes).digest("hex") === value.raw.sha256, "OPS_CI_CLOCK_HASH");
		remaining -= bytes.length;
		return { raw: { ...value.raw }, bytes };
	};
	const reply = decode(packet.reply),
		consumed = decode(packet.consumed),
		records = packet.records.map(decode);
	const record = (reference: unknown) => {
		ref(reference);
		const row = records.find((value) => value.raw.path === reference.path);
		assert(row && row.raw.sha256 === reference.sha256, "OPS_CI_CLOCK_RECORD_REQUIRED");
		return json(row.bytes);
	};
	const permission = json(reply.bytes),
		accepted = json(consumed.bytes);
	fields(permission, "version kind request checkedNs controller phase outcome reason authorizationId clockGuard");
	fields(accepted, "version kind request reply controller acceptedNs");
	assert(
		permission.version === 1 &&
			permission.kind === "original-ci-operational-reply" &&
			permission.outcome === "allow" &&
			permission.reason === "",
		"OPS_CI_CLOCK_PERMISSION",
	);
	assert(
		accepted.version === 1 && accepted.kind === "original-ci-operational-consumption",
		"OPS_CI_CLOCK_CONSUMPTION",
	);
	ref(permission.request);
	ref(accepted.request);
	ref(accepted.reply);
	assert.deepEqual(accepted.request, permission.request, "OPS_CI_CLOCK_ACK_REQUEST");
	assert.deepEqual(accepted.reply, reply.raw, "OPS_CI_CLOCK_ACK_REPLY");
	fields(permission.controller, "serviceUnit invocationId pid startTicks");
	assert(
		typeof permission.controller.serviceUnit === "string" &&
			permission.controller.serviceUnit.length > 0 &&
			typeof permission.controller.invocationId === "string" &&
			/^[a-f0-9]{32}$/.test(permission.controller.invocationId) &&
			ns(permission.controller.pid) > 0n &&
			ns(permission.controller.startTicks) > 0n,
		"OPS_CI_CLOCK_CONTROLLER",
	);
	assert.deepEqual(accepted.controller, permission.controller, "OPS_CI_CLOCK_ACK_CONTROLLER");
	assert(
		ns(accepted.acceptedNs) >= ns(permission.checkedNs) && ns(permission.checkedNs) >= ns(query.afterNs),
		"OPS_CI_CLOCK_ACK_ORDER",
	);
	fields(permission.clockGuard, "basis query before after head");
	assert.deepEqual(permission.clockGuard.query, query, "OPS_CI_CLOCK_QUERY");
	for (const name of ["basis", "before", "after", "head"]) record(permission.clockGuard[name]);
	const request = record(permission.request);
	fields(request, "version kind authorizationId operation nonce helper context clockQuery");
	assert(
		request.version === 1 &&
			request.kind === "original-ci-operational-request" &&
			request.operation === operation &&
			request.authorizationId === permission.authorizationId,
		"OPS_CI_CLOCK_REQUEST",
	);
	assert.deepEqual(request.clockQuery, query, "OPS_CI_CLOCK_REQUEST_QUERY");
	// The consumed envelope member is the controller's fourth record. The
	// helper's original ACK must also arrive as bytes in the existing records.
	const acknowledgments = records
		.map((entry) => json(entry.bytes))
		.filter(
			(value) =>
				value !== null &&
				typeof value === "object" &&
				(value as Record<string, unknown>).kind === "original-ci-operational-consumed",
		);
	assert(acknowledgments.length === 1, "OPS_CI_CLOCK_HELPER_ACK_REQUIRED");
	const acknowledgment = acknowledgments[0];
	fields(acknowledgment, "version kind request reply helper context");
	assert(acknowledgment.version === 1, "OPS_CI_CLOCK_HELPER_ACK_VERSION");
	assert.deepEqual(acknowledgment.request, permission.request, "OPS_CI_CLOCK_HELPER_ACK_REQUEST");
	assert.deepEqual(acknowledgment.reply, reply.raw, "OPS_CI_CLOCK_HELPER_ACK_REPLY");
	assert.deepEqual(acknowledgment.helper, request.helper, "OPS_CI_CLOCK_HELPER_ACK_IDENTITY");
	assert.deepEqual(acknowledgment.context, request.context, "OPS_CI_CLOCK_HELPER_ACK_CONTEXT");
	assert(
		typeof request.nonce === "string" && /^(0|[1-9][0-9]{0,19})\.[a-f0-9]{64}$/.test(request.nonce),
		"OPS_CI_CLOCK_NONCE",
	);
	const started = ns(request.nonce.split(".")[0]);
	// A fifth is evidence of the preceding fourth commit, NOT successful fifth
	// publication, crash recovery, current permission or completion of the route.
	const commits = records.filter((entry) => {
		const value = json(entry.bytes);
		return (
			value !== null &&
			typeof value === "object" &&
			(value as Record<string, unknown>).kind === "original-ci-operational-commit"
		);
	});
	assert(commits.length === 1, "OPS_CI_CLOCK_COMMIT_REQUIRED");
	const commit = json(commits[0].bytes);
	fields(commit, "version kind nonce consumption controller committedNs");
	assert(commit.version === 1 && commit.nonce === request.nonce, "OPS_CI_CLOCK_COMMIT_NONCE");
	assert.deepEqual(commit.consumption, consumed.raw, "OPS_CI_CLOCK_COMMIT_CONSUMPTION");
	assert.deepEqual(commit.controller, permission.controller, "OPS_CI_CLOCK_COMMIT_CONTROLLER");
	assert(
		commits[0].raw.path ===
			`${consumed.raw.path.slice(0, consumed.raw.path.lastIndexOf("/"))}/ordinary-commit-${request.nonce}.json`,
		"OPS_CI_CLOCK_COMMIT_PATH",
	);
	assert(
		ns(accepted.acceptedNs) <= ns(commit.committedNs) && ns(commit.committedNs) < started + 4_000_000_000n,
		"OPS_CI_CLOCK_COMMIT_ORDER",
	);
	assert(
		started <= ns(permission.checkedNs) && ns(accepted.acceptedNs) < started + 4_000_000_000n,
		"OPS_CI_CLOCK_DEADLINE",
	);
	fields(request.helper, "pid startTicks");
	assert(
		Number.isSafeInteger(request.helper.pid) && Number(request.helper.pid) > 0 && ns(request.helper.startTicks) > 0n,
		"OPS_CI_CLOCK_HELPER",
	);
	const context = record(request.context);
	fields(context, "version kind receiving entry release controller clock directory");
	assert(context.version === 1 && context.kind === "original-ci-operational-context", "OPS_CI_CLOCK_CONTEXT");
	assert.deepEqual(context.receiving, receiving, "OPS_CI_CLOCK_RECEIVING");
	assert.deepEqual(context.controller, permission.controller, "OPS_CI_CLOCK_CONTEXT_CONTROLLER");
	ref(context.entry);
	ref(context.release);
	fields(context.directory, "device inode");
	ns(context.directory.device);
	assert(ns(context.directory.inode) > 0n, "OPS_CI_CLOCK_DIRECTORY");
	fields(
		context.clock,
		"clock bootId timeNamespace startedNs managerDeadlineNs runnerJoinDeadlineNs prelaunchDeadlineNs bodyDeadlineNs workloadDeadlineNs joinsDeadlineNs captureReleaseDeadlineNs reportingDeadlineNs",
	);
	assert(
		context.clock.clock === "CLOCK_MONOTONIC" &&
			typeof context.clock.bootId === "string" &&
			/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.clock.bootId),
		"OPS_CI_CLOCK_CONTEXT_DOMAIN",
	);
	fields(context.clock.timeNamespace, "device inode");
	ns(context.clock.timeNamespace.device);
	assert(ns(context.clock.timeNamespace.inode) > 0n, "OPS_CI_CLOCK_CONTEXT_NAMESPACE");
	for (const [key, value] of Object.entries(context.clock)) if (key.endsWith("Ns")) ns(value);
	assert(
		ns(context.clock.startedNs) <= ns(query.beforeNs) &&
			ns(commit.committedNs) <
				ns(context.clock[operation === "preflight" ? "workloadDeadlineNs" : "bodyDeadlineNs"]),
		"OPS_CI_CLOCK_CONTEXT_DEADLINE",
	);
	assert(
		permission.phase === "body" || (permission.phase === "normal-cleanup" && operation === "preflight"),
		"OPS_CI_CLOCK_PHASE",
	);
	const authorization = packet.authorization as ReceivedCIData;
	assert(authorization && permission.authorizationId === authorization.authorization_id, "OPS_CI_CLOCK_AUTHORIZATION");
	return { authorization, projection: { reply, consumed, records } };
}
