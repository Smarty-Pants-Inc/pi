import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ResponsesEvidence } from "@earendil-works/pi-ai/api/responses-evidence";
import {
	createOwnedProviderExchange,
	type OwnedCountRequest,
	type OwnedProviderExchange,
} from "./ordinary-provider-transport.ts";
import type { NativeResourceObservation } from "./ordinary-resource-inspection.ts";
import { OWNER_NATIVE_ABI, type OwnerHostProfile, ownerProfileDigest, parseOwnerHostProfile } from "./owner-profile.ts";
import type { SessionHeader } from "./session-manager.ts";

const moduleRequire = createRequire(import.meta.url);
const constructionKey = Symbol("native-owner-construction");
// ponytail: an uncertain close reply cannot be retried or silently garbage-collected.
// Retain failed bootstrap custody; an explicit native recovery protocol would be needed to release it.
const quarantinedHosts = new Set<OwnerHost>();
const terminalWrites = new AsyncLocalStorage<{ journal: OwnedJournal; active: boolean }>();
const ownerHosts = new WeakMap<
	OwnerHost,
	{
		native: NativeOwnerBinding;
		handle: NativeHost;
		profile: OwnerHostProfile;
		digest: string;
	}
>();

/** Private native handles. Persisted strings cannot reconstruct them. */
type NativeHost = object;
type NativeLease = object;
type NativeLaunch = object;
type NativeOperation = object;
type NativeAdmission = object;

export type OwnedEffectKind = "process" | "read" | "write" | "worker" | "provider";
export interface OwnedProviderScope {
	readonly provider: string;
	readonly model: string;
	readonly api: string;
	readonly baseUrl: string;
}

/** Internal host receiving input, never Sense author arguments or profile defaults.
 * The native issuer copies the complete plan and retains executable descriptors. */
export interface OwnerAdmissionPolicy {
	readonly roots: readonly { readonly index: number; readonly access: "read-only" | "read-write" }[];
	readonly commands: readonly string[];
	readonly effects: readonly OwnedEffectKind[];
	readonly provider:
		| (OwnedProviderScope & {
				readonly attempts: number;
				readonly count?: {
					readonly url: string;
					readonly method: "POST";
					readonly operations: number;
					readonly provider: string;
					readonly wireModel: string;
					readonly purpose: string;
					readonly account: string;
				} | null;
		  })
		| null;
}

/** Exact admitted allocation metadata. IDs are audit/exclusion references, not grants. */
export interface OwnerAllocationClaim {
	readonly id: string;
	readonly decision: string;
	readonly instruction: string;
	readonly principal: string;
	readonly notBeforeMs: number;
	readonly expiresMs: number;
	readonly inference: number;
	readonly count?: number;
	readonly automatic: number;
	readonly scopeOpen: boolean;
}

export type OwnedEffectRequest =
	| { readonly kind: "process" | "worker" }
	| { readonly kind: "read" | "write"; readonly root: number }
	| ({
			readonly kind: "provider";
			readonly count?: {
				readonly url: string;
				readonly method: "POST";
				readonly wireModel: string;
				readonly purpose: string;
				readonly account: string;
				readonly requestId: string;
				readonly payloadHash: string;
				readonly countBodyHash: string;
			};
	  } & OwnedProviderScope);

const admissions = new WeakMap<OwnerAdmission, { journal: OwnedJournal; handle: NativeAdmission }>();
let issueOwnerAdmission: (host: OwnerHost, journal: OwnedJournal, policy: OwnerAdmissionPolicy) => OwnerAdmission;

/** Opaque, single-owner activation ticket. A copied/prototyped object is not one. */
export class OwnerAdmission {
	constructor(key: symbol, journal: OwnedJournal, handle: NativeAdmission) {
		if (key !== constructionKey) throw new Error("OWNER_NATIVE_CONSTRUCTION");
		admissions.set(this, { journal, handle });
		Object.freeze(this);
	}
}

