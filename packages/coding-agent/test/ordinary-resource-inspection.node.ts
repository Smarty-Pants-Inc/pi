import assert from "node:assert/strict";
import { test } from "node:test";
import { type NativeResourceObservation, recordResourceInspection } from "../src/core/ordinary-resource-inspection.ts";

const identity = { ownerEpoch: "native-epoch", sessionId: "session", allocationId: "allocation" };
const ref = { path: "current.json", sha256: "a".repeat(64) };
function fixture(): NativeResourceObservation & { sessionId: string } {
	return {
		descriptor: 9,
		device: 17,
		inode: 1234,
		nofileSoft: "64",
		nofileHard: "128",
		realtimeSeconds: "1789584000",
		realtimeNanoseconds: 12,
		ownerEpoch: identity.ownerEpoch,
		allocationId: identity.allocationId,
		sessionId: identity.sessionId,
		profileSha256: "b".repeat(64),
		hostInvocation: "c".repeat(32),
	};
}
// Synthetic native reader/recorder only. No descriptors, cgroups, limits or files are accessed.
test("retains actual current facts without inventing original resource scope or pre-exec proof", () => {
	const native = fixture();
	let reads = 0;
	const result = recordResourceInspection(
		identity,
		() => {
			reads++;
			return native;
		},
		(facts) => {
			assert.deepEqual(facts, {
				kind: "ordinary-operational-resource-current/1",
				nativeIdentity: identity,
				aggregate: { descriptor: 9, device: 17, inode: 1234 },
				nofile: { soft: "64", hard: "128" },
				observation: {
					source: "native-held-host-cgroup/fstat/fstatfs/getrlimit",
					clock: "CLOCK_REALTIME",
					seconds: "1789584000",
					nanoseconds: 12,
				},
				profileSha256: "b".repeat(64),
				hostInvocation: "c".repeat(32),
			});
			return ref;
		},
	);
	assert.equal(reads, 2);
	assert.equal(result.lifetime, "borrowed-until-original-host-release");
	assert.deepEqual(result.current, { nofile: { soft: "64", hard: "128" }, raw: ref });
	assert.equal(result.preexec, null);
	assert.deepEqual(result.original, { scope: null, epoch: null, enforcement: null, initialFd: null });
	for (const key of ["scope", "epoch", "enforcement", "initialFd"] as const) assert.ok(result.unavailable[key]);
	assert.ok(Object.isFrozen(result.aggregate));
	assert.ok(Object.isFrozen(result.current.raw));
});

test("keeps infinity and exact large u64 limits, never coerces them to a finite bound", () => {
	for (const value of ["infinity", "18446744073709551614"]) {
		const native = { ...fixture(), nofileSoft: value, nofileHard: value };
		assert.equal(
			recordResourceInspection(
				identity,
				() => native,
				() => ref,
			).current.nofile.hard,
			value,
		);
	}
});

test("unsafe or invalid aggregate identities refuse before recorder", () => {
	for (const patch of [
		{ device: 9007199254740992 },
		{ inode: 1.1 },
		{ descriptor: -1 },
		{ descriptor: 2147483648 },
		{ ownerEpoch: "foreign" },
		{ allocationId: "foreign" },
	]) {
		assert.throws(
			() =>
				recordResourceInspection(
					identity,
					() => ({ ...fixture(), ...patch }),
					() => assert.fail("recorder ran"),
				),
			/RESOURCE_IDENTITY/,
		);
	}
});

test("missing, malformed, overflowing or contradictory current limits never become defaults", () => {
	for (const value of ["", "01", "-1", "1.5", "18446744073709551616"]) {
		assert.throws(
			() =>
				recordResourceInspection(
					identity,
					() => ({ ...fixture(), nofileSoft: value }),
					() => ref,
				),
			/RESOURCE_NOFILE/,
		);
	}
	assert.throws(
		() =>
			recordResourceInspection(
				identity,
				() => ({ ...fixture(), nofileSoft: "infinity" }),
				() => ref,
			),
		/RESOURCE_NOFILE/,
	);
	assert.throws(
		() =>
			recordResourceInspection(
				identity,
				() => ({ ...fixture(), nofileSoft: "129" }),
				() => ref,
			),
		/RESOURCE_NOFILE/,
	);
});

test("native observation errors and recorder errors preserve their original causes", () => {
	const cause = new Error("original native/recorder refusal");
	assert.throws(
		() =>
			recordResourceInspection(
				identity,
				() => {
					throw cause;
				},
				() => ref,
			),
		(error) => error === cause,
	);
	assert.throws(
		() =>
			recordResourceInspection(identity, fixture, () => {
				throw cause;
			}),
		(error) => error === cause,
	);
});

test("post-recorder owner loss and descriptor replacement refuse the borrowed result", () => {
	let active = true;
	assert.throws(
		() =>
			recordResourceInspection(
				identity,
				() => {
					if (!active) throw new Error("original owner released");
					return fixture();
				},
				() => {
					active = false;
					return ref;
				},
			),
		/original owner released/,
	);
	const native = fixture();
	assert.throws(
		() =>
			recordResourceInspection(
				identity,
				() => native,
				() => {
					native.inode++;
					return ref;
				},
			),
		/CUSTODY_CHANGED/,
	);
});

test("invalid recorder refs and reentrant ref access cannot bypass the final owner check", () => {
	assert.throws(() => recordResourceInspection(identity, fixture, () => ({ ...ref, sha256: "bad" })), /CURRENT_REF/);
	let active = true;
	assert.throws(
		() =>
			recordResourceInspection(
				identity,
				() => {
					if (!active) throw new Error("released by ref getter");
					return fixture();
				},
				() => ({
					get path() {
						active = false;
						return ref.path;
					},
					sha256: ref.sha256,
				}),
			),
		/released by ref getter/,
	);
});

test("RESOURCE R2 formatter: retained reader session wins over extra supplied identity data", () => {
	const supplied = { ...identity, sessionId: "foreign-session" };
	const result = recordResourceInspection(supplied, fixture, (facts) => {
		assert.equal((facts as { nativeIdentity: { sessionId: string } }).nativeIdentity.sessionId, identity.sessionId);
		return ref;
	});
	assert.equal(result.nativeIdentity.sessionId, identity.sessionId);
});

test("RESOURCE R2 formatter: absent or changed retained session refuses", () => {
	assert.throws(
		() =>
			recordResourceInspection(
				identity,
				() => ({ ...fixture(), sessionId: "" }),
				() => assert.fail("recorder ran"),
			),
		/RESOURCE_IDENTITY/,
	);
	const native = fixture();
	assert.throws(
		() =>
			recordResourceInspection(
				identity,
				() => native,
				() => {
					native.sessionId = "foreign-session";
					return ref;
				},
			),
		/CUSTODY_CHANGED/,
	);
});

test("invalid native timestamp refuses rather than substituting recorder time", () => {
	for (const patch of [{ realtimeSeconds: "-1" }, { realtimeNanoseconds: 1_000_000_000 }]) {
		assert.throws(
			() =>
				recordResourceInspection(
					identity,
					() => ({ ...fixture(), ...patch }),
					() => ref,
				),
			/RESOURCE_CLOCK/,
		);
	}
});
