import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { type OperationalBinding, parseOriginalCIInitial } from "../src/core/ordinary-sc085-source/ci-authority.ts";
import { verifyOperationalInitialRetention } from "../src/core/ordinary-sc085-source/operational-admission.ts";

// MOCK: these placeholder records do not form an enforcement chain. That edge is
// verified by its own decoder; here only its same-map call is checked.
const enforcement = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("../src/core/ordinary-sc085-source/enforcement-retention.ts", () => ({
	verifyOperationalEnforcementRetention: enforcement.verify,
}));

// Closed projection/retention DATA only. No controller, authority, native capture,
// selected helper pin, release or physical graph is supplied by these fixtures.
function fixture() {
	const retained = new Map<string, Uint8Array>();
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
	const entry = (path: string, bytes: Buffer) => ({
		raw: { path, sha256: createHash("sha256").update(bytes).digest("hex") },
		base64: bytes.toString("base64"),
	});
	const snapshot = entry("/fixture/snapshot", encode({ synthetic: true, padding: "x".repeat(70000) }));
	const names = [
		"scope",
		"epoch",
		"enforcement",
		"initialFdRoster",
		"inheritedHardLimit",
		"aggregateTasksMembership",
		"noForeignTableSharers",
		"noMigrationOrEscape",
		"noLimitRaiseOrExternalMutation",
		"targetAllocationSemantics",
		"openFileDescriptions",
		"queuedOrInFlightReferences",
		"ioUringFixedFiles",
		"logicalHandles",
	];
	const records = [snapshot, ...names.map((name) => entry(`/fixture/${name}`, encode({ name })))];
	const ref = (name: string) => records.find((row) => row.raw.path === `/fixture/${name}`)!.raw;
	const proofs = Object.fromEntries(names.slice(3, 10).map((name) => [name, ref(name)]));
	const binding = {
		operational_run_id: "synthetic-run",
		native: { profile: { sha256: "a".repeat(64) } },
		fd_slot_bound: {
			scope: ref("scope"),
			epoch: ref("epoch"),
			proofs,
			otherResources: Object.fromEntries(names.slice(10).map((name) => [name, { evidence: ref(name) }])),
		},
	} as unknown as OperationalBinding;
	const document = {
		version: 1,
		kind: "ordinary-resource-initial/1",
		receivingReference: "synthetic",
		runId: binding.operational_run_id,
		allocationId: "synthetic",
		sessionId: "synthetic",
		profileSha256: binding.native.profile.sha256,
		resourceEpoch: "synthetic",
		aggregate: {},
		launcher: {},
		preexec: { nofile: {}, initialFdAndTasks: ref("initialFdRoster"), raw: snapshot.raw },
		original: {
			scope: ref("scope"),
			epoch: ref("epoch"),
			enforcement: ref("enforcement"),
			initialFd: ref("initialFdRoster"),
		},
		records,
	};
	const authorization = { authorization_id: "synthetic", authorization: { operational_binding: binding } };
	const packet = () => {
		const initial = entry("/fixture/initial", encode(document));
		const release = entry(
			"/fixture/release",
			encode({
				version: 1,
				kind: "original-ci-operational-release",
				entry: ref("scope"),
				captureSha256: snapshot.raw.sha256,
				initial: initial.raw,
				authorizationId: "synthetic",
				wrapper: authorization,
				issuanceLink: ref("epoch"),
				releasedNs: "1",
				releasedWallSeconds: 1,
			}),
		);
		for (const row of [...records, release, initial]) retained.set(row.raw.path, Buffer.from(row.base64, "base64"));
		return { version: 1, kind: "original-ci-operational-initial-receiving", authorization, release, initial };
	};
	return { packet, document, binding, retained, encode };
}

test("exact >64KiB initial bytes and release.initial survive private receiving and same-map verification", () => {
	const f = fixture();
	const packet = f.packet();
	const value = parseOriginalCIInitial(f.encode(packet));
	expect(value.projection.initial.bytes.length).toBeGreaterThan(65536);
	expect(value.authorization).toEqual(packet.authorization);
	expect(verifyOperationalInitialRetention(value.projection, f.binding, f.retained)).toEqual(packet.release.raw);
	expect(enforcement.verify).toHaveBeenCalledOnce();
	const [initial, release, binding, records, retained] = enforcement.verify.mock.calls[0];
	expect(initial).toEqual(f.document);
	expect(release).toMatchObject({ kind: "original-ci-operational-release", initial: packet.initial.raw });
	expect(binding).toBe(f.binding);
	expect([...records.values()]).toEqual(f.document.records.map((row) => row.raw));
	expect(retained).toBe(f.retained);
});

test.each(["unknown-field", "wrong-kind", "base64-alias", "hash", "carrier", "wrapper"])(
	"private projection refuses %s",
	(mode) => {
		const f = fixture();
		const packet = f.packet();
		if (mode === "unknown-field") Object.assign(packet, { grant: true });
		if (mode === "wrong-kind") packet.kind = "public-grant";
		if (mode === "base64-alias") packet.initial.base64 += "\n";
		if (mode === "hash") packet.initial.raw.sha256 = "0".repeat(64);
		if (mode === "carrier") packet.initial.raw.path = "/fixture/other";
		if (mode === "wrapper") packet.authorization.authorization_id = "foreign";
		expect(() => parseOriginalCIInitial(f.encode(packet))).toThrow();
	},
);

test.each([
	"missing-release",
	"missing-initial",
	"missing-wrapper",
	"changed-record",
	"duplicate-record",
	"record-count",
	"decoded-limit",
	"wrong-run",
])("same-map retention refuses %s", (mode) => {
	const f = fixture();
	if (mode === "duplicate-record") f.document.records.push(f.document.records[0]);
	if (mode === "record-count") f.document.records = Array.from({ length: 97 }, () => f.document.records[1]);
	if (mode === "decoded-limit") f.document.records[0].base64 = Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64");
	if (mode === "wrong-run") f.document.runId = "foreign";
	const value = parseOriginalCIInitial(f.encode(f.packet()));
	if (mode === "missing-release") f.retained.delete(value.projection.release.raw.path);
	if (mode === "missing-initial") f.retained.delete(value.projection.initial.raw.path);
	if (mode === "missing-wrapper") f.retained.delete("/fixture/logicalHandles");
	if (mode === "changed-record") f.retained.set("/fixture/snapshot", Buffer.from("{}"));
	expect(() => verifyOperationalInitialRetention(value.projection, f.binding, f.retained)).toThrow();
});

test("initial projection output hard limit is checked before JSON parsing", () => {
	expect(() => parseOriginalCIInitial(Buffer.alloc(9 * 1024 * 1024 + 1))).toThrow("OUTPUT_LIMIT");
});