export interface OwnedProcessRequest {
	command: string;
	argv0: string;
	args: string[];
	cwd: string;
	environment: string[];
	roots: number[];
	readOnly: boolean;
	/** Additional attenuation within admitted roots. Cannot be combined with
	 * whole-root mounts. Native holds and rechecks each directory descriptor. */
	mounts?: readonly { root: number; relativePath: string; access: "read-only" | "read-write" }[];
}

export interface OwnedTreeFile {
	path: string;
	mode: number;
	bytes: Buffer;
}

export interface OwnedTreeLimits {
	maxFiles: number;
	maxBytes: number;
	maxDepth: number;
}

export interface OwnedProcessPoll {
	dispatched: boolean;
	stdout: Buffer;
	stderr: Buffer;
	execError: Buffer;
	code: number;
	signal: number;
	error: number;
	drained: boolean;
}

/** Current native counters, not a reservation, clock qualification or grant. */
export interface NativePermissionObservation {
	readonly automaticRemaining: number;
	readonly inferenceRemaining: number;
	readonly countRemaining: number;
	readonly operationRemaining: number;
	readonly launchRemaining: number;
	/** Original allocation clock observation, not an audit-clock qualification. */
	readonly currentWallMs: number;
	readonly grantExpiresWallMs: number;
	readonly remainingMs: number;
}

interface NativeOwnerBinding {
	abi: number;
	permissionAbi?: number;
	inspectPermission?(lease: NativeLease): NativePermissionObservation;
	resourceAbi?: number;
	inspectResources?(lease: NativeLease): NativeResourceObservation;
	validateHost(
		profile: OwnerHostProfile,
		received: {
			profileDigest: string;
			cgroupRoot: number;
			storageRoot: number;
			toolRoot: number;
			fileRoots: number[];
			bubblewrapFile: number;
			artifactFiles: number[];
		},
	): NativeHost;
	closeHost(host: NativeHost): void;
	acquire(host: NativeHost, lockName: string, journalName: string, existing: boolean, grant: string): NativeLease;
	recoveryStatus(lease: NativeLease): { needed: boolean; terminal: boolean; cgroup: string; invocation: string };
	recoverOwner(lease: NativeLease, originalRoot: number): boolean;
	issueAdmission(host: NativeHost, lease: NativeLease, policy: OwnerAdmissionPolicy): NativeAdmission;
	activateOwner(lease: NativeLease, admission: NativeAdmission): void;
	claimAllocation(lease: NativeLease, allocation: OwnerAllocationClaim): void;
	spendAutomaticTurn(lease: NativeLease): void;
	stopAutomaticTurns(lease: NativeLease): void;
	receiveCredential(lease: NativeLease): Buffer;
	checkCredential(lease: NativeLease): void;
	check(lease: NativeLease): void;
	seal(lease: NativeLease): void;
	quarantine(lease: NativeLease): void;
	readJournal(lease: NativeLease, name: string): Buffer;
	commitJournal(lease: NativeLease, name: string, previous: Buffer, next: Buffer): number;
	commitTerminalJournal(lease: NativeLease, name: string, previous: Buffer, next: Buffer): number;
	prepareLaunch(lease: NativeLease, request: OwnedProcessRequest): NativeLaunch;
	dispatchLaunch(launch: NativeLaunch): number;
	stopLaunch(launch: NativeLaunch): void;
	pollLaunch(launch: NativeLaunch): OwnedProcessPoll;
	writeLaunchStdin(launch: NativeLaunch, bytes: Buffer): number;
	retireLaunch(launch: NativeLaunch): void;
	beginOperation(lease: NativeLease, request: OwnedEffectRequest): NativeOperation;
	checkOperation(operation: NativeOperation): void;
	connectProvider(
		operation: NativeOperation,
		peer: {
			address: string;
			port: number;
			url: string;
			method: string;
			requestId?: string;
			payloadHash?: string;
			countBodyHash?: string;
		},
	): void;
	takeProviderSocket(operation: NativeOperation): number | null;
	retireProvider(
		operation: NativeOperation,
		responseId: string,
		terminal: "completed" | "incomplete" | "failed" | "counted",
	): void;
	readFile(operation: NativeOperation, relativePath: string): Buffer;
	writeFile(operation: NativeOperation, relativePath: string, bytes: Buffer, previous: Buffer | undefined): void;
	listDirectories(operation: NativeOperation, relativePath: string): string[];
	readTree(operation: NativeOperation, relativePath: string, limits: OwnedTreeLimits): OwnedTreeFile[];
	createSnapshot(
		operation: NativeOperation,
		relativeParent: string,
		revision: string,
		files: readonly OwnedTreeFile[],
	): string;
	removeSnapshot(operation: NativeOperation, relativePath: string): void;
	completeOperation(operation: NativeOperation, failed: boolean): void;
	releaseOwner(lease: NativeLease): void;
}

