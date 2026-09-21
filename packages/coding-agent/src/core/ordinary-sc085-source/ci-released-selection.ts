import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	type BigIntStats,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	assertOriginalCINativeBinding,
	canonicalOriginalCIData,
	OPERATIONAL_CONTROLLER_SHA256,
	type OriginalCISelection,
	type ReceivedCIData,
} from "./ci-authority.ts";
import type { RawRef } from "./fd-slot-expectation.ts";
import { outsideFields, outsideNs, outsideRef } from "./outside-final-data.ts";

const tupleKeys = [
	"repository_id",
	"run_id",
	"run_attempt",
	"source_sha",
	"source_tree",
	"control_sha",
	"workflow_sha",
	"recipe_sha256",
	"manifest_sha256",
] as const;
const digest = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
interface ReleasedRecord {
	raw: RawRef;
	value: Record<string, unknown>;
}
interface HeldNativeSelection {
	instruction: RawRef;
	native: { decision: RawRef; receiving: RawRef; profile: RawRef };
}

/** Pure correspondence only. Protected original-file custody and the unchanged
 * live helper are BOTH still required. This does not issue or authenticate a grant. */
export function joinReleasedCISelection(
	selected: HeldNativeSelection,
	context: ReleasedRecord,
	entry: ReleasedRecord,
	release: ReleasedRecord,
): OriginalCISelection {
	const c = context.value,
		e = entry.value,
		r = release.value;
	outsideFields(c, "version kind receiving entry release controller clock directory");
	outsideFields(
		e,
		"version kind receiving reservation controllerSource selectedRelease child execution clock runId resourceEpoch allocation profileSha256 aggregate directory binding",
	);
	outsideFields(
		r,
		"version kind entry captureSha256 initial authorizationId wrapper issuanceLink releasedNs releasedWallSeconds",
	);
	assert(
		c.version === 1 &&
			c.kind === "original-ci-operational-context" &&
			e.version === 1 &&
			e.kind === "original-ci-operational-entry" &&
			r.version === 1 &&
			r.kind === "original-ci-operational-release",
		"OPS_CI_RELEASED_KIND",
	);
	for (const value of [c.receiving, e.receiving])
		assert.deepEqual(value, selected.native.receiving, "OPS_CI_RELEASED_RECEIVING");
	assert.deepEqual(c.entry, entry.raw, "OPS_CI_RELEASED_ENTRY");
	assert.deepEqual(r.entry, entry.raw, "OPS_CI_RELEASED_ENTRY");
	assert.deepEqual(c.release, release.raw, "OPS_CI_RELEASED_RELEASE");
	assert.deepEqual(c.directory, e.directory, "OPS_CI_RELEASED_DIRECTORY");
	assert.deepEqual(c.clock, e.clock, "OPS_CI_RELEASED_CLOCK");
	outsideFields(r.wrapper, "version kind authorization_id release_sha256 authorization manifest_sha256");
	const wrapper = r.wrapper;
	outsideFields(
		wrapper.authorization,
		"repository_id source_sha source_tree control_sha workflow_sha run_id run_attempt recipe_sha256 release_sha256 issued_at expires_at manifest operational_binding",
	);
	const auth = wrapper.authorization;
	assert(
		wrapper.version === 1 &&
			wrapper.kind === "original-ci-operational-authorization" &&
			typeof r.authorizationId === "string" &&
			/^[a-f0-9]{64}$/.test(r.authorizationId) &&
			wrapper.authorization_id === r.authorizationId &&
			digest(canonicalOriginalCIData(auth)) === r.authorizationId,
		"OPS_CI_RELEASED_AUTHORIZATION_HASH",
	);
	outsideFields(e.selectedRelease, "sha256 controlSha");
	assert(
		typeof e.selectedRelease.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(e.selectedRelease.sha256) &&
			wrapper.release_sha256 === e.selectedRelease.sha256 &&
			auth.release_sha256 === e.selectedRelease.sha256 &&
			auth.control_sha === e.selectedRelease.controlSha,
		"OPS_CI_RELEASED_SELECTED_RELEASE",
	);
	outsideRef(e.controllerSource);
	assert(
		e.controllerSource.sha256 === OPERATIONAL_CONTROLLER_SHA256 &&
			e.controllerSource.path === `/opt/smarty-ci-candidate/releases/${e.selectedRelease.sha256}/candidate-run.py`,
		"OPS_CI_RELEASED_CONTROLLER",
	);
	assert(e.binding && typeof e.binding === "object" && !Array.isArray(e.binding), "OPS_CI_RELEASED_BINDING");
	const binding = e.binding as Record<string, unknown>;
	const expected = {} as Record<(typeof tupleKeys)[number], string>;
	for (const key of tupleKeys) {
		assert(typeof binding[key] === "string" && binding[key].length > 0, "OPS_CI_RELEASED_TUPLE");
		expected[key] = binding[key];
		assert.equal(
			key === "manifest_sha256" ? digest(canonicalOriginalCIData(auth.manifest)) : auth[key],
			expected[key],
			"OPS_CI_RELEASED_TUPLE",
		);
	}
	assert.equal(wrapper.manifest_sha256, expected.manifest_sha256, "OPS_CI_RELEASED_MANIFEST");
	assert(
		auth.operational_binding &&
			typeof auth.operational_binding === "object" &&
			!Array.isArray(auth.operational_binding),
		"OPS_CI_RELEASED_OPERATIONAL_BINDING",
	);
	const operational = auth.operational_binding as Record<string, unknown>;
	assert(
		operational.version === 1 && operational.namespace === "sense-operational-pi" && operational.fd_slot_bound,
		"OPS_CI_RELEASED_OPERATIONAL_BINDING",
	);
	assert.deepEqual(operational.instruction, selected.instruction, "OPS_CI_RELEASED_INSTRUCTION");
	assertOriginalCINativeBinding(operational.native);
	for (const key of ["decision", "receiving", "profile"] as const)
		assert.deepEqual(operational.native[key], selected.native[key], "OPS_CI_RELEASED_NATIVE");
	assert.equal(operational.operational_run_id, e.runId, "OPS_CI_RELEASED_RUN");
	assert.equal(e.profileSha256, selected.native.profile.sha256, "OPS_CI_RELEASED_PROFILE");
	return structuredClone({
		controller: e.controllerSource,
		authorizationId: r.authorizationId,
		releaseSha256: e.selectedRelease.sha256,
		expected,
	});
}

