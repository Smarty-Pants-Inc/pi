import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

/** Deployment expectations, not an admission grant or observed host state. */
export interface OwnerHostProfile {
	version: 1;
	id: string;
	runtime: {
		kind: "node" | "bun";
		version: string;
		architecture: "x64" | "arm64";
		libc: "glibc" | "musl";
	};
	host: {
		uid: number;
		gid: number;
		unit: string;
		cgroup: string;
	};
	artifacts: {
		addon: OwnerArtifact;
		bubblewrap: OwnerArtifact;
		runtime: OwnerArtifact;
		closure: OwnerArtifact[];
	};
	storage: {
		root: string;
		journalBytes: number;
	};
	limits: {
		owners: number;
		launchesPerOwner: number;
		operationsPerOwner: number;
		recordBytes: number;
		argvBytes: number;
		outputBytes: number;
		closeTimeoutMs: number;
		processTimeoutMs: number;
		memoryBytes: number;
		pids: number;
		cpuQuotaMicros: number;
		cpuPeriodMicros: number;
		fileDescriptors: number;
		diskBytes: number;
		inodes: number;
	};
	sandbox: {
		kind: "file-observer-v1";
		toolRoot: string;
		fileRoots: Array<{ path: string; access: "read-only" | "read-write" }>;
	};
}

export interface OwnerArtifact {
	path: string;
	sha256: string;
}

export const OWNER_PROFILE_MAX_BYTES = 65_536;
// Count admission/accounting must not load an older inference-only binding.
export const OWNER_NATIVE_ABI = 2;

function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	) {
		throw new Error("OWNER_PROFILE_SHAPE");
	}
}

function text(value: unknown, pattern: RegExp, max = 4096): asserts value is string {
	if (typeof value !== "string" || value.length > max || !pattern.test(value)) {
		throw new Error("OWNER_PROFILE_VALUE");
	}
}

function path(value: unknown): asserts value is string {
	text(value, /^\/(?!.*[\x00-\x1f\x7f@])[\s\S]*$/);
	if (!isAbsolute(value) || normalize(value) !== value || value === "/") {
		throw new Error("OWNER_PROFILE_PATH");
	}
}

function integer(value: unknown, min: number, max: number): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error("OWNER_PROFILE_LIMIT");
	}
}

function artifact(value: unknown): asserts value is OwnerArtifact {
	record(value, ["path", "sha256"]);
	path(value.path);
	text(value.sha256, /^[0-9a-f]{64}$/, 64);
}

/**
 * Parse only the canonical, two-space JSON form returned by the host source owner.
 * Comparing the exact representation also rejects duplicate keys and ambiguous
 * encodings without introducing a second JSON parser. No file, addon or host access.
 */