function binding(value: unknown): asserts value is NativeOwnerBinding {
	if (value === null || typeof value !== "object" || !("abi" in value) || value.abi !== OWNER_NATIVE_ABI) {
		throw new Error("OWNER_NATIVE_ABI");
	}
	for (const name of [
		"validateHost",
		"closeHost",
		"acquire",
		"recoveryStatus",
		"recoverOwner",
		"issueAdmission",
		"activateOwner",
		"check",
		"seal",
		"quarantine",
		"claimAllocation",
		"spendAutomaticTurn",
		"stopAutomaticTurns",
		"receiveCredential",
		"checkCredential",
		"readJournal",
		"commitJournal",
		"commitTerminalJournal",
		"prepareLaunch",
		"dispatchLaunch",
		"stopLaunch",
		"pollLaunch",
		"writeLaunchStdin",
		"retireLaunch",
		"beginOperation",
		"checkOperation",
		"readFile",
		"writeFile",
		"completeOperation",
		"releaseOwner",
		"listDirectories",
		"readTree",
		"createSnapshot",
		"removeSnapshot",
		"connectProvider",
		"takeProviderSocket",
		"retireProvider",
	]) {
		if (!(name in value) || typeof Reflect.get(value, name) !== "function") throw new Error("OWNER_NATIVE_EXPORT");
	}
}

function closeReleaseDescriptors(descriptors: readonly number[], failure?: { cause: unknown }): void {
	const errors: unknown[] = failure ? [failure.cause] : [];
	for (const fd of descriptors) {
		try {
			closeSync(fd);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length) throw new AggregateError(errors, "OWNER_RECEIVING_DESCRIPTOR_CLOSE", { cause: errors[0] });
}

/** Keep the descriptor whose bytes were checked until native custody receives it. */
export function openReleaseFile(path: string, maxBytes: number, directory?: number): { fd: number; bytes: Buffer } {
	for (let parent = dirname(path); ; parent = dirname(parent)) {
		const stat = lstatSync(parent);
		if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error("OWNER_RELEASE_PARENT");
		if (parent === dirname(parent)) break;
	}
	let input = path;
	if (directory !== undefined) {
		const held = fstatSync(directory),
			named = lstatSync(dirname(path));
		if (
			!held.isDirectory() ||
			held.uid !== 0 ||
			held.mode & 0o022 ||
			held.dev !== named.dev ||
			held.ino !== named.ino
		) {
			throw new Error("OWNER_RELEASE_PARENT");
		}
		input = `/proc/self/fd/${directory}/${basename(path)}`;
	}
	const fd = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = fstatSync(fd);
		if (
			!before.isFile() ||
			before.uid !== 0 ||
			before.nlink !== 1 ||
			(before.mode & 0o022) !== 0 ||
			before.size > maxBytes
		) {
			throw new Error("OWNER_RELEASE_FILE");
		}
		const bytes = readFileSync(fd);
		const after = fstatSync(fd);
		if (
			bytes.length !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		) {
			throw new Error("OWNER_RELEASE_CHANGED");
		}
		return { fd, bytes };
	} catch (error) {
		closeReleaseDescriptors([fd], { cause: error });
		throw error;
	}
}

/** Internal views retain the real native obligation, not an outer abort race. */
class OwnedOperation {
	readonly #native: NativeOwnerBinding;
	readonly #handle: NativeOperation;

