import { createHash } from "node:crypto";
import { type BigIntStats, closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { spawnProcessSync } from "../../utils/child-process.ts";

/** Installation and committed blob identity, captured before this module is evaluated. */
export interface GitModuleIdentity {
	readonly root: string;
	readonly endpoint: string;
	readonly commit: string;
}

/** Private loader identity of the bytes evaluated, not an inspection pathname. */
export interface LoadedModuleIdentity {
	readonly requestedPath: string;
	readonly path: string;
	readonly revision: string;
	readonly hash: string;
	readonly git?: GitModuleIdentity;
	/** Loader-owned proof. Exposing evaluator controls revokes its Git source authority. */
	readonly implementation?: {
		isCurrent(): boolean;
		isGitCurrent(root: string, endpoint: string, commit: string): boolean;
	};
}

function revision(stats: BigIntStats): string {
	return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

// Preserve protocol, credentials, port and complete path, rather than cache host/path identifiers.
export function normalizeGitEndpoint(endpoint: string | undefined): string | undefined {
	if (!endpoint || /[\s\p{Cc}]/u.test(endpoint)) return undefined;
	if (/^git@[^:]+:[^/].+/.test(endpoint)) return endpoint;
	if (/^ssh:/i.test(endpoint)) {
		const path = /^ssh:\/\/[^/?#\\]+(\/[^?#]*)$/i.exec(endpoint)?.[1];
		// ponytail: refuse ambiguous authority, not Git loading. SSH transports can resolve raw
		// symlink/../ paths differently from WHATWG URLs. Do not guess percent-decoding rules
		// (including repeated/alternate encodings), or merge literal paths with URL-encoded ones.
		if (
			!path ||
			!/^[/A-Za-z0-9._~!$&'()*+,;=:@-]+$/.test(path) ||
			path.split("/").some((part) => part === "." || part === "..")
		)
			return undefined;
	}
	try {
		const url = new URL(endpoint);
		return ["https:", "http:", "ssh:", "git:"].includes(url.protocol) && url.hostname ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function gitOutput(cwd: string, args: string[]): string | undefined {
	const result = spawnProcessSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", timeout: 10_000 });
	return result.status === 0 && !result.error && !result.stderr?.trim() ? result.stdout : undefined;
}

function gitModuleIdentity(path: string, content: Buffer): GitModuleIdentity | undefined {
	try {
		// The nearest repository must own this file. Outer-directory containment is not ownership.
		const top = gitOutput(dirname(path), ["rev-parse", "--show-toplevel"]);
		if (!top) return undefined;
		const root = realpathSync(top.replace(/\n$/, ""));
		const file = relative(root, path).split(sep).join("/");
		if (!file || file.startsWith("../")) return undefined;
		const urls = gitOutput(root, ["config", "--local", "--null", "--get-all", "remote.origin.url"])?.split("\0");
		const endpoint = urls?.length === 2 && urls[1] === "" ? normalizeGitEndpoint(urls[0]) : undefined;
		const commit = gitOutput(root, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])?.trim();
		if (!endpoint || !commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return undefined;
		const tree = gitOutput(root, ["ls-tree", "-z", "--full-tree", commit, "--", `:(literal)${file}`]);
		const match = tree?.match(/^(?:100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/);
		if (!match || match[2] !== file) return undefined;
		const blob = createHash(commit.length === 64 ? "sha256" : "sha1")
			.update(`blob ${content.length}\0`)
			.update(content)
			.digest("hex");
		return blob === match[1] ? Object.freeze({ root, endpoint, commit }) : undefined;
	} catch {
		return undefined;
	}
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
			git: gitModuleIdentity(path, content),
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
		if (
			createHash("sha256").update(content).digest("hex") !== identity.hash ||
			revision(fstatSync(fd, { bigint: true })) !== identity.revision ||
			revision(statSync(identity.requestedPath, { bigint: true })) !== identity.revision ||
			realpathSync(identity.requestedPath) !== identity.path
		)
			return false;
		if (identity.git) {
			const current = gitModuleIdentity(identity.path, content);
			if (
				!current ||
				current.root !== identity.git.root ||
				current.endpoint !== identity.git.endpoint ||
				current.commit !== identity.git.commit
			)
				return false;
		}
		return identity.implementation?.isCurrent() ?? true;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