/** Same existing readonly directory/records as Resource _operational_entry_record.
 * Resolves DATA once for the first guarded initial receive. No STATE access,
 * extra helper, CLI variant, caller reader or long-lived additional descriptor.
 * The unchanged helper must authenticate the selected actual ID before admission. */
export function readReleasedCISelection(selected: HeldNativeSelection) {
	for (const ref of [selected.instruction, ...Object.values(selected.native)]) outsideRef(ref);
	const parent = dirname(selected.native.receiving.path);
	const ancestry = new Map<string, { device: bigint; inode: bigint; mode: bigint; uid: bigint }>();
	for (let path = parent; ; path = dirname(path)) {
		const s = lstatSync(path, { bigint: true });
		assert(s.isDirectory() && s.uid === 0n && !(s.mode & 0o022n), "OPS_CI_RELEASED_ANCESTRY");
		if (path === parent) assert((s.mode & 0o7777n) === 0o555n, "OPS_CI_RELEASED_DIRECTORY_MODE");
		ancestry.set(path, { device: s.dev, inode: s.ino, mode: s.mode, uid: s.uid });
		if (path === "/") break;
	}
	const directory = ancestry.get(parent)!;
	const checkAncestry = () => {
		for (const [path, expected] of ancestry) {
			const s = lstatSync(path, { bigint: true });
			assert.deepEqual(
				{ device: s.dev, inode: s.ino, mode: s.mode, uid: s.uid },
				expected,
				"OPS_CI_RELEASED_DIRECTORY_CHANGED",
			);
		}
	};
	const identity = (s: BigIntStats) => ({
		dev: s.dev,
		ino: s.ino,
		uid: s.uid,
		gid: s.gid,
		mode: s.mode,
		nlink: s.nlink,
		size: s.size,
		mtimeNs: s.mtimeNs,
		ctimeNs: s.ctimeNs,
	});
	const read = (name: string) => {
		checkAncestry();
		const path = join(parent, name);
		// Node opens descriptors close-on-exec; no inheritable descriptor is passed
		// to receive-operational. Close is consumed once even after a read failure.
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		let result: { raw: RawRef; value: Record<string, unknown>; identity: ReturnType<typeof identity> } | undefined;
		const errors: unknown[] = [];
		try {
			const before = fstatSync(fd, { bigint: true });
			assert(
				before.isFile() &&
					before.uid === 0n &&
					before.nlink === 1n &&
					(before.mode & 0o7777n) === 0o444n &&
					before.size > 0n &&
					before.size <= 2n * 1024n * 1024n,
				"OPS_CI_RELEASED_FILE",
			);
			const body = Buffer.alloc(Number(before.size));
			for (let at = 0; at < body.length; ) {
				const n = readSync(fd, body, at, body.length - at, at);
				assert(n > 0, "OPS_CI_RELEASED_SHORT_READ");
				at += n;
			}
			assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, body.length), 0, "OPS_CI_RELEASED_FILE_GREW");
			for (const now of [fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })])
				assert.deepEqual(identity(now), identity(before), "OPS_CI_RELEASED_FILE_CHANGED");
			checkAncestry();
			const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
			assert(value && typeof value === "object" && !Array.isArray(value), "OPS_CI_RELEASED_OBJECT");
			result = {
				raw: { path, sha256: digest(body) },
				value: value as Record<string, unknown>,
				identity: identity(before),
			};
		} catch (cause) {
			errors.push(cause);
		}
		try {
			closeSync(fd);
		} catch (cause) {
			errors.push(cause);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length) throw new AggregateError(errors, "OPS_CI_RELEASED_READ_CLOSE", { cause: errors[0] });
		return result!;
	};
	const context = read("ordinary-operational-context.json"),
		entry = read("ordinary-operational-entry.json"),
		release = read("ordinary-operational-release.json");
	assert.deepEqual(
		entry.value.directory,
		{ device: String(directory.device), inode: String(directory.inode) },
		"OPS_CI_RELEASED_DIRECTORY",
	);
	const selection = joinReleasedCISelection(selected, context, entry, release);
	assert(
		context.value.clock && typeof context.value.clock === "object" && !Array.isArray(context.value.clock),
		"OPS_CI_RELEASED_CLOCK",
	);
	const clock = context.value.clock as Record<string, unknown>;
	const wrapperSha256 = digest(canonicalOriginalCIData(release.value.wrapper));
	const snapshots = (
		[
			["ordinary-operational-context.json", context],
			["ordinary-operational-entry.json", entry],
			["ordinary-operational-release.json", release],
		] as const
	).map(([name, record]) => ({ name, raw: record.raw, identity: record.identity }));
	const check = (received?: ReceivedCIData, operation = "preflight") => {
		if (received !== undefined)
			assert.equal(digest(canonicalOriginalCIData(received)), wrapperSha256, "OPS_CI_RELEASED_WRAPPER");
		const ns = statSync("/proc/self/ns/time", { bigint: true });
		assert(
			clock.clock === "CLOCK_MONOTONIC" &&
				readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() === clock.bootId,
			"OPS_CI_RELEASED_CLOCK_IDENTITY",
		);
		assert.deepEqual(
			clock.timeNamespace,
			{ device: String(ns.dev), inode: String(ns.ino) },
			"OPS_CI_RELEASED_CLOCK_IDENTITY",
		);
		const cutoff = outsideNs(clock[operation === "preflight" ? "workloadDeadlineNs" : "bodyDeadlineNs"]);
		const checkDeadline = () => {
			const now = process.hrtime.bigint();
			assert(outsideNs(clock.startedNs) <= now && now < cutoff, "OPS_CI_RELEASED_DEADLINE");
		};
		checkDeadline();
		for (const expected of snapshots) {
			const current = read(expected.name);
			assert.deepEqual(current.raw, expected.raw, "OPS_CI_RELEASED_REBOUND");
			assert.deepEqual(current.identity, expected.identity, "OPS_CI_RELEASED_REBOUND");
			checkDeadline();
		}
	};
	check();
	return { selection, release: release.raw, check };
}
