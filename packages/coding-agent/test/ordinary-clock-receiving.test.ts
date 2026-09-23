import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { parseOriginalCIClock, retainOriginalCIClock } from "../src/core/ordinary-sc085-source/ci-clock-receiving.ts";

const query = { beforeNs: "100", afterNs: "110" };
const receiving = { path: "/original/receiving", sha256: "a".repeat(64) };
function encoded(path: string, value: unknown) {
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
	return { raw: { path, sha256: createHash("sha256").update(bytes).digest("hex") }, base64: bytes.toString("base64") };
}
function fixture(release = receiving) {
	const controller = { serviceUnit: "original.service", invocationId: "b".repeat(32), pid: "21", startTicks: "50" };
	const context = encoded("/original/context", {
		version: 1,
		kind: "original-ci-operational-context",
		receiving,
		entry: receiving,
		release,
		controller,
		directory: { device: "1", inode: "2" },
		clock: {
			clock: "CLOCK_MONOTONIC",
			bootId: "12345678-1234-1234-1234-123456789abc",
			timeNamespace: { device: "1", inode: "3" },
			startedNs: "0",
			managerDeadlineNs: "1000",
			runnerJoinDeadlineNs: "1000",
			prelaunchDeadlineNs: "1000",
			bodyDeadlineNs: "1000",
			workloadDeadlineNs: "1100",
			joinsDeadlineNs: "1200",
			captureReleaseDeadlineNs: "1300",
			reportingDeadlineNs: "1400",
		},
	});
	const request = encoded("/original/request", {
		version: 1,
		kind: "original-ci-operational-request",
		authorizationId: "c".repeat(64),
		operation: "boundary",
		nonce: `120.${"d".repeat(64)}`,
		helper: { pid: 22, startTicks: "60" },
		context: context.raw,
		clockQuery: query,
	});
	// Transport-only DATA: deliberately not a qualified physical basis/guard.
	const basis = encoded("/original/basis", { transportDataOnly: true });
	const reply = encoded("/original/reply", {
		version: 1,
		kind: "original-ci-operational-reply",
		request: request.raw,
		checkedNs: "130",
		controller,
		phase: "body",
		outcome: "allow",
		reason: "",
		authorizationId: "c".repeat(64),
		clockGuard: { basis: basis.raw, query, before: basis.raw, after: basis.raw, head: basis.raw },
	});
	const consumed = encoded("/original/consumed", {
		version: 1,
		kind: "original-ci-operational-consumption",
		request: request.raw,
		reply: reply.raw,
		controller,
		acceptedNs: "140",
	});
	const helperAck = encoded("/original/helper-ack", {
		version: 1,
		kind: "original-ci-operational-consumed",
		request: request.raw,
		reply: reply.raw,
		helper: { pid: 22, startTicks: "60" },
		context: context.raw,
	});
	// Synthetic decoder DATA only; this does not witness a real commit.
	const commit = encoded(`/original/ordinary-commit-120.${"d".repeat(64)}.json`, {
		version: 1,
		kind: "original-ci-operational-commit",
		nonce: `120.${"d".repeat(64)}`,
		consumption: consumed.raw,
		controller,
		committedNs: "150",
	});
	return {
		version: 1,
		kind: "original-ci-operational-clock-receiving",
		authorization: { authorization_id: "c".repeat(64) },
		reply,
		consumed,
		records: [context, request, basis, helperAck, commit],
	};
}
const bytes = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
describe("private clock packet DATA, no helper/native/physical qualification", () => {
	test("decodes exact reply/ACK and selected graph without rewriting retained bytes", () => {
		const packet = fixture(),
			result = parseOriginalCIClock(bytes(packet), query, "boundary", receiving);
		expect(result.projection.reply.raw).toEqual(packet.reply.raw);
		expect(Buffer.from(result.projection.reply.bytes).toString("base64")).toBe(packet.reply.base64);
		expect(result.projection.records).toHaveLength(5);
	});
	test.each([
		"extra",
		"duplicate",
		"missing",
		"hash",
		"base64",
		"count",
		"bytes",
		"query",
		"ack",
		"helper-ack",
		"commit-consumption",
		"commit-controller",
		"commit-nonce",
		"commit-order",
		"commit-deadline",
		"commit-path",
		"commit-duplicate",
		"denial",
		"context",
		"deadline",
		"phase",
	])("refuses %s", (failure) => {
		const packet = fixture();
		if (failure === "extra") Object.assign(packet, { extra: true });
		if (failure === "duplicate") packet.records.push(packet.records[0]);
		if (failure === "missing") packet.records.pop();
		if (failure === "helper-ack") {
			const value = JSON.parse(Buffer.from(packet.records[3].base64, "base64").toString());
			value.reply = receiving;
			packet.records[3] = encoded(packet.records[3].raw.path, value);
		}
		if (failure.startsWith("commit-")) {
			const value = JSON.parse(Buffer.from(packet.records[4].base64, "base64").toString());
			if (failure === "commit-consumption") value.consumption = receiving;
			if (failure === "commit-controller") value.controller.pid = "99";
			if (failure === "commit-nonce") value.nonce = `121.${"d".repeat(64)}`;
			if (failure === "commit-order") value.committedNs = "139";
			if (failure === "commit-deadline") value.committedNs = "1000";
			packet.records[4] = encoded(
				failure === "commit-path" ? "/original/wrong-commit" : packet.records[4].raw.path,
				value,
			);
			if (failure === "commit-duplicate") packet.records.push(encoded("/original/second-commit", value));
		}
		if (failure === "hash") packet.records[0].raw.sha256 = "e".repeat(64);
		if (failure === "base64") packet.records[0].base64 += "\n";
		if (failure === "count") packet.records = Array.from({ length: 17 }, (_, i) => encoded(`/record/${i}`, {}));
		if (failure === "bytes") packet.records.push(encoded("/too-large", { data: "x".repeat(32768) }));
		if (["query", "denial", "phase"].includes(failure)) {
			const value = JSON.parse(Buffer.from(packet.reply.base64, "base64").toString());
			if (failure === "query") value.clockGuard.query.afterNs = "111";
			if (failure === "denial") value.outcome = "deny";
			if (failure === "phase") value.phase = "normal-cleanup";
			packet.reply = encoded(packet.reply.raw.path, value);
		}
		if (["ack", "deadline"].includes(failure)) {
			const value = JSON.parse(Buffer.from(packet.consumed.base64, "base64").toString());
			if (failure === "ack") value.reply = receiving;
			else value.acceptedNs = "4000000120";
			packet.consumed = encoded(packet.consumed.raw.path, value);
		}
		expect(() =>
			parseOriginalCIClock(
				bytes(packet),
				query,
				"boundary",
				failure === "context" ? { ...receiving, sha256: "f".repeat(64) } : receiving,
			),
		).toThrow();
	});
	test.each(["01", "-1", "1.1", "100000000000000000000"])("refuses noncanonical query %s before data", (value) => {
		expect(() =>
			parseOriginalCIClock(bytes(fixture()), { beforeNs: value, afterNs: "110" }, "boundary", receiving),
		).toThrow();
	});
	test.each(["success", "missing", "late-mutation", "async", "release"])("same-map retention %s", (mode) => {
		const initial = encoded("/original/initial", { inert: true });
		const release = encoded("/original/release", {
			version: 1,
			kind: "original-ci-operational-release",
			entry: receiving,
			captureSha256: "a".repeat(64),
			initial: initial.raw,
			authorizationId: "c".repeat(64),
			wrapper: { authorization_id: "c".repeat(64) },
			issuanceLink: receiving,
			releasedNs: "1",
			releasedWallSeconds: 1,
		});
		const packet = fixture(mode === "release" ? receiving : release.raw);
		const received = parseOriginalCIClock(bytes(packet), query, "boundary", receiving);
		const retained = new Map<string, Uint8Array>();
		const projection = {
			release: { raw: release.raw, bytes: Buffer.from(release.base64, "base64") },
			initial: { raw: initial.raw, bytes: Buffer.from(initial.base64, "base64") },
		};
		for (const entry of Object.values(projection)) retained.set(entry.raw.path, entry.bytes);
		let calls = 0;
		const recorder = {
			retained,
			retain(ref: typeof receiving, raw: Uint8Array) {
				calls++;
				if (mode !== "missing") retained.set(ref.path, Uint8Array.from(raw));
				if (mode === "late-mutation" && calls === 5) retained.set(packet.reply.raw.path, Buffer.from("changed"));
				if (mode === "async") return Promise.resolve();
			},
		};
		if (mode === "success") {
			expect(() => retainOriginalCIClock(received, projection, recorder)).not.toThrow();
			expect(calls).toBe(7);
		} else expect(() => retainOriginalCIClock(received, projection, recorder)).toThrow();
	});
	test("checks complete stdout including LF", () => {
		expect(() => parseOriginalCIClock(Buffer.alloc(65537, 32), query, "boundary", receiving)).toThrow(
			"OPS_CI_CLOCK_OUTPUT_LIMIT",
		);
	});
});
