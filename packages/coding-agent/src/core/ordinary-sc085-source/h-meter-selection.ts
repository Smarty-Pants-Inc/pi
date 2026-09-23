import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { OriginalHMeterSelection } from "../owner-h-meter.ts";
import type { OriginalCIInitialProjection } from "./ci-authority.ts";
import type { RawRef } from "./fd-slot-expectation.ts";
import { parseCanonicalPilotDecision } from "./references/sense/src/adapters/codex/pilot-canonical.ts";
import { sc085RetainedBytes } from "./sc085-admission.ts";

function object(value: unknown): Record<string, unknown> {
	assert(value && typeof value === "object" && !Array.isArray(value), "OWNER_H_GRAPH_OBJECT");
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	assert(typeof value === "string" && value.length > 0, "OWNER_H_GRAPH_STRING");
	return value;
}
function pid(value: unknown): number {
	assert(typeof value === "string" && /^[1-9][0-9]*$/.test(value), "OWNER_H_GRAPH_PID");
	const result = Number(value);
	assert(Number.isSafeInteger(result) && result > 0 && result <= 2147483647, "OWNER_H_GRAPH_PID");
	return result;
}
/** Called only by the EXISTING registered supplier after its original initial
 * retention/authority recheck. This maps existing DATA, not an issuer or native
 * permission. Native sender-runtime enforcement remains unconditionally CLOSED. */
export function selectOriginalHMeter(
	projection: OriginalCIInitialProjection,
	retained: ReadonlyMap<string, Uint8Array>,
	signal: AbortSignal,
): OriginalHMeterSelection {
	const release = object(parseCanonicalPilotDecision(projection.release.bytes));
	const initial = object(parseCanonicalPilotDecision(projection.initial.bytes));
	assert.deepEqual(release.initial, projection.initial.raw, "OWNER_H_INITIAL");
	assert(Array.isArray(initial.records), "OWNER_H_RECORDS");
	const originalRefs = new Map(
		initial.records.map((row) => {
			const ref = object(object(row).raw);
			return [text(ref.path), text(ref.sha256)] as const;
		}),
	);
	const record = (value: unknown) => {
		const ref = object(value);
		assert.deepEqual(Object.keys(ref).sort(), ["path", "sha256"]);
		const raw: RawRef = { path: text(ref.path), sha256: text(ref.sha256) };
		assert.equal(originalRefs.get(raw.path), raw.sha256, "OWNER_H_ORIGINAL_GRAPH_REF");
		return object(parseCanonicalPilotDecision(sc085RetainedBytes(raw, retained)));
	};
	const entry = record(release.entry),
		issuance = record(release.issuanceLink);
	const reservation = record(issuance.reservation),
		capture = record(issuance.capture);
	const original = object(initial.original),
		scope = record(original.scope),
		host = record(capture.host);
	const controller = object(capture.controller),
		child = object(entry.child),
		clock = object(reservation.clock);
	const directory = object(entry.directory),
		aggregate = object(scope.aggregate),
		allocation = object(entry.allocation);
	assert.deepEqual(entry.reservation, issuance.reservation, "OWNER_H_RESERVATION");
	assert.deepEqual(capture.child, child, "OWNER_H_CHILD");
	assert.deepEqual(host.child, child, "OWNER_H_HOST_CHILD");
	assert.deepEqual(host.namespacesBefore, host.namespacesAfter, "OWNER_H_HOST_NAMESPACES");
	assert.deepEqual(object(host.namespacesBefore).time, clock.timeNamespace, "OWNER_H_TIME_NAMESPACE");
	assert.deepEqual(entry.clock, clock, "OWNER_H_CLOCK");
	assert.deepEqual(entry.receiving, reservation.receiving, "OWNER_H_RECEIVING");
	assert(clock.clock === "CLOCK_MONOTONIC", "OWNER_H_CLOCK_KIND");
	assert(Array.isArray(host.errors) && host.errors.length === 0, "OWNER_H_HOST_OBSERVATION");
	for (const value of Object.values(aggregate))
		assert(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, "OWNER_H_AGGREGATE_INTEGER");
	assert.deepEqual(
		entry.aggregate,
		{ device: String(aggregate.device), inode: String(aggregate.inode) },
		"OWNER_H_AGGREGATE",
	);
	const receiving = object(entry.receiving);
	return {
		receivingPath: text(receiving.path),
		release: { ...projection.release.raw },
		signal,
		intent: {
			version: 1,
			kind: "original-ci-h-meter-transfer-intent/1",
			effect: "send-original-H",
			receiving: entry.receiving,
			reservation: issuance.reservation,
			entry: release.entry,
			release: projection.release.raw,
			initial: projection.initial.raw,
			controller: capture.controller,
			child: entry.child,
			aggregate: scope.aggregate,
			scope: original.scope,
			epoch: original.epoch,
			enforcement: original.enforcement,
			initialFd: original.initialFd,
			clock: reservation.clock,
		},
		native: {
			controllerPid: pid(controller.pid),
			controllerStartTicks: text(controller.startTicks),
			childPid: pid(child.pid),
			childStartTicks: text(child.startTicks),
			device: String(aggregate.device),
			inode: String(aggregate.inode),
			directoryDevice: text(directory.device),
			directoryInode: text(directory.inode),
			allocation: createHash("sha256").update(text(allocation.id)).digest("hex"),
			bootId: text(clock.bootId),
			namespaces: host.namespacesBefore,
			receiveDeadlineNs: text(clock.workloadDeadlineNs),
			closeDeadlineNs: text(clock.joinsDeadlineNs),
		},
	};
}