export function parseOwnerHostProfile(bytes: Uint8Array): Readonly<OwnerHostProfile> {
	if (bytes.byteLength === 0 || bytes.byteLength > OWNER_PROFILE_MAX_BYTES) {
		throw new Error("OWNER_PROFILE_SIZE");
	}
	const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	const value: unknown = JSON.parse(source);
	if (`${JSON.stringify(value, null, 2)}\n` !== source) throw new Error("OWNER_PROFILE_ENCODING");
	record(value, ["version", "id", "runtime", "host", "artifacts", "storage", "limits", "sandbox"]);
	if (value.version !== 1) throw new Error("OWNER_PROFILE_VERSION");
	text(value.id, /^[a-z][a-z0-9-]{0,63}$/, 64);
	record(value.runtime, ["kind", "version", "architecture", "libc"]);
	if (value.runtime.kind !== "node" && value.runtime.kind !== "bun") throw new Error("OWNER_PROFILE_RUNTIME");
	text(value.runtime.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/, 64);
	if (value.runtime.architecture !== "x64" && value.runtime.architecture !== "arm64") {
		throw new Error("OWNER_PROFILE_ARCHITECTURE");
	}
	if (value.runtime.libc !== "glibc" && value.runtime.libc !== "musl") throw new Error("OWNER_PROFILE_LIBC");
	record(value.host, ["uid", "gid", "unit", "cgroup"]);
	integer(value.host.uid, 1, 2_147_483_647);
	integer(value.host.gid, 1, 2_147_483_647);
	text(value.host.unit, /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}\.service$/, 136);
	path(value.host.cgroup);
	if (!value.host.cgroup.endsWith(`/${value.host.unit}`)) throw new Error("OWNER_PROFILE_CGROUP");
	record(value.artifacts, ["addon", "bubblewrap", "runtime", "closure"]);
	artifact(value.artifacts.addon);
	artifact(value.artifacts.bubblewrap);
	artifact(value.artifacts.runtime);
	if (!Array.isArray(value.artifacts.closure) || value.artifacts.closure.length > 256) {
		throw new Error("OWNER_PROFILE_CLOSURE");
	}
	const artifactPaths = new Set([
		value.artifacts.addon.path,
		value.artifacts.bubblewrap.path,
		value.artifacts.runtime.path,
	]);
	if (artifactPaths.size !== 3) throw new Error("OWNER_PROFILE_DUPLICATE_ARTIFACT");
	for (const entry of value.artifacts.closure) {
		artifact(entry);
		if (artifactPaths.has(entry.path)) throw new Error("OWNER_PROFILE_DUPLICATE_ARTIFACT");
		artifactPaths.add(entry.path);
	}
	record(value.storage, ["root", "journalBytes"]);
	path(value.storage.root);
	integer(value.storage.journalBytes, 1024, 16_777_216);
	record(value.limits, [
		"owners",
		"launchesPerOwner",
		"operationsPerOwner",
		"recordBytes",
		"argvBytes",
		"outputBytes",
		"closeTimeoutMs",
		"processTimeoutMs",
		"memoryBytes",
		"pids",
		"cpuQuotaMicros",
		"cpuPeriodMicros",
		"fileDescriptors",
		"diskBytes",
		"inodes",
	]);
	integer(value.limits.owners, 2, 32);
	integer(value.limits.launchesPerOwner, 1, 64);
	integer(value.limits.operationsPerOwner, 1, 1024);
	integer(value.limits.recordBytes, 4096, 65_536);
	integer(value.limits.argvBytes, 1024, 131_072);
	integer(value.limits.outputBytes, 1024, 16_777_216);
	integer(value.limits.closeTimeoutMs, 100, 60_000);
	integer(value.limits.processTimeoutMs, 100, 240_000);
	integer(value.limits.memoryBytes, 67_108_864, 2_147_483_648);
	integer(value.limits.pids, 4, 128);
	integer(value.limits.cpuPeriodMicros, 1000, 1_000_000);
	integer(value.limits.cpuQuotaMicros, 1000, 2 * value.limits.cpuPeriodMicros);
	integer(value.limits.fileDescriptors, 32, 1024);
	integer(value.limits.diskBytes, 1_048_576, 268_435_456);
	integer(value.limits.inodes, 16, 4096);
	record(value.sandbox, ["kind", "toolRoot", "fileRoots"]);
	if (value.sandbox.kind !== "file-observer-v1") throw new Error("OWNER_PROFILE_SANDBOX");
	path(value.sandbox.toolRoot);
	if (!Array.isArray(value.sandbox.fileRoots) || value.sandbox.fileRoots.length > 16) {
		throw new Error("OWNER_PROFILE_FILE_ROOTS");
	}
	const roots: string[] = [value.storage.root, value.sandbox.toolRoot];
	for (const entry of value.sandbox.fileRoots) {
		record(entry, ["path", "access"]);
		path(entry.path);
		if (entry.access !== "read-only" && entry.access !== "read-write") throw new Error("OWNER_PROFILE_ACCESS");
		roots.push(entry.path);
	}
	for (let index = 0; index < roots.length; index++) {
		for (let other = 0; other < roots.length; other++) {
			if (index !== other && (roots[index] === roots[other] || roots[index].startsWith(`${roots[other]}/`))) {
				throw new Error("OWNER_PROFILE_OVERLAPPING_ROOTS");
			}
		}
		if (
			["/proc", "/sys", "/dev", "/run"].some((root) => roots[index] === root || roots[index].startsWith(`${root}/`))
		) {
			throw new Error("OWNER_PROFILE_PROTECTED_ROOT");
		}
	}
	for (const entry of [
		value.artifacts.addon,
		value.artifacts.bubblewrap,
		value.artifacts.runtime,
		...value.artifacts.closure,
	]) {
		for (const root of value.sandbox.fileRoots) {
			if (entry.path === root.path || entry.path.startsWith(`${root.path}/`)) {
				throw new Error("OWNER_PROFILE_EXPOSED_ARTIFACT");
			}
		}
	}
	// The JSON parser allocated this graph; none of the caller's objects enter it.
	return freezeProfile(value as unknown as OwnerHostProfile);
}

function freezeProfile<T>(value: T): Readonly<T> {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freezeProfile(child);
		Object.freeze(value);
	}
	return value;
}

export function ownerProfileDigest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
