import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	type BigIntStats,
	constants as C,
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import { parseOrdinaryOwnerReceiving, parseOrdinaryOwnerRecord } from "../ordinary-owner-policy.ts";
import {
	assertOriginalCINativeBinding,
	canonicalOriginalCIData,
	OPERATIONAL_CONTROLLER_SHA256,
	type OperationalBinding,
	type OriginalCISelection,
} from "./ci-authority.ts";
import type { RawRef } from "./fd-slot-expectation.ts";
import type { IndependentlyAdmittedFdSlotPreflight } from "./fd-slot-preflight.ts";
import { parseOperationalEpochSource, verifyOperationalInitialRetention } from "./operational-admission.ts";
import {
	decodeOutsideFinal,
	decodeOutsideStaged,
	type OriginalOutsideFinalData,
	type OriginalOutsideGraphSelection,
	type OriginalOutsideStagedData,
	type OriginalOutsideTerminalSelection,
	outsideFields,
	outsideNs,
	outsideRef,
} from "./outside-final-data.ts";
import {
	receiveOperationalFinalGraphData,
	receiveOperationalTerminalData,
} from "./references/sense/outside-final/operational-staging.ts";
import type { OperationalFinalTailAdmission, OperationalSourceAccountingInput } from "./source-contracts.ts";

const STATE = "/var/lib/smarty-ci-candidate-stage-v1";
const attempts = new Set<string>();
const sha = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const json = (body: Uint8Array): Record<string, unknown> => {
	const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	assert(value && typeof value === "object" && !Array.isArray(value), "OPS_OUTSIDE_OBJECT");
	return value as Record<string, unknown>;
};
const identity = (s: BigIntStats) => ({
	device: s.dev,
	inode: s.ino,
	uid: s.uid,
	gid: s.gid,
	mode: s.mode,
	size: s.size,
	links: s.nlink,
	modified: s.mtimeNs,
	changed: s.ctimeNs,
});

export interface OriginalOutsideFinalSelection {
	/** The SAME original authenticated selection, not values from child stdout. */
	authority: OriginalCISelection;
	/** Actual _stage_candidate_files result and active owner, retained until close. */
	job: string;
	owner: string;
	initialRelease: RawRef;
}
export interface OriginalOutsideOriginalData {
	authorization: RawRef;
	instruction: RawRef;
	publicEntry: RawRef;
	initialRelease: RawRef;
	initialEnvelope: RawRef;
	/** Actual field of the retained authorization, not an invented raw record. */
	preflight: IndependentlyAdmittedFdSlotPreflight;
	finalTail: OperationalFinalTailAdmission;
	sourceAccounting: OperationalSourceAccountingInput;
	graph: Omit<OriginalOutsideGraphSelection, "final">;
	terminal: OriginalOutsideTerminalSelection;
}
export interface OriginalOutsideFinalReceiver {
	readonly original: OriginalOutsideOriginalData;
	/** Called once with the already LOG_LIMIT-charged offer from original output.
	 * Resource owns partial/duplicate/missing/oversize and original deadline checks.
	 * Calling this on a parsed offer does NOT authenticate its producer. The
	 * prebound child-root handle, original instruction and recorder do that. */
	receiveStaged(offer: unknown): OriginalOutsideStagedData;
	/** Only actual state.final_call_ref and state.final_return_ref, after finalize. */
	receiveFinal(refs: { call: RawRef; returned: RawRef }): OriginalOutsideFinalData;
	readonly retained: ReadonlyMap<string, Uint8Array>;
	failure(): unknown;
	close(): void;
}

/** Root-side read-only receiver. Bind before output selection, while the original
 * captured child and root namespace are still available. It never executes the
 * controller, checks a spent grant, retires a worker, or creates a final result.
 * This root process must be the captured controller or its direct child in the
 * SAME service. Keeping its handle is not native/lifecycle qualification.
 * Resource alone keeps the active slot and mounts through receiving and cleanup.
 */