	constructor(key: symbol, native: NativeOwnerBinding, handle: NativeOperation) {
		if (key !== constructionKey) throw new Error("OWNER_NATIVE_CONSTRUCTION");
		this.#native = native;
		this.#handle = handle;
		Object.freeze(this);
	}

	check(): void {
		this.#native.checkOperation(this.#handle);
	}
	provider(
		request: Request,
		wireModel: string,
		maxResponseBytes: number,
		beforeSend: (request: Request, bytes: Uint8Array) => Request,
		record: (evidence: Readonly<ResponsesEvidence>) => void,
		count?: OwnedCountRequest,
	): OwnedProviderExchange {
		return createOwnedProviderExchange(
			{
				connect: (address, port, url, method) =>
					this.#native.connectProvider(this.#handle, {
						address,
						port,
						url,
						method,
						requestId: count?.requestId,
						payloadHash: count?.payloadHash,
						countBodyHash: count?.countBodyHash,
					}),
				take: () => this.#native.takeProviderSocket(this.#handle),
				retire: (responseId, terminal) => this.#native.retireProvider(this.#handle, responseId, terminal),
			},
			request,
			wireModel,
			maxResponseBytes,
			beforeSend,
			record,
			count,
		);
	}
	readFile(relativePath: string): Buffer {
		return this.#native.readFile(this.#handle, relativePath);
	}
	writeFile(relativePath: string, bytes: Buffer, previous?: Buffer): void {
		this.#native.writeFile(this.#handle, relativePath, bytes, previous);
	}
	listDirectories(relativePath: string): string[] {
		return this.#native.listDirectories(this.#handle, relativePath);
	}
	readTree(relativePath: string, limits: OwnedTreeLimits): OwnedTreeFile[] {
		return this.#native.readTree(this.#handle, relativePath, limits);
	}
	createSnapshot(relativeParent: string, revision: string, files: readonly OwnedTreeFile[]): string {
		return this.#native.createSnapshot(this.#handle, relativeParent, revision, files);
	}
	removeSnapshot(relativePath: string): void {
		this.#native.removeSnapshot(this.#handle, relativePath);
	}
	complete(failed: boolean): void {
		this.#native.completeOperation(this.#handle, failed);
	}
}

class OwnedProcess {
	readonly #native: NativeOwnerBinding;
	readonly #handle: NativeLaunch;

	constructor(key: symbol, native: NativeOwnerBinding, handle: NativeLaunch) {
		if (key !== constructionKey) throw new Error("OWNER_NATIVE_CONSTRUCTION");
		this.#native = native;
		this.#handle = handle;
		Object.freeze(this);
	}

	dispatch(): number {
		return this.#native.dispatchLaunch(this.#handle);
	}
	stop(): void {
		this.#native.stopLaunch(this.#handle);
	}
	poll(): OwnedProcessPoll {
		return this.#native.pollLaunch(this.#handle);
	}
	write(bytes: Buffer): number {
		return this.#native.writeLaunchStdin(this.#handle, bytes);
	}
	retire(): void {
		this.#native.retireLaunch(this.#handle);
	}
}

/**
 * Native storage and effect custody. Runtime factories must finish composing
 * this with admission and real settlements before an owned SDK can be enabled.
 */
