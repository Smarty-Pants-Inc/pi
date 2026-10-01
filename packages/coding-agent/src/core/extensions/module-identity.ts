import { createHash } from "node:crypto";
import { type BigIntStats, closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";

/** Private loader identity of the bytes evaluated, not an inspection pathname. */
export interface LoadedModuleIdentity {
	readonly requestedPath: string;
	readonly path: string;
	readonly revision: string;
	readonly hash: string;
}

function revision(stats: BigIntStats): string {
	return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

/** Resolve once and read the opened file; never let the evaluator reopen a checked pathname. */
export function readExtensionModule(requestedPath: string): { identity: LoadedModuleIdentity; source: string } {
	const path = realpathSync(requestedPath);
	const fd = openSync(path, "r");
	try {
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile()) throw new Error(`Extension is not a regular file: ${requestedPath}`);
		const content = readFileSync(fd);
		const after = fstatSync(fd, { bigint: true });
		const identity = Object.freeze({
			requestedPath,
			path,
			revision: revision(before),
			hash: createHash("sha256").update(content).digest("hex"),
		});
		if (revision(after) !== identity.revision || !isExtensionModuleCurrent(identity)) {
			throw new Error(`Extension changed while reading: ${requestedPath}`);
		}
		return { identity, source: content.toString("utf8") };
	} finally {
		closeSync(fd);
	}
}

/** Freshness can only revoke a captured identity, never replace it with a new grant. */
export function isExtensionModuleCurrent(identity: LoadedModuleIdentity): boolean {
	let fd: number | undefined;
	try {
		if (realpathSync(identity.requestedPath) !== identity.path) return false;
		fd = openSync(identity.path, "r");
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile() || revision(before) !== identity.revision) return false;
		const content = readFileSync(fd);
		return (
			createHash("sha256").update(content).digest("hex") === identity.hash &&
			revision(fstatSync(fd, { bigint: true })) === identity.revision &&
			revision(statSync(identity.requestedPath, { bigint: true })) === identity.revision &&
			realpathSync(identity.requestedPath) === identity.path
		);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