export function createOperationalOutsideFinal(input: OriginalOutsideFinalSelection): OriginalOutsideFinalReceiver {
	assert(process.platform === "linux" && process.geteuid?.() === 0, "OPS_OUTSIDE_ORIGINAL_ROOT_REQUIRED");
	const selected = structuredClone(input);
	outsideFields(selected, "authority job owner initialRelease");
	outsideFields(selected.authority, "controller authorizationId releaseSha256 expected");
	outsideFields(
		selected.authority.expected,
		"repository_id run_id run_attempt source_sha source_tree control_sha workflow_sha recipe_sha256 manifest_sha256",
	);
	assert(
		new RegExp(`^${STATE}/jobs/[a-f0-9]{32}$`).test(selected.job) &&
			typeof selected.owner === "string" &&
			/^[A-Za-z0-9_.@:-]+\.service$/.test(selected.owner),
		"OPS_OUTSIDE_ORIGINAL_JOB",
	);
	outsideRef(selected.initialRelease);
	outsideRef(selected.authority.controller);
	assert(
		/^[a-f0-9]{64}$/.test(selected.authority.authorizationId) &&
			/^[a-f0-9]{64}$/.test(selected.authority.releaseSha256),
		"OPS_OUTSIDE_AUTHORIZATION",
	);
	assert(!attempts.has(selected.job), "OPS_OUTSIDE_ORIGINAL_ONCE");
	attempts.add(selected.job);
	let childRoot: number | undefined, recorderDirectory: number | undefined;
	let failed: { cause: unknown } | undefined;
	let busy = true,
		closed = false,
		stageAttempted = false,
		finalAttempted = false;
	let staged: OriginalOutsideStagedData | undefined;
	let budget: { root: string; maxBytes: number; maxRecords: number } | undefined;
	let bytesTotal = 0,
		overheadBytes = 0;
	let deadline: bigint | undefined;
	const checkDeadline = () => {
		if (deadline !== undefined) assert(process.hrtime.bigint() < deadline, "OPS_OUTSIDE_ORIGINAL_DEADLINE");
	};
	const retained = new Map<string, Buffer>(),
		references = new Map<string, RawRef>();
	const remember = (cause: unknown) => {
		failed ??= { cause };
		return failed.cause;
	};
	const usable = () => {
		if (failed !== undefined) throw failed.cause;
		assert(!closed, "OPS_OUTSIDE_CLOSED");
	};
	const put = (reference: RawRef, body: Uint8Array) => {
		checkDeadline();
		outsideRef(reference);
		assert.equal(sha(body), reference.sha256, "OPS_OUTSIDE_RAW_PIN");
		const previous = retained.get(reference.path);
		if (previous) {
			assert.deepEqual(references.get(reference.path), reference, "OPS_OUTSIDE_REBOUND");
			assert(previous.equals(body), "OPS_OUTSIDE_REBOUND");
			return;
		}
		if (budget)
			assert(
				references.size < budget.maxRecords && body.byteLength <= budget.maxBytes - bytesTotal - overheadBytes,
				"OPS_OUTSIDE_EXISTING_RECORDER_BUDGET",
			);
		retained.set(reference.path, Buffer.from(body));
		references.set(reference.path, { ...reference });
		bytesTotal += body.byteLength;
	};
	// Exact immutable root files, with the original mutable active/context exception.
	// Bounds below are existing Resource/initial protocol bounds, not a new grant.
	const rootAncestry = (path: string) => {
		assert(isAbsolute(path) && normalize(path) === path && !/[\u0000-\u001f\u007f]/.test(path), "OPS_OUTSIDE_PATH");
		const ancestry = new Map<string, { device: bigint; inode: bigint; uid: bigint; mode: bigint }>();
		for (let parent = dirname(path); ; parent = dirname(parent)) {
			const s = lstatSync(parent, { bigint: true });
			assert(s.isDirectory() && s.uid === 0n && !(s.mode & 0o022n), "OPS_OUTSIDE_ROOT_ANCESTRY");
			ancestry.set(parent, { device: s.dev, inode: s.ino, uid: s.uid, mode: s.mode });
			if (parent === "/") break;
		}
		return () => {
			for (const [parent, expected] of ancestry) {
				const s = lstatSync(parent, { bigint: true });
				assert.deepEqual(
					{ device: s.dev, inode: s.ino, uid: s.uid, mode: s.mode },
					expected,
					"OPS_OUTSIDE_ROOT_ANCESTRY_CHANGED",
				);
			}
		};
	};
	const rootRead = (path: string, limit = 65536, mutable = false): Buffer => {
		checkDeadline();
		const checkAncestry = rootAncestry(path);
		const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
		try {
			const before = fstatSync(fd, { bigint: true });
			assert(
				before.isFile() &&
					before.uid === 0n &&
					before.nlink === 1n &&
					!(before.mode & (mutable ? 0o022n : 0o222n)) &&
					before.size > 0n &&
					before.size <= BigInt(limit),
				"OPS_OUTSIDE_ROOT_FILE",
			);
			const body = Buffer.alloc(Number(before.size));
			for (let at = 0; at < body.length; ) {
				const n = readSync(fd, body, at, body.length - at, at);
				assert(n > 0, "OPS_OUTSIDE_SHORT_READ");
				at += n;
			}
			assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, body.length), 0, "OPS_OUTSIDE_FILE_GREW");
			for (const s of [fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })])
				assert.deepEqual(identity(s), identity(before), "OPS_OUTSIDE_ROOT_CHANGED");
			checkAncestry();
			checkDeadline();
			return body;
		} finally {
			closeSync(fd);
		}
	};
	const pinned = (ref: RawRef, limit = 65536) => {
		outsideRef(ref);
		const body = rootRead(ref.path, limit);
		put(ref, body);
		return body;
	};
	// Executable/control custody is NOT a semantic retained record. Stream the
	// selected immutable controller under the original deadline; do not inflate
	// the 64-KiB records or the 96-record/2-MiB initial inventory to fit source.
	const pinController = (deadline: bigint) => {
		const ref = selected.authority.controller,
			checkAncestry = rootAncestry(ref.path);
		const fd = openSync(ref.path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
		try {
			const before = fstatSync(fd, { bigint: true });
			assert(
				before.isFile() &&
					before.uid === 0n &&
					before.nlink === 1n &&
					!(before.mode & 0o222n) &&
					before.size > 0n &&
					before.size <= BigInt(Number.MAX_SAFE_INTEGER),
				"OPS_OUTSIDE_CONTROLLER_FILE",
			);
			const chunk = Buffer.alloc(65536),
				hash = createHash("sha256");
			let position = 0;
			while (position < Number(before.size)) {
				assert(process.hrtime.bigint() < deadline, "OPS_OUTSIDE_ORIGINAL_DEADLINE");
				const n = readSync(fd, chunk, 0, Math.min(chunk.length, Number(before.size) - position), position);
				assert(n > 0, "OPS_OUTSIDE_CONTROLLER_SHORT_READ");
				hash.update(chunk.subarray(0, n));
				position += n;
			}
			assert.equal(readSync(fd, chunk, 0, 1, position), 0, "OPS_OUTSIDE_CONTROLLER_GREW");
			for (const now of [fstatSync(fd, { bigint: true }), lstatSync(ref.path, { bigint: true })])
				assert.deepEqual(identity(now), identity(before), "OPS_OUTSIDE_CONTROLLER_CHANGED");
			checkAncestry();
			assert.equal(hash.digest("hex"), ref.sha256, "OPS_OUTSIDE_CONTROLLER_PIN");
		} finally {
			closeSync(fd);
		}
	};
	let sourceRead = pinned;
	let retainedOnly = false;
	const bytes = (ref: RawRef): Buffer => {
		checkDeadline();
		outsideRef(ref);
		const existing = retained.get(ref.path);
		assert(existing || !retainedOnly, "OPS_OUTSIDE_ORIGINAL_RECORD_NOT_RETAINED");
		const body = existing ?? sourceRead(ref);
		assert.equal(sha(body), ref.sha256, "OPS_OUTSIDE_RETAINED_PIN");
		return Buffer.from(body);
	};
	const record = (ref: unknown) => {
		outsideRef(ref);
		return json(bytes(ref));
	};
	const close = () => {
		if (busy) throw remember(new Error("OPS_OUTSIDE_REENTRY"));
		if (closed) return;
		closed = true;
		const failures: unknown[] = [];
		for (const fd of [recorderDirectory, childRoot])
			if (fd !== undefined)
				try {
					closeSync(fd);
				} catch (cause) {
					failures.push(cause);
				}
		recorderDirectory = childRoot = undefined;
		if (failures.length) throw remember(new AggregateError(failures, "OPS_OUTSIDE_CLOSE_UNKNOWN"));
	};
	try {
		assert(
			selected.authority.controller.sha256 === OPERATIONAL_CONTROLLER_SHA256 &&
				/^\/opt\/smarty-ci-candidate\/releases\/[a-f0-9]{64}\/candidate-run\.py$/.test(
					selected.authority.controller.path,
				),
			"OPS_OUTSIDE_CONTROLLER_SELECTION",
		);
		const authRef = {
			path: `${STATE}/authorizations/${selected.authority.authorizationId}.json`,
			sha256: selected.authority.authorizationId,
		};
		const authorization = record(authRef);
		for (const [key, value] of Object.entries(selected.authority.expected))
			if (key !== "manifest_sha256") assert.equal(authorization[key], value, "OPS_OUTSIDE_ISSUER_TUPLE");
		assert.equal(
			sha(canonicalOriginalCIData(authorization.manifest)),
			selected.authority.expected.manifest_sha256,
			"OPS_OUTSIDE_ISSUER_MANIFEST",
		);
		assert.equal(authorization.release_sha256, selected.authority.releaseSha256, "OPS_OUTSIDE_ISSUER_RELEASE");
		const binding = authorization.operational_binding as OperationalBinding;
		assert(
			binding && binding.version === 1 && binding.namespace === "sense-operational-pi" && binding.fd_slot_bound,
			"OPS_OUTSIDE_ISSUED_BINDING",
		);
		assertOriginalCINativeBinding(binding.native, true);
		const contextBytes = rootRead(`${selected.job}/execution-context.json`, 4 * 1024 * 1024, true),
			context = json(contextBytes);
		outsideFields(context, "issuer inputs");
		outsideFields(context.issuer, "authorization_id authorization issuer_intent_sha256 issuer_binding");
		assert.equal(
			context.issuer.authorization_id,
			selected.authority.authorizationId,
			"OPS_OUTSIDE_JOB_AUTHORIZATION",
		);
		assert.deepEqual(context.issuer.authorization, authorization, "OPS_OUTSIDE_JOB_AUTHORIZATION");
		const intent = record({
			path: `/run/smarty-ci-candidate-delivery/${authorization.repository_id}/${authorization.run_id}/${authorization.run_attempt}.intent.json`,
			sha256: String(context.issuer.issuer_intent_sha256),
		});
		outsideFields(intent, "authorization_id binding manifest_sha256");
		assert.equal(intent.authorization_id, selected.authority.authorizationId, "OPS_OUTSIDE_ISSUER_INTENT");
		assert.equal(intent.manifest_sha256, selected.authority.expected.manifest_sha256, "OPS_OUTSIDE_ISSUER_INTENT");
		assert.deepEqual(intent.binding, context.issuer.issuer_binding, "OPS_OUTSIDE_ISSUER_INTENT");
		const activeBytes = rootRead(`${STATE}/active.json`, 65536, true),
			active = json(activeBytes);
		assert(
			active.job === selected.job &&
				active.owner === selected.owner &&
				Array.isArray(active.mounts) &&
				active.mounts.length > 0,
			"OPS_OUTSIDE_ACTIVE_SLOT",
		);
		const releaseBytes = pinned(selected.initialRelease, 2 * 1024 * 1024),
			release = json(releaseBytes);
		outsideFields(
			release,
			"version kind entry captureSha256 initial authorizationId wrapper issuanceLink releasedNs releasedWallSeconds",
		);
		assert(
			release.version === 1 &&
				release.kind === "original-ci-operational-release" &&
				release.authorizationId === selected.authority.authorizationId,
			"OPS_OUTSIDE_ORIGINAL_RELEASE",
		);
		const wrapper = release.wrapper;
		outsideFields(wrapper, "version kind authorization_id release_sha256 authorization manifest_sha256");
		assert(
			wrapper.version === 1 &&
				wrapper.kind === "original-ci-operational-authorization" &&
				wrapper.authorization_id === selected.authority.authorizationId &&
				wrapper.release_sha256 === selected.authority.releaseSha256 &&
				wrapper.manifest_sha256 === selected.authority.expected.manifest_sha256,
			"OPS_OUTSIDE_ORIGINAL_WRAPPER",
		);
		assert.deepEqual(wrapper.authorization, authorization, "OPS_OUTSIDE_ORIGINAL_WRAPPER");
		assert.equal(
			selected.initialRelease.path,
			`${dirname(binding.native.receiving.path)}/ordinary-operational-release.json`,
			"OPS_OUTSIDE_ORIGINAL_RELEASE_PATH",
		);
		outsideRef(release.initial);
		const initialBytes = pinned(release.initial, 4 * 1024 * 1024),
			initial = json(initialBytes);
		assert(Array.isArray(initial.records) && initial.records.length <= 96, "OPS_INITIAL_RECORD_COUNT");
		let initialTotal = 0;
		const initialPaths = new Set<string>();
		for (const row of initial.records) {
			outsideFields(row, "raw base64");
			outsideRef(row.raw);
			assert(
				typeof row.base64 === "string" && row.base64.length <= 4 * Math.ceil((2 * 1024 * 1024 - initialTotal) / 3),
				"OPS_INITIAL_RECORD_ENCODING",
			);
			const body = Buffer.from(row.base64, "base64");
			initialTotal += body.length;
			assert(
				body.toString("base64") === row.base64 &&
					body.length > 0 &&
					body.length <= 65536 &&
					initialTotal <= 2 * 1024 * 1024 &&
					!initialPaths.has(row.raw.path),
				"OPS_INITIAL_RECORD_RETENTION",
			);
			initialPaths.add(row.raw.path);
			put(row.raw, body);
		}
		verifyOperationalInitialRetention(
			{
				release: { raw: selected.initialRelease, bytes: releaseBytes },
				initial: { raw: release.initial, bytes: initialBytes },
			},
			binding,
			retained,
		);
		const link = record(release.issuanceLink);
		outsideRef(release.issuanceLink);
		assert.equal(
			release.issuanceLink.path,
			`${STATE}/management/operational-link-${selected.authority.authorizationId}.json`,
			"OPS_OUTSIDE_ISSUANCE_LINK_PATH",
		);
		assert.deepEqual(json(pinned(release.issuanceLink)), link, "OPS_OUTSIDE_ISSUANCE_LINK_CUSTODY");
		outsideRef(link.reservation);
		const reservation = record(link.reservation),
			capture = record(link.capture);
		assert.deepEqual(
			reservation.selectedRelease,
			{ sha256: selected.authority.releaseSha256, controlSha: selected.authority.expected.control_sha },
			"OPS_OUTSIDE_RESERVED_RELEASE",
		);
		// The released entry and reservation, not an immutable instruction copy,
		// select the actual full issuer tuple. Initial retention already joins their
		// full binding, capture/child and release. No continuation-context read here:
		// Resource deliberately withholds it until this prebind completes.
		const releasedEntry = record(release.entry);
		assert.deepEqual(releasedEntry.controllerSource, selected.authority.controller, "OPS_OUTSIDE_ENTRY_CONTROLLER");
		for (const issued of [releasedEntry.binding, intent.binding]) {
			assert(issued && typeof issued === "object" && !Array.isArray(issued), "OPS_OUTSIDE_ENTRY_BINDING");
			const expectedEntries: [string, unknown][] = Object.entries(selected.authority.expected);
			for (const [key, value] of expectedEntries)
				assert.equal((issued as Record<string, unknown>)[key], value, "OPS_OUTSIDE_ENTRY_TUPLE");
		}
		const policy = record(binding.policy);
		outsideFields(
			policy.operational_prelaunch,
			"version kind phasePlan allocation resourceEpoch receiving execution constraints operationalBinding",
		);
		const prelaunch = policy.operational_prelaunch;
		outsideFields(prelaunch.constraints, "N T budget epochSource otherResources clockEvidenceRoute transport");
		outsideRef(prelaunch.constraints.clockEvidenceRoute);
		outsideFields(prelaunch.constraints.transport, "records bytes");
		for (const value of Object.values(prelaunch.constraints.transport))
			assert(typeof value === "number" && Number.isSafeInteger(value) && value > 0, "OPS_OUTSIDE_TRANSPORT_BOUND");
		assert.deepEqual(prelaunch, record(reservation.policy).operational_prelaunch, "OPS_OUTSIDE_ORIGINAL_PRELAUNCH");
		outsideFields(
			prelaunch.operationalBinding,
			"version namespace producer_schema producer_contract instruction operational_run_id native producers allowed_operations",
		);
		for (const [key, value] of Object.entries(prelaunch.operationalBinding))
			assert.deepEqual((binding as unknown as Record<string, unknown>)[key], value, "OPS_OUTSIDE_ORIGINAL_BINDING");
		for (const key of ["N", "T", "budget"] as const)
			assert.equal(binding.fd_slot_bound[key], prelaunch.constraints[key], "OPS_OUTSIDE_ORIGINAL_LIMIT");
		const epoch = record(binding.fd_slot_bound.epoch);
		assert.deepEqual(epoch.source, prelaunch.constraints.epochSource, "OPS_OUTSIDE_SELECTED_EPOCH_SOURCE");
		outsideRef(epoch.source);
		const epochSource = parseOperationalEpochSource(bytes(epoch.source));
		for (const [key, original] of [
			["repositoryId", "repository_id"],
			["runId", "run_id"],
			["attempt", "run_attempt"],
			["controlSha", "control_sha"],
			["workflowSha", "workflow_sha"],
		] as const)
			assert.equal(epochSource[key], selected.authority.expected[original], "OPS_OUTSIDE_EPOCH_TUPLE");
		for (const key of ["allocation", "resourceEpoch", "receiving", "phasePlan"] as const)
			assert.deepEqual(epochSource[key], prelaunch[key], "OPS_OUTSIDE_EPOCH_SELECTION");
		const clock = reservation.clock;
		assert(clock && typeof clock === "object" && !Array.isArray(clock), "OPS_OUTSIDE_ORIGINAL_CLOCK");
		const originalClock = clock as Record<string, unknown>;
		const checkClockIdentity = () => {
			const namespace = statSync("/proc/self/ns/time", { bigint: true });
			assert.deepEqual(
				{ device: String(namespace.dev), inode: String(namespace.ino) },
				originalClock.timeNamespace,
				"OPS_OUTSIDE_ORIGINAL_TIME_NAMESPACE",
			);
			assert.equal(
				readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
				originalClock.bootId,
				"OPS_OUTSIDE_ORIGINAL_BOOT",
			);
		};
		checkClockIdentity();
		deadline = outsideNs(originalClock.runnerJoinDeadlineNs);
		pinController(deadline);
		// These are the original route/derivation rows already retained by Resource,
		// not new clock limits, a search through evidence, or clock qualification.
		const clockRecord = (ref: unknown) => {
			outsideRef(ref);
			assert(initialPaths.has(ref.path), "OPS_OUTSIDE_CLOCK_ROUTE_NOT_RETAINED");
			return record(ref);
		};
		const clockRoute = clockRecord(prelaunch.constraints.clockEvidenceRoute);
		outsideFields(clockRoute, "version kind owner reservation receiving directory records bytes route validity");
		assert(
			clockRoute.version === 1 && clockRoute.kind === "original-ci-clock-evidence-route/1",
			"OPS_OUTSIDE_CLOCK_ROUTE_KIND",
		);
		outsideFields(
			clockRoute.reservation,
			"repository_id run_id run_attempt source_sha source_tree control_sha workflow_sha recipe_sha256 allocation resourceEpoch",
		);
		for (const [key, value] of Object.entries(selected.authority.expected)) {
			if (key === "manifest_sha256") continue;
			const pattern = ["repository_id", "run_id", "run_attempt"].includes(key)
				? /^[1-9][0-9]{0,19}$/
				: key === "recipe_sha256"
					? /^[a-f0-9]{64}$/
					: /^[a-f0-9]{40}$/;
			const actual: unknown = clockRoute.reservation[key];
			assert(typeof actual === "string" && pattern.test(actual), "OPS_OUTSIDE_CLOCK_ROUTE_TUPLE");
			assert.equal(actual, value, "OPS_OUTSIDE_CLOCK_ROUTE_TUPLE");
		}
		for (const key of ["allocation", "resourceEpoch"])
			assert.deepEqual(clockRoute.reservation[key], prelaunch[key], "OPS_OUTSIDE_CLOCK_ROUTE_RESERVATION");
		outsideRef(clockRoute.owner);
		outsideRef(clockRoute.receiving);
		assert.deepEqual(clockRoute.owner, epochSource.owner, "OPS_OUTSIDE_CLOCK_ROUTE_OWNER");
		assert.deepEqual(clockRoute.receiving, prelaunch.receiving, "OPS_OUTSIDE_CLOCK_ROUTE_RECEIVING");
		assert.deepEqual(clockRoute.receiving, binding.native.receiving, "OPS_OUTSIDE_CLOCK_ROUTE_RECEIVING");
		outsideFields(clockRoute.directory, "device inode");
		outsideNs(clockRoute.directory.device);
		assert(outsideNs(clockRoute.directory.inode) > 0n, "OPS_OUTSIDE_CLOCK_ROUTE_DIRECTORY");
		assert.deepEqual(clockRoute.directory, releasedEntry.directory, "OPS_OUTSIDE_CLOCK_ROUTE_DIRECTORY");
		const checkReceivingAncestry = rootAncestry(binding.native.receiving.path);
		const receivingDirectory = lstatSync(dirname(binding.native.receiving.path), { bigint: true });
		assert(
			receivingDirectory.isDirectory() &&
				receivingDirectory.uid === 0n &&
				(receivingDirectory.mode & 0o7777n) === 0o555n,
			"OPS_OUTSIDE_CLOCK_ROUTE_DIRECTORY",
		);
		assert.deepEqual(
			clockRoute.directory,
			{ device: String(receivingDirectory.dev), inode: String(receivingDirectory.ino) },
			"OPS_OUTSIDE_CLOCK_ROUTE_DIRECTORY",
		);
		checkReceivingAncestry();
		outsideFields(clockRoute.validity, "startNs endNs");
		assert(
			outsideNs(clockRoute.validity.startNs) < outsideNs(clockRoute.validity.endNs),
			"OPS_OUTSIDE_CLOCK_ROUTE_VALIDITY",
		);
		assert.deepEqual(
			clockRoute.validity,
			{ startNs: originalClock.startedNs, endNs: originalClock.captureReleaseDeadlineNs },
			"OPS_OUTSIDE_CLOCK_ROUTE_VALIDITY",
		);
		const derivation = clockRecord(clockRoute.route),
			clockOwner = clockRecord(clockRoute.owner);
		outsideFields(derivation, "version kind controllerSource validity stages");
		assert(
			derivation.version === 1 && derivation.kind === "original-ci-clock-evidence-derivation/1",
			"OPS_OUTSIDE_CLOCK_ROUTE_DERIVATION",
		);
		outsideRef(derivation.controllerSource);
		assert.deepEqual(
			derivation.controllerSource,
			selected.authority.controller,
			"OPS_OUTSIDE_CLOCK_ROUTE_CONTROLLER",
		);
		assert.deepEqual(
			clockOwner.controllerSource,
			selected.authority.controller,
			"OPS_OUTSIDE_CLOCK_ROUTE_CONTROLLER",
		);
		assert.deepEqual(derivation.validity, clockRoute.validity, "OPS_OUTSIDE_CLOCK_ROUTE_VALIDITY");
		outsideFields(derivation.stages, "initial guardPairs coverage failureRetention");
		const stages = Object.values(derivation.stages);
		for (const stage of stages) outsideFields(stage, "records bytes");
		for (const key of ["records", "bytes"] as const) {
			for (const row of [clockRoute, ...stages]) {
				const value = (row as Record<string, unknown>)[key];
				assert(
					typeof value === "number" && Number.isSafeInteger(value) && value > 0,
					"OPS_OUTSIDE_CLOCK_ROUTE_BOUND",
				);
			}
			assert.equal(
				stages.reduce<bigint>((sum, stage) => sum + BigInt((stage as Record<string, number>)[key]), 0n),
				BigInt(clockRoute[key] as number),
				"OPS_OUTSIDE_CLOCK_ROUTE_SUM",
			);
		}
		outsideFields(capture.controller, "serviceUnit invocationId pid startTicks");
		const controller = capture.controller;
		const controllerPid = Number(controller.pid);
		assert(
			controller.serviceUnit === selected.owner &&
				typeof controller.pid === "string" &&
				String(controllerPid) === controller.pid &&
				Number.isSafeInteger(controllerPid) &&
				controllerPid > 0 &&
				(controllerPid === process.pid || controllerPid === process.ppid) &&
				typeof controller.invocationId === "string" &&
				/^[a-f0-9]{32}$/.test(controller.invocationId),
			"OPS_OUTSIDE_ORIGINAL_SURVIVOR",
		);
		const processIdentity = (pid: number) => {
			const text = readFileSync(`/proc/${pid}/stat`, "utf8"),
				parts = text
					.slice(text.lastIndexOf(")") + 2)
					.trim()
					.split(/\s+/);
			assert(parts.length >= 20 && parts[0] !== "Z", "OPS_OUTSIDE_PROCESS_DEAD");
			return { pid, startTicks: parts[19] };
		};
		const rootController = processIdentity(controllerPid);
		assert.equal(rootController.startTicks, controller.startTicks, "OPS_OUTSIDE_CONTROLLER_REUSED");
		const cgroup = readFileSync(`/proc/${controller.pid}/cgroup`, "utf8");
		assert(
			cgroup === readFileSync("/proc/self/cgroup", "utf8") && cgroup.includes(`/${selected.owner}\n`),
			"OPS_OUTSIDE_SERVICE_CUSTODY",
		);
		const environment = readFileSync(`/proc/${controller.pid}/environ`, "utf8").split("\0");
		assert(environment.includes(`INVOCATION_ID=${controller.invocationId}`), "OPS_OUTSIDE_SERVICE_INVOCATION");
		outsideFields(capture.child, "pid startTicks");
		const child = capture.child;
		const childPid = Number(child.pid);
		assert(
			Number.isSafeInteger(childPid) && childPid > 0 && String(childPid) === child.pid,
			"OPS_OUTSIDE_ORIGINAL_CHILD",
		);
		assert.equal(processIdentity(childPid).startTicks, child.startTicks, "OPS_OUTSIDE_CHILD_REUSED");
		const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(readFileSync(`/proc/${childPid}/status`, "utf8"));
		// biome-ignore lint/complexity/useOptionalChain: The explicit guard narrows uid inside the callback.
		assert(uid && uid.slice(1).every((value) => value === uid[1]) && BigInt(uid[1]) > 0n, "OPS_OUTSIDE_CHILD_UID");
		const childUid = BigInt(uid[1]);
		// This is the kernel's root of the ACTUAL captured PID, not a caller path.
		childRoot = openSync(`/proc/${childPid}/root`, C.O_RDONLY | C.O_DIRECTORY);
		const originalRoot = lstatSync(`${selected.job}/root`, { bigint: true }),
			heldRoot = fstatSync(childRoot, { bigint: true });
		assert(
			originalRoot.isDirectory() &&
				originalRoot.uid === 0n &&
				heldRoot.dev === originalRoot.dev &&
				heldRoot.ino === originalRoot.ino,
			"OPS_OUTSIDE_STAGED_ROOT",
		);
		assert.equal(processIdentity(childPid).startTicks, child.startTicks, "OPS_OUTSIDE_CHILD_REUSED");
		sourceRead = (ref: RawRef) => {
			outsideRef(ref);
			assert(childRoot !== undefined, "OPS_OUTSIDE_ROOT_CLOSED");
			let fd = openSync(`/proc/self/fd/${childRoot}`, C.O_RDONLY | C.O_DIRECTORY);
			try {
				const parts = ref.path.split("/").slice(1);
				for (const part of parts.slice(0, -1)) {
					const next = openSync(
						`/proc/self/fd/${fd}/${part}`,
						C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK,
					);
					try {
						const s = fstatSync(next, { bigint: true });
						assert(
							(s.uid === 0n || s.uid === childUid) &&
								(!(s.mode & 0o022n) || (s.uid === 0n && !!(s.mode & 0o1000n))),
							"OPS_OUTSIDE_SOURCE_ANCESTRY",
						);
					} catch (cause) {
						closeSync(next);
						throw cause;
					}
					const previous = fd;
					fd = next;
					closeSync(previous);
				}
				const path = `/proc/self/fd/${fd}/${parts.at(-1)}`,
					file = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
				try {
					const before = fstatSync(file, { bigint: true });
					assert(
						before.isFile() &&
							(before.uid === 0n || before.uid === childUid) &&
							before.nlink === 1n &&
							!(before.mode & 0o022n) &&
							before.size > 0n &&
							before.size <= 65536n,
						"OPS_OUTSIDE_SOURCE_FILE",
					);
					const body = Buffer.alloc(Number(before.size));
					for (let at = 0; at < body.length; ) {
						const n = readSync(file, body, at, body.length - at, at);
						assert(n > 0, "OPS_OUTSIDE_SHORT_READ");
						at += n;
					}
					assert.equal(readSync(file, Buffer.alloc(1), 0, 1, body.length), 0, "OPS_OUTSIDE_FILE_GREW");
					for (const s of [fstatSync(file, { bigint: true }), lstatSync(path, { bigint: true })])
						assert.deepEqual(identity(s), identity(before), "OPS_OUTSIDE_SOURCE_CHANGED");
					put(ref, body);
					return body;
				} finally {
					closeSync(file);
				}
			} finally {
				closeSync(fd);
			}
		};
		const instruction = record(binding.instruction);
		assert(
			instruction.version === 1 &&
				instruction.operation === "sense-operational-pi" &&
				instruction.runId === binding.operational_run_id,
			"OPS_OUTSIDE_ORIGINAL_INSTRUCTION",
		);
		const admission = instruction.finalTail;
		outsideFields(admission, "owner ownerEpoch admission initial limits survivor obligations");
		assert(
			typeof admission.ownerEpoch === "string" &&
				admission.ownerEpoch.length > 0 &&
				Array.isArray(admission.obligations) &&
				admission.obligations.length > 0,
			"OPS_OUTSIDE_ADMISSION",
		);
		for (const ref of [
			admission.owner,
			admission.admission,
			admission.initial,
			admission.limits,
			admission.survivor,
		]) {
			outsideRef(ref);
			bytes(ref);
		}
		assert(
			instruction.production && typeof instruction.production === "object" && !Array.isArray(instruction.production),
			"OPS_OUTSIDE_PRODUCTION",
		);
		const production = instruction.production as Record<string, unknown>,
			accounting = production.sourceAccounting;
		outsideFields(production.source2, "entry producerContract evidence agentDir");
		const source2 = production.source2;
		outsideRef(source2.entry);
		bytes(source2.entry);
		const nativeDecision = parseOrdinaryOwnerRecord(bytes(binding.native.decision));
		const nativeReceiving = parseOrdinaryOwnerReceiving(bytes(binding.native.receiving));
		assert.deepEqual(source2.entry, nativeDecision.application, "OPS_OUTSIDE_SOURCE2_ENTRY");
		assert.deepEqual(source2.entry, nativeReceiving.application, "OPS_OUTSIDE_SOURCE2_ENTRY");
		assert.deepEqual(nativeDecision.source, nativeReceiving.source, "OPS_OUTSIDE_SOURCE2_SOURCE");
		assert.deepEqual(nativeDecision.package, nativeReceiving.package, "OPS_OUTSIDE_SOURCE2_PACKAGE");
		assert.equal(nativeReceiving.decisionSha256, binding.native.decision.sha256, "OPS_OUTSIDE_SOURCE2_DECISION");
		for (const native of [nativeDecision, nativeReceiving])
			assert.equal(native.profileSha256, binding.native.profile.sha256, "OPS_OUTSIDE_SOURCE2_PROFILE");
		assert.deepEqual(source2.producerContract, binding.producer_contract, "OPS_OUTSIDE_SOURCE2_CONTRACT");
		assert(Array.isArray(source2.evidence), "OPS_OUTSIDE_SOURCE2_EVIDENCE");
		for (const ref of source2.evidence) {
			outsideRef(ref);
			bytes(ref);
		}
		outsideFields(accounting, "binding owner ownerEpoch observer target watches");
		assert.deepEqual(accounting.owner, admission.owner, "OPS_OUTSIDE_PREBOUND_OWNER");
		assert.equal(accounting.ownerEpoch, admission.ownerEpoch, "OPS_OUTSIDE_PREBOUND_EPOCH");
		assert(
			typeof accounting.target === "string" && Array.isArray(accounting.watches) && accounting.watches.length > 0,
			"OPS_OUTSIDE_PREBOUND_WORKLOAD",
		);
		const source = production.source;
		outsideFields(source, "workload package target retention");
		outsideFields(source.package, "document observer");
		assert.equal(accounting.target, source.target, "OPS_OUTSIDE_PREBOUND_SOURCE");
		assert.deepEqual(accounting.observer, source.package.observer, "OPS_OUTSIDE_PREBOUND_OBSERVER");
		for (const ref of [
			accounting.binding,
			source.workload,
			source.package.document,
			source.package.observer,
			source.retention,
		]) {
			outsideRef(ref);
			bytes(ref);
		}
		outsideFields(production.recorder, "root maxBytes maxRecords");
		const options = production.recorder;
		assert(
			typeof options.root === "string" &&
				isAbsolute(options.root) &&
				normalize(options.root) === options.root &&
				options.root !== "/" &&
				typeof options.maxBytes === "number" &&
				Number.isSafeInteger(options.maxBytes) &&
				options.maxBytes > 0 &&
				typeof options.maxRecords === "number" &&
				Number.isSafeInteger(options.maxRecords) &&
				options.maxRecords > 0,
			"OPS_OUTSIDE_ORIGINAL_RECORDER_BUDGET",
		);
		budget = { root: options.root, maxBytes: options.maxBytes, maxRecords: options.maxRecords };
		assert(
			bytesTotal <= budget.maxBytes && references.size <= budget.maxRecords,
			"OPS_OUTSIDE_EXISTING_RECORDER_BUDGET",
		);
		const originalBudget = budget;
		const originalAdmission = structuredClone(admission) as unknown as OperationalFinalTailAdmission;
		const originalAccounting = structuredClone(accounting) as unknown as OperationalSourceAccountingInput;
		const scope = record(binding.fd_slot_bound.scope);
		outsideRef(scope.owner);
		outsideRef(scope.limits);
		outsideFields(scope.aggregate, "device inode");
		assert.deepEqual(scope.owner, originalAdmission.owner, "OPS_OUTSIDE_ORIGINAL_GRAPH_OWNER");
		assert.equal(scope.ownerEpoch, originalAdmission.ownerEpoch, "OPS_OUTSIDE_ORIGINAL_GRAPH_EPOCH");
		assert(
			typeof scope.aggregate.device === "number" &&
				Number.isSafeInteger(scope.aggregate.device) &&
				scope.aggregate.device >= 0 &&
				typeof scope.aggregate.inode === "number" &&
				Number.isSafeInteger(scope.aggregate.inode) &&
				scope.aggregate.inode > 0,
			"OPS_OUTSIDE_ORIGINAL_GRAPH_AGGREGATE",
		);
		const roster = record(binding.fd_slot_bound.proofs.initialFdRoster);
		outsideFields(roster.initialAt, "clockId monotonicMs wallMs uncertaintyMs raw");
		outsideRef(roster.initialAt.raw);
		const basis = record(roster.initialAt.raw);
		assert.deepEqual(basis.contract, epochSource.clockContract, "OPS_OUTSIDE_ORIGINAL_GRAPH_CLOCK");
		const graph: Omit<OriginalOutsideGraphSelection, "final"> = {
			initial: { authorization: authRef },
			owner: scope.owner,
			ownerEpoch: originalAdmission.ownerEpoch,
			epochSource: epoch.source,
			limits: scope.limits,
			aggregate: { device: scope.aggregate.device, inode: scope.aggregate.inode },
			clockBasis: roster.initialAt.raw,
		};
		outsideNs(originalClock.startedNs);
		outsideNs(originalClock.captureReleaseDeadlineNs);
		const host = record(epochSource.host);
		outsideRef(host.qualification);
		const hostQualification = host.qualification;
		bytes(hostQualification);
		const terminal: OriginalOutsideTerminalSelection = {
			owner: originalAccounting.owner,
			ownerEpoch: originalAccounting.ownerEpoch,
			binding: originalAccounting.binding,
			clockBasis: roster.initialAt.raw,
			clockContract: epochSource.clockContract,
			startedNs: originalClock.startedNs as string,
			captureReleaseDeadlineNs: originalClock.captureReleaseDeadlineNs as string,
		};
		const checkRoot = () => {
			checkClockIdentity();
			assert(rootRead(`${STATE}/active.json`, 65536, true).equals(activeBytes), "OPS_OUTSIDE_ACTIVE_CHANGED");
			assert(
				rootRead(`${selected.job}/execution-context.json`, 4 * 1024 * 1024, true).equals(contextBytes),
				"OPS_OUTSIDE_JOB_CHANGED",
			);
			assert.deepEqual(processIdentity(controllerPid), rootController, "OPS_OUTSIDE_CONTROLLER_CHANGED");
			assert.equal(readFileSync(`/proc/${controller.pid}/cgroup`, "utf8"), cgroup, "OPS_OUTSIDE_SERVICE_CHANGED");
		};
		const inWindow = () =>
			assert(process.hrtime.bigint() < outsideNs(originalClock.workloadDeadlineNs), "OPS_OUTSIDE_STAGE_DEADLINE");
		// Walk only the already-selected recorder path in the held original root.
		// No /proc/<retired pid>, directory guessing or logical-key path traversal.
		const receiveRecorder = () => {
			assert(childRoot !== undefined, "OPS_OUTSIDE_ROOT_CLOSED");
			let fd = openSync(`/proc/self/fd/${childRoot}`, C.O_RDONLY | C.O_DIRECTORY);
			try {
				for (const part of originalBudget.root.split("/").slice(1)) {
					assert(part && part !== "." && part !== "..", "OPS_OUTSIDE_RECORDER_PATH");
					const next = openSync(
						`/proc/self/fd/${fd}/${part}`,
						C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK,
					);
					try {
						const s = fstatSync(next, { bigint: true });
						assert(
							(s.uid === 0n || s.uid === childUid) &&
								(!(s.mode & 0o022n) || (s.uid === 0n && !!(s.mode & 0o1000n))),
							"OPS_OUTSIDE_RECORDER_ANCESTRY",
						);
					} catch (cause) {
						closeSync(next);
						throw cause;
					}
					const previous = fd;
					fd = next;
					closeSync(previous);
				}
				recorderDirectory = fd;
				fd = -1;
			} finally {
				if (fd !== -1) closeSync(fd);
			}
			const dir = fstatSync(recorderDirectory, { bigint: true });
			assert(
				dir.uid === childUid && (dir.mode & 0o7777n) === 0o700n && dir.nlink > 0n,
				"OPS_OUTSIDE_RECORDER_CUSTODY",
			);
			const read = (name: string, limit: number, entry?: Record<string, unknown>) => {
				const path = `/proc/self/fd/${recorderDirectory}/${name}`,
					file = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
				try {
					const s = fstatSync(file, { bigint: true });
					assert(
						s.isFile() &&
							s.uid === childUid &&
							s.nlink === 1n &&
							(s.mode & 0o7777n) === 0o600n &&
							s.size >= 0n &&
							s.size <= BigInt(limit),
						"OPS_OUTSIDE_RECORDER_FILE",
					);
					if (entry)
						assert(
							String(s.dev) === entry.device && String(s.ino) === entry.inode && Number(s.size) === entry.size,
							"OPS_OUTSIDE_RECORDER_ENTRY",
						);
					const body = Buffer.alloc(Number(s.size));
					for (let at = 0; at < body.length; ) {
						const n = readSync(file, body, at, body.length - at, at);
						assert(n > 0, "OPS_OUTSIDE_RECORDER_SHORT_READ");
						at += n;
					}
					assert.equal(readSync(file, Buffer.alloc(1), 0, 1, body.length), 0, "OPS_OUTSIDE_RECORDER_GREW");
					for (const now of [fstatSync(file, { bigint: true }), lstatSync(path, { bigint: true })])
						assert.deepEqual(identity(now), identity(s), "OPS_OUTSIDE_RECORDER_CHANGED");
					return body;
				} finally {
					closeSync(file);
				}
			};
			const manifest = read("manifest.jsonl", originalBudget.maxBytes),
				text = new TextDecoder("utf-8", { fatal: true }).decode(manifest);
			assert(text.endsWith("\n"), "OPS_OUTSIDE_RECORDER_PARTIAL_MANIFEST");
			overheadBytes = manifest.length;
			assert(bytesTotal + overheadBytes <= originalBudget.maxBytes, "OPS_OUTSIDE_EXISTING_RECORDER_BUDGET");
			const lines = text.slice(0, -1).split("\n"),
				keys = new Set<string>();
			assert(lines.length <= originalBudget.maxRecords, "OPS_OUTSIDE_RECORDER_COUNT");
			let used = manifest.length;
			for (const [index, line] of lines.entries()) {
				inWindow();
				const entry: unknown = JSON.parse(line);
				outsideFields(entry, "file logicalPath device inode size sha256");
				assert(
					entry.file === `record-${index}.bin` &&
						typeof entry.logicalPath === "string" &&
						!keys.has(entry.logicalPath) &&
						typeof entry.size === "number" &&
						Number.isSafeInteger(entry.size) &&
						entry.size > 0 &&
						entry.size <= 65536 &&
						entry.size <= originalBudget.maxBytes - used &&
						typeof entry.sha256 === "string",
					"OPS_OUTSIDE_RECORDER_INVENTORY",
				);
				used += entry.size;
				keys.add(entry.logicalPath);
				const ref = { path: entry.logicalPath, sha256: entry.sha256 };
				outsideRef(ref);
				put(ref, read(entry.file as string, entry.size, entry));
			}
			assert(
				read("manifest.jsonl", originalBudget.maxBytes).equals(manifest),
				"OPS_OUTSIDE_RECORDER_MANIFEST_CHANGED",
			);
			assert(bytesTotal + manifest.length <= originalBudget.maxBytes, "OPS_OUTSIDE_EXISTING_RECORDER_BUDGET");
			return { keys, last: `${originalBudget.root}/record-${lines.length - 1}.bin` };
		};
		checkRoot();
		inWindow();
		busy = false;
		const original: OriginalOutsideOriginalData = {
			authorization: authRef,
			instruction: binding.instruction,
			publicEntry: source2.entry,
			initialRelease: selected.initialRelease,
			initialEnvelope: release.initial,
			preflight: binding.fd_slot_bound,
			finalTail: originalAdmission,
			sourceAccounting: originalAccounting,
			graph,
			terminal,
		};
		return {
			get original() {
				return structuredClone(original);
			},
			receiveStaged(offer) {
				if (busy) throw remember(new Error("OPS_OUTSIDE_REENTRY"));
				busy = true;
				try {
					usable();
					assert(!stageAttempted, "OPS_OUTSIDE_STAGE_ONCE");
					stageAttempted = true;
					deadline = outsideNs(originalClock.workloadDeadlineNs);
					checkRoot();
					inWindow();
					outsideFields(offer, "version kind stage");
					assert(offer.version === 1 && offer.kind === "sense-operational-staged", "OPS_OUTSIDE_STAGE_OFFER");
					outsideRef(offer.stage);
					assert(
						offer.stage.path.startsWith(`${originalBudget.root}/record-`),
						"OPS_OUTSIDE_STAGE_ORIGINAL_RECORDER",
					);
					const inventory = receiveRecorder();
					assert(
						inventory.keys.has(offer.stage.path) && offer.stage.path === inventory.last,
						"OPS_OUTSIDE_STAGE_NOT_FINAL_RECORD",
					);
					retainedOnly = true;
					staged = decodeOutsideStaged(offer.stage, originalAdmission, originalAccounting, { bytes, record });
					if (!staged.refusals.length) receiveOperationalTerminalData(offer.stage, terminal, { retained });
					checkRoot();
					inWindow();
					usable();
					return structuredClone(staged);
				} catch (cause) {
					throw remember(cause);
				} finally {
					busy = false;
				}
			},
			receiveFinal(refs) {
				if (busy) throw remember(new Error("OPS_OUTSIDE_REENTRY"));
				busy = true;
				try {
					usable();
					assert(stageAttempted && staged && !finalAttempted, "OPS_OUTSIDE_FINAL_ORDER");
					finalAttempted = true;
					deadline = outsideNs(originalClock.reportingDeadlineNs);
					checkRoot();
					outsideFields(refs, "call returned");
					outsideRef(refs.call);
					outsideRef(refs.returned);
					// Protected actual call/return must be read, not supplied via recorder keys.
					pinned(refs.call);
					pinned(refs.returned);
					retainedOnly = false;
					sourceRead = pinned;
					outsideFields(initial.original, "scope epoch enforcement initialFd");
					outsideRef(initial.original.enforcement);
					const value = decodeOutsideFinal(
						refs.call,
						refs.returned,
						{
							reservation: link.reservation as RawRef,
							graph,
							selectedRelease: reservation.selectedRelease,
							capture,
							preflight: binding.fd_slot_bound as unknown as Record<string, unknown>,
							enforcement: initial.original.enforcement,
							host: hostQualification,
							conditions: epochSource.initialConditions,
							staged,
							directory: `${selected.job}/operational`,
						},
						{ bytes, record },
					);
					const sense = receiveOperationalFinalGraphData(staged.owner.staged, value.graph, { retained });
					assert.deepEqual(
						sense.graph.releaseClockCoverage,
						value.result.releaseClockCoverage,
						"OPS_OUTSIDE_ACTUAL_SENSE_RELEASE_COVERAGE",
					);
					checkRoot();
					usable();
					return structuredClone({ ...value, sense });
				} catch (cause) {
					throw remember(cause);
				} finally {
					busy = false;
				}
			},
			get retained() {
				return new Map([...retained].map(([path, body]) => [path, Buffer.from(body)]));
			},
			failure: () => (failed === undefined ? undefined : { cause: failed.cause }),
			close,
		};
	} catch (cause) {
		remember(cause);
		busy = false;
		try {
			close();
		} catch (closing) {
			throw new AggregateError([cause, closing], "OPS_OUTSIDE_BIND_CLOSE_FAILED", { cause });
		}
		throw cause;
	}
}