export class OwnedJournal {
	/** Reject copied prototypes before any caller-selected property is read. */
	static assertOriginal(value: unknown): asserts value is OwnedJournal {
		if (value === null || typeof value !== "object" || !(#lease in value)) {
			throw new Error("OWNED_JOURNAL_REQUIRED");
		}
	}

	static {
		issueOwnerAdmission = (host, journal, policy) => {
			if (journal === null || typeof journal !== "object" || !(#lease in journal)) {
				throw new Error("OWNER_ADMISSION_ISSUER");
			}
			return journal.#issueAdmission(host, policy);
		};
	}

	readonly sessionId: string;
	readonly file: string;
	readonly maxBytes: number;
	readonly grant: string;
	readonly #host: OwnerHost;
	readonly #native: NativeOwnerBinding;
	readonly #lease: NativeLease;
	readonly #closeTimeout: number;
	readonly #initialHeader?: SessionHeader;
	#previous: Buffer;
	#loaded: boolean;
	#quarantined = false;
	#sealed = false;
	#released = false;
	#releaseAttempted = false;
	#activated = false;
	#recoveryTask?: Promise<void>;

	private constructor(
		key: symbol,
		host: OwnerHost,
		native: NativeOwnerBinding,
		lease: NativeLease,
		sessionId: string,
		file: string,
		profile: OwnerHostProfile,
		grant: string,
		existing: boolean,
		initialHeader?: SessionHeader,
	) {
		if (key !== constructionKey) throw new Error("OWNER_NATIVE_CONSTRUCTION");
		this.#native = native;
		this.#lease = lease;
		this.#host = host;
		this.sessionId = sessionId;
		this.file = file;
		this.maxBytes = profile.storage.journalBytes;
		this.#closeTimeout = profile.limits.closeTimeoutMs;
		this.grant = grant;
		this.#previous = Buffer.alloc(0);
		this.#loaded = !existing;
		this.#initialHeader = initialHeader ? Object.freeze({ ...initialHeader }) : undefined;
		Object.freeze(this);
	}

	/** Acquire before any native journal read, including the recovery reader. */
	static acquire(
		host: OwnerHost,
		sessionId: string,
		fileName: string,
		existing: boolean,
		initialHeader?: SessionHeader,
	): OwnedJournal {
		if (
			!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(sessionId) ||
			!fileName.endsWith(`_${sessionId}.jsonl`) ||
			fileName.slice(fileName.indexOf("_") + 1, -6) !== sessionId ||
			basename(fileName) !== fileName ||
			fileName.length >= 192
		)
			throw new Error("OWNER_JOURNAL_SCOPE");
		const received = ownerHosts.get(host);
		if (!received) throw new Error("OWNER_NATIVE_HOST_REQUIRED");
		const { native, handle, profile, digest } = received;
		if (!existing && (!initialHeader || initialHeader.id !== sessionId)) throw new Error("OWNER_HEADER_REQUIRED");
		// Identity of a fresh in-process grant, never recovered authority from data.
		const grant = createHash("sha256").update(`${digest}\n${sessionId}\n${randomUUID()}\n`).digest("hex");
		const lease = native.acquire(handle, `${sessionId}.lock`, fileName, existing, grant);
		return new OwnedJournal(
			constructionKey,
			host,
			native,
			lease,
			sessionId,
			join(profile.storage.root, fileName),
			profile,
			grant,
			existing,
			initialHeader,
		);
	}

	/** The supplied FD, when needed, must be the original D. Native checks its
	 * mount/inode, the producer, pending groups and durable disposition itself. */
	recover(originalRoot?: number): Promise<void> {
		this.#recoveryTask ??= this.#recover(originalRoot);
		return this.#recoveryTask;
	}

	async #recover(originalRoot?: number): Promise<void> {
		if (this.#loaded) return;
		if (this.#sealed || this.#quarantined || this.#released) throw new Error("STALE_OWNER");
		const status = this.#native.recoveryStatus(this.#lease);
		let root = originalRoot ?? -1;
		let opened = false;
		let recoveryFailure: { cause: unknown } | undefined;
		try {
			if (status.needed && !status.terminal && root < 0) {
				root = openSync(
					join("/sys/fs/cgroup", status.cgroup),
					constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
				);
				opened = true;
			}
			const deadline = performance.now() + this.#closeTimeout;
			while (status.needed && !this.#native.recoverOwner(this.#lease, root)) {
				if (performance.now() >= deadline) throw new Error("OWNER_RECOVERY_TIMEOUT");
				await delay(10);
			}
			this.#previous = Buffer.from(this.#native.readJournal(this.#lease, basename(this.file)));
			this.#loaded = true;
		} catch (error) {
			recoveryFailure = { cause: error };
			try {
				this.quarantine();
			} catch (cleanup) {
				recoveryFailure.cause = new AggregateError([error, cleanup], "OWNER_RECOVERY_QUARANTINE_FAILED", {
					cause: error,
				});
			}
			throw recoveryFailure.cause;
		} finally {
			if (opened) closeReleaseDescriptors([root], recoveryFailure);
		}
	}

	get initialHeader(): SessionHeader {
		if (!this.#initialHeader) throw new Error("OWNER_HEADER_REQUIRED");
		return { ...this.#initialHeader };
	}

	assertActive(): void {
		if (!this.#loaded) throw new Error("OWNER_RECOVERY_REQUIRED");
		if (this.#sealed || this.#released || this.#quarantined) throw new Error("OWNER_JOURNAL_QUARANTINED");
		this.#native.check(this.#lease);
	}

	read(): Buffer {
		this.assertActive();
		return Buffer.from(this.#previous);
	}

	assertWritable(): void {
		const scope = terminalWrites.getStore();
		if (scope?.journal === this && scope.active && this.#sealed && !this.#quarantined && !this.#releaseAttempted)
			return;
		this.assertActive();
	}

	async terminal<T>(write: () => T): Promise<T> {
		if (!this.#loaded || !this.#sealed || this.#quarantined || this.#releaseAttempted)
			throw new Error("OWNER_TERMINAL_STATE");
		const scope = { journal: this, active: true };
		return terminalWrites.run(scope, async () => {
			try {
				return await write();
			} finally {
				// Async descendants retain their context, not permission to write
				// after the terminal callback has settled.
				scope.active = false;
			}
		});
	}

	commit(bytes: Buffer): { bytes: number; sha256: string } {
		this.assertWritable();
		return this.#commit(bytes, this.#sealed);
	}

	commitTerminal(bytes: Buffer): { bytes: number; sha256: string } {
		const scope = terminalWrites.getStore();
		if (scope?.journal !== this || !scope.active || !this.#sealed || this.#quarantined || this.#releaseAttempted)
			throw new Error("OWNER_TERMINAL_STATE");
		return this.#commit(bytes, true);
	}

	#commit(bytes: Buffer, terminal: boolean): { bytes: number; sha256: string } {
		if (
			bytes.length > this.maxBytes ||
			bytes.length < this.#previous.length ||
			!bytes.subarray(0, this.#previous.length).equals(this.#previous)
		)
			throw new Error("OWNER_JOURNAL_NOT_APPEND");
		try {
			const count = terminal
				? this.#native.commitTerminalJournal(this.#lease, basename(this.file), this.#previous, bytes)
				: this.#native.commitJournal(this.#lease, basename(this.file), this.#previous, bytes);
			if (count !== bytes.length) throw new Error("OWNER_JOURNAL_RECEIPT");
			this.#previous = Buffer.from(bytes);
			return { bytes: count, sha256: createHash("sha256").update(bytes).digest("hex") };
		} catch (error) {
			try {
				this.quarantine();
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "OWNER_JOURNAL_QUARANTINE_FAILED");
			}
			throw error;
		}
	}

	/** Private dispatch keeps construction authority out of caller-selected methods. */
	#issueAdmission(host: OwnerHost, policy: OwnerAdmissionPolicy): OwnerAdmission {
		if (host !== this.#host) throw new Error("OWNER_ADMISSION_ISSUER");
		this.assertActive();
		const received = ownerHosts.get(host);
		if (!received || this.#activated) throw new Error("OWNER_ADMISSION_ISSUER");
		const handle = this.#native.issueAdmission(received.handle, this.#lease, policy);
		return new OwnerAdmission(constructionKey, this, handle);
	}

	claimAllocation(allocation: OwnerAllocationClaim): void {
		this.assertActive();
		this.#native.claimAllocation(this.#lease, allocation);
	}

	spendAutomaticTurn(): void {
		this.assertActive();
		this.#native.spendAutomaticTurn(this.#lease);
	}

	stopAutomaticTurns(): void {
		this.#native.stopAutomaticTurns(this.#lease);
	}

	activate(admission: OwnerAdmission): void {
		this.assertActive();
		const received = admissions.get(admission);
		if (!received || received.journal !== this || this.#activated) throw new Error("OWNER_ADMISSION_REQUIRED");
		this.#native.activateOwner(this.#lease, received.handle);
		this.#activated = true;
	}

	/** Native receives the fixed platform copy once for this H/original lease. */
	receiveCredential(): Buffer {
		this.assertActive();
		if (!this.#activated) throw new Error("OWNER_NOT_ACTIVATED");
		return this.#native.receiveCredential(this.#lease);
	}

	checkCredential(): void {
		this.assertActive();
		this.#native.checkCredential(this.#lease);
	}

	inspectPermission(): Readonly<NativePermissionObservation> {
		this.assertActive();
		if (!this.#activated || !ownerHosts.has(this.#host)) throw new Error("OWNER_NOT_ACTIVATED");
		if (this.#native.permissionAbi !== 1 || typeof this.#native.inspectPermission !== "function") {
			throw new Error("OWNER_NATIVE_PERMISSION_ABI");
		}
		return Object.freeze({ ...this.#native.inspectPermission(this.#lease) });
	}

	inspectResources(): NativeResourceObservation {
		this.assertActive();
		if (!this.#activated || !ownerHosts.has(this.#host)) throw new Error("OWNER_NOT_ACTIVATED");
		if (this.#native.resourceAbi !== 1 || typeof this.#native.inspectResources !== "function") {
			throw new Error("OWNER_NATIVE_RESOURCE_ABI");
		}
		return this.#native.inspectResources(this.#lease);
	}

	beginOperation(request: OwnedEffectRequest): OwnedOperation {
		this.assertActive();
		if (!this.#activated) throw new Error("OWNER_NOT_ACTIVATED");
		return new OwnedOperation(constructionKey, this.#native, this.#native.beginOperation(this.#lease, request));
	}

	prepareProcess(request: OwnedProcessRequest): OwnedProcess {
		this.assertActive();
		if (!this.#activated) throw new Error("OWNER_NOT_ACTIVATED");
		return new OwnedProcess(constructionKey, this.#native, this.#native.prepareLaunch(this.#lease, request));
	}

	seal(): void {
		if (this.#releaseAttempted) throw new Error("STALE_OWNER");
		this.#sealed = true;
		this.#native.seal(this.#lease);
	}

	quarantine(): void {
		if (this.#releaseAttempted) throw new Error("STALE_OWNER");
		this.#sealed = this.#quarantined = true;
		this.#native.quarantine(this.#lease);
	}

	release(): void {
		if (!this.#sealed || this.#quarantined || this.#releaseAttempted) throw new Error("OWNER_NOT_RETIRED");
		this.#releaseAttempted = true;
		try {
			this.#native.releaseOwner(this.#lease);
			this.#released = true;
		} catch (error) {
			// A release reply may be lost after close consumed JA. Never write or
			// attempt a new terminal commit after that uncertain release boundary.
			this.#quarantined = true;
			throw error;
		}
	}
}

export class OwnerHost {
	private constructor(
		key: symbol,
		profile: OwnerHostProfile,
		digest: string,
		native: NativeOwnerBinding,
		handle: NativeHost,
	) {
		if (key !== constructionKey) throw new Error("OWNER_NATIVE_CONSTRUCTION");
		ownerHosts.set(this, { profile, digest, native, handle });
		Object.freeze(this);
	}

	get profile(): Readonly<OwnerHostProfile> {
		const received = ownerHosts.get(this);
		if (!received) throw new Error("OWNER_NATIVE_HOST_REQUIRED");
		return received.profile;
	}

	/** Private source integration point, not exported from the SDK/index. */
	static loadNative(profilePath: string): OwnerHost {
		if (process.platform !== "linux") throw new Error("OWNER_PLATFORM_UNAVAILABLE");
		if (
			!isAbsolute(profilePath) ||
			normalize(profilePath) !== profilePath ||
			profilePath === "/" ||
			/[\u0000-\u001f\u007f@]/.test(profilePath)
		) {
			throw new Error("OWNER_PROFILE_PATH");
		}
		const profileFile = openReleaseFile(profilePath, 65_536);
		let profile: OwnerHostProfile;
		let digest: string;
		let profileFailure: { cause: unknown } | undefined;
		try {
			profile = parseOwnerHostProfile(profileFile.bytes);
			digest = ownerProfileDigest(profileFile.bytes);
		} catch (cause) {
			profileFailure = { cause };
			throw cause;
		} finally {
			closeReleaseDescriptors([profileFile.fd], profileFailure);
		}
		if (profile.runtime.architecture !== process.arch) throw new Error("OWNER_RUNTIME_ARCHITECTURE");
		const runtimeVersion = profile.runtime.kind === "bun" ? process.versions.bun : process.versions.node;
		if (runtimeVersion !== profile.runtime.version || (profile.runtime.kind === "node" && process.versions.bun))
			throw new Error("OWNER_RUNTIME_VERSION");
		const files: number[] = [];
		const directories: number[] = [];
		const errors: unknown[] = [];
		let host: OwnerHost | undefined;
		try {
			for (const artifact of [
				profile.artifacts.addon,
				profile.artifacts.bubblewrap,
				profile.artifacts.runtime,
				...profile.artifacts.closure,
			]) {
				const file = openReleaseFile(artifact.path, 268_435_456);
				files.push(file.fd);
				if (createHash("sha256").update(file.bytes).digest("hex") !== artifact.sha256)
					throw new Error("OWNER_ARTIFACT_HASH");
			}
			const executable = openSync("/proc/self/exe", constants.O_RDONLY);
			let executableFailure: { cause: unknown } | undefined;
			try {
				const running = fstatSync(executable);
				const received = fstatSync(files[2]);
				if (running.dev !== received.dev || running.ino !== received.ino) throw new Error("OWNER_RUNTIME_ARTIFACT");
			} catch (cause) {
				executableFailure = { cause };
				throw cause;
			} finally {
				closeReleaseDescriptors([executable], executableFailure);
			}
			const native: unknown = moduleRequire(profile.artifacts.addon.path);
			binding(native);
			Object.freeze(native);
			for (const path of [
				join("/sys/fs/cgroup", profile.host.cgroup),
				profile.storage.root,
				profile.sandbox.toolRoot,
				...profile.sandbox.fileRoots.map((root) => root.path),
			]) {
				directories.push(openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
			}
			const handle = native.validateHost(profile, {
				profileDigest: digest,
				cgroupRoot: directories[0],
				storageRoot: directories[1],
				toolRoot: directories[2],
				fileRoots: directories.slice(3),
				bubblewrapFile: files[1],
				artifactFiles: files.slice(2),
			});
			host = new OwnerHost(constructionKey, profile, digest, native, handle);
		} catch (error) {
			errors.push(error);
		} finally {
			for (const fd of [...directories, ...files]) {
				try {
					closeSync(fd);
				} catch (error) {
					errors.push(error);
				}
			}
		}
		if (errors.length && host) {
			try {
				host.close();
			} catch (cleanup) {
				errors.push(cleanup);
				quarantinedHosts.add(host);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length) throw new AggregateError(errors, "OWNER_RECEIVING_DESCRIPTOR_CLOSE", { cause: errors[0] });
		return host!;
	}

	/** The host control plane supplies the exact permissions, not a session UUID,
	 * restored record, ambient owner, profile maximum or author-facing option. */
	admit(journal: OwnedJournal, policy: OwnerAdmissionPolicy): OwnerAdmission {
		if (!ownerHosts.has(this)) throw new Error("OWNER_NATIVE_HOST_REQUIRED");
		return issueOwnerAdmission(this, journal, policy);
	}

	close(): void {
		const received = ownerHosts.get(this);
		if (!received) throw new Error("OWNER_NATIVE_HOST_REQUIRED");
		received.native.closeHost(received.handle);
		ownerHosts.delete(this);
	}
}
