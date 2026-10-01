/**
 * Per-turn sender provenance, v1 (contract: smarty-dev#2636 comment 5913265017; smarty-dev#2264).
 *
 * The harness writes one `provenance` record on each user message entry and each extension custom message
 * entry, once, at first receipt. It comes only from the API path that delivered the turn, the identity the
 * extension loader knows for the calling extension, and (for typed input) a herdr input attestation.
 * Message text never sets it, and nothing rewrites it later.
 */
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { validRange } from "semver";
import { spawnProcessSync } from "../utils/child-process.ts";
import { parseGitUrl } from "../utils/git.ts";
import { isLocalPath, normalizePath, resolvePath } from "../utils/paths.ts";
import {
	isExtensionModuleCurrent,
	type LoadedModuleIdentity,
	normalizeGitEndpoint,
} from "./extensions/module-identity.ts";
import type { SessionEntry } from "./session-manager.ts";
import type { SourceInfo } from "./source-info.ts";

export const TURN_PROVENANCE_VERSION = 1;

/**
 * - `keyboard`: typed input that herdr attests came from an attached client, with that client's principal
 * - `terminal`: any other host input (pane, print, JSON, RPC, SDK) and every refused claim; never attributable
 * - `voice`: the trusted smarty-voice extension, with the call's principal
 * - `fabric`: injected by Fabric through the extension API, with the verified sender
 */
export type TurnChannel = "keyboard" | "terminal" | "voice" | "fabric";

/** A `setup/org.json` principal name, and what bound it to the turn. */
export interface TurnPrincipal {
	readonly id: string;
	readonly binding: "herdr-client" | "voice-call";
}

export type TurnSenderKind = "main" | "actor" | "agent" | "remote";

/** The Fabric sender, as Fabric verified it (`mesh` admission or a `bridge`). */
export interface TurnSender {
	readonly id: string;
	readonly kind: TurnSenderKind;
	readonly name?: string;
	readonly verified: "mesh" | "bridge";
}

export type TurnFabricVia = "steer" | "followUp" | "actor" | "replay";

/** Harness-written provenance of one turn. Stored on the session entry, frozen, never rewritten. */
export interface TurnProvenance {
	readonly v: 1;
	/** Harness UUID for the turn. */
	readonly turnId: string;
	/** ISO time of the first receipt in Pi. */
	readonly receivedAt: string;
	readonly channel: TurnChannel;
	readonly principal?: TurnPrincipal;
	/** `fabric` only. */
	readonly sender?: TurnSender;
	/** `fabric` only. */
	readonly via?: TurnFabricVia;
}

/**
 * What an extension may claim in `pi.sendMessage` / `pi.sendUserMessage` options. The harness writes
 * `turnId` and `receivedAt`. A claim the caller is not trusted for, or with a bad shape, is refused:
 * the turn is still delivered, recorded as `terminal`.
 */
export type TurnProvenanceClaim =
	| { v?: 1; channel: "voice"; principal: { id: string } }
	| { v?: 1; channel: "fabric"; sender: TurnSender; via?: TurnFabricVia };

/**
 * Extensions trusted per claim channel. Read from global settings only: a project's settings must not grant
 * an extension the right to speak for a principal. Each item matches an extension's resolved path (or its
 * local package path) exactly. Local paths are resolved and symlinks followed before matching. Git/npm
 * source strings never grant authority: artifact association and a complete implementation graph cannot
 * currently be attested, including native loading outside Jiti. Ordinary loading and explicit file/directory
 * trust remain available. Restore Git/npm grants only with artifact + complete implementation attestation.
 * An item ending in `/` matches everything under that directory, for example the smarty-voice release root,
 * whose release directories the installer verifies.
 */
export interface TurnProvenanceTrust {
	voiceExtensions?: string[];
	fabricExtensions?: string[];
}

/** The calling extension, as the loader knows it (never supplied by the extension). */
export interface TurnProvenanceCaller {
	readonly resolvedPath: string;
	readonly sourceInfo: Readonly<SourceInfo>;
}

// Admission descriptors are private, not the mutable metadata exposed by resource inspection.
const extensionCallers = new WeakMap<TurnProvenanceCaller, TurnProvenanceCaller>();
const loadedModules = new WeakMap<TurnProvenanceCaller, LoadedModuleIdentity>();
const packageSources = new WeakMap<TurnProvenanceCaller, string>();
const reportedSourceRefusals = new WeakSet<TurnProvenanceCaller>();

/** Host-only: bind the evaluated module before its factory can change the filesystem. */
export function bindExtensionTurnProvenanceModule(
	extension: TurnProvenanceCaller,
	identity: LoadedModuleIdentity,
): void {
	if (loadedModules.has(extension) || extensionCallers.has(extension))
		throw new Error("Extension identity already bound");
	loadedModules.set(extension, identity);
}

/** Host-only: finalize once, after the resource loader has assigned authoritative source metadata. */
export function finalizeExtensionTurnProvenanceCaller(
	extension: TurnProvenanceCaller,
	localPackageBaseDir?: string,
): void {
	if (extensionCallers.has(extension)) return;
	const sourceInfo = { ...extension.sourceInfo };
	const loaded = loadedModules.get(extension);
	const resolvedPath =
		loaded?.path ??
		(extension.resolvedPath.startsWith("<")
			? extension.resolvedPath
			: (existingIdentity(extension.resolvedPath) ?? ""));
	if (sourceInfo.origin === "package" && sourceInfo.source.startsWith("npm:")) {
		const spec = sourceInfo.source.slice(4).trim();
		// Match the package manager's npm spec parser, including scoped names and malformed selectors.
		const version = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)?.[2];
		// ponytail: refuse unverifiable tag authority, not loading. A shared name-keyed cache
		// may contain another tag's artifact; only semver requests are checked by the resolver.
		if (!version || !validRange(version)) sourceInfo.source = resolvedPath;
	}
	const git = sourceInfo.origin === "package" ? parseGitUrl(sourceInfo.source) : null;
	if (git) {
		// Git caches share a checkout across refs and endpoints (e.g. different ports).
		// Require its recorded clone endpoint as well as the evaluated module and resolved ref.
		let verified = false;
		try {
			const root = sourceInfo.baseDir && existingIdentity(sourceInfo.baseDir);
			if (
				loaded?.git &&
				root &&
				loaded.git.root === root &&
				loaded.path.startsWith(`${root}${sep}`) &&
				statSync(join(root, ".git")).isDirectory()
			) {
				// Read the URL recorded by clone, not `remote get-url`, which applies insteadOf rewrites.
				const origin = spawnProcessSync("git", ["config", "--local", "--null", "--get-all", "remote.origin.url"], {
					cwd: root,
					encoding: "utf8",
					stdio: "pipe",
					timeout: 10_000,
				});
				// Exactly one NUL-terminated value, including empty values in the ambiguity check.
				const urls = origin.stdout?.split("\0");
				const endpoint = urls?.length === 2 && urls[1] === "" ? normalizeGitEndpoint(urls[0]) : undefined;
				const originVerified =
					origin.status === 0 &&
					!origin.error &&
					!origin.stderr?.trim() &&
					endpoint !== undefined &&
					endpoint === normalizeGitEndpoint(git.repo);
				const commits = ["HEAD", git.ref ?? "origin/HEAD"].map((ref) => {
					const result = spawnProcessSync(
						"git",
						["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
						{
							cwd: root,
							encoding: "utf8",
							stdio: "pipe",
							timeout: 10_000,
						},
					);
					const commit = result.stdout?.trim();
					return result.status === 0 &&
						!result.error &&
						!result.stderr?.trim() &&
						/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit ?? "")
						? commit
						: undefined;
				});
				verified =
					originVerified &&
					commits[0] !== undefined &&
					commits[0] === commits[1] &&
					loaded.git.endpoint === endpoint &&
					loaded.git.commit === commits[0] &&
					loaded.implementation?.isGitCurrent(root, endpoint!, commits[0]) === true;
			}
		} catch {
			// An absent/mismatched endpoint, checkout/ref or unavailable Git cannot establish a source grant.
		}
		if (!verified) sourceInfo.source = resolvedPath;
	}
	if (sourceInfo.origin === "package" && isLocalPath(sourceInfo.source)) {
		// A local file grant names only the evaluated file. A package-directory grant also requires
		// that file to be inside the real package root, never a manifest/symlink escape.
		const source = existingIdentity(sourceInfo.source, localPackageBaseDir);
		let packageRoot: string | undefined;
		if (loaded && source && (localPackageBaseDir || isAbsolute(normalizePath(sourceInfo.source)))) {
			try {
				if (
					statSync(source).isDirectory() &&
					loaded.path.startsWith(source.endsWith(sep) ? source : `${source}${sep}`)
				)
					packageRoot = source;
			} catch {
				// Missing package metadata cannot add an alternate grant.
			}
		}
		sourceInfo.source = packageRoot ?? resolvedPath;
	}
	const caller = Object.freeze({
		resolvedPath,
		sourceInfo: Object.freeze(sourceInfo),
	});
	if (loaded) loadedModules.set(caller, loaded);
	if (
		extension.sourceInfo.origin === "package" &&
		(!isLocalPath(extension.sourceInfo.source) || parseGitUrl(extension.sourceInfo.source))
	)
		packageSources.set(caller, extension.sourceInfo.source);
	extensionCallers.set(extension, caller);
}

/** Host-only: an unfinalized extension has no admission identity and its claims fail closed. */
export function getExtensionTurnProvenanceCaller(extension: TurnProvenanceCaller): TurnProvenanceCaller | undefined {
	return extensionCallers.get(extension);
}

/** Herdr's answer for one submitted input: an attached client, signed in as `principal`. */
export interface HerdrInputAttestation {
	readonly principal: string;
}

/**
 * Asks the terminal host who submitted a line of pane input (smarty-dev#2637). Returns null when the host
 * cannot attest it (no herdr, herdr without attestation, API or send-keys input): the turn is `terminal`.
 */
export interface InputAttestationReader {
	attest(input: { text: string; receivedAt: string }): HerdrInputAttestation | null;
}

/**
 * Default reader. Herdr has no input attestation yet (smarty-dev#2637), so there is nothing to detect and it
 * always answers null. When herdr ships it, detect the capability here and keep null for any other host.
 */
export const herdrAttestationReader: InputAttestationReader = Object.freeze({ attest: () => null });

const MAX_FIELD_LENGTH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SENDER_KINDS = new Set<unknown>(["main", "actor", "agent", "remote"]);
const VERIFIED = new Set<unknown>(["mesh", "bridge"]);
const FABRIC_VIA = new Set<unknown>(["steer", "followUp", "actor", "replay"]);

function field(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= MAX_FIELD_LENGTH ? trimmed : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Copy of a valid sender with known fields only; undefined for any bad field. */
function sender(value: unknown): TurnSender | undefined {
	if (!isObject(value)) return undefined;
	const id = field(value.id);
	if (!id || !SENDER_KINDS.has(value.kind) || !VERIFIED.has(value.verified)) return undefined;
	if (value.name !== undefined && !field(value.name)) return undefined;
	const name = field(value.name);
	return Object.freeze({
		id,
		kind: value.kind as TurnSenderKind,
		...(name ? { name } : {}),
		verified: value.verified as TurnSender["verified"],
	});
}

function stamp(fields: Omit<TurnProvenance, "v" | "turnId" | "receivedAt">, receivedAt: string): TurnProvenance {
	return Object.freeze({ v: 1, turnId: randomUUID(), receivedAt, ...fields });
}

function samePath(left: string, right: string): boolean {
	if (left === right) return true;
	if (left.toLowerCase() !== right.toLowerCase()) return false;
	// realpath need not correct case on case-insensitive volumes. Accept a case alias only when
	// the filesystem confirms it is the same object, not a distinct case-sensitive file/directory.
	try {
		const a = statSync(left, { bigint: true });
		const b = statSync(right, { bigint: true });
		return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
	} catch {
		return false;
	}
}

function existingIdentity(identity: string, baseDir?: string): string | undefined {
	try {
		// An allowlist is an identity, not CLI input: trimming/folding can name a different existing object.
		return realpathSync(resolvePath(identity, baseDir, { homeDir: process.env.HOME || homedir() }));
	} catch {
		return undefined;
	}
}

/** Captured package identity or evaluated file; never re-resolve a saved caller pathname. */
export function extensionIdentity(caller: TurnProvenanceCaller): string {
	if (caller.sourceInfo.origin === "package") {
		const source = caller.sourceInfo.source;
		if (!isLocalPath(source)) return source;
		if (isAbsolute(normalizePath(source))) return source;
	}
	return caller.resolvedPath;
}

function trusts(allowed: unknown, caller: TurnProvenanceCaller): boolean {
	// A project-scoped extension comes from the checked-out repository, not from the user.
	if (caller.sourceInfo.scope === "project" || !Array.isArray(allowed)) return false;
	const packageSource = packageSources.get(caller);
	if (packageSource && allowed.includes(packageSource) && !reportedSourceRefusals.has(caller)) {
		reportedSourceRefusals.add(caller);
		process.stderr.write(
			`Turn provenance: refused Git/npm source grant ${JSON.stringify(packageSource)}; trust its installed file/directory path (e.g. ${JSON.stringify(caller.resolvedPath)}) instead.\n`,
		);
	}
	const loaded = loadedModules.get(caller);
	if (loaded && !isExtensionModuleCurrent(loaded)) return false;
	const source = extensionIdentity(caller);
	// ponytail: an observed Jiti graph is not proof of complete implementation coverage. Native
	// acquisition can bypass it without changing loading. Restore remote grants only with artifact
	// + complete implementation attestation; explicit evaluated-file/directory trust is separate.
	const sourceCurrent = source === caller.resolvedPath || isAbsolute(source);
	return [source, caller.resolvedPath].some(
		(id) =>
			(id !== source || sourceCurrent) &&
			allowed.some((item) => {
				if (typeof item !== "string" || item.trim() === "") return false;
				if (!isLocalPath(item) || item.startsWith("<")) return id === item;
				const path = existingIdentity(item);
				if (!path) return false;
				const directory = item.endsWith("/") || (process.platform === "win32" && item.endsWith("\\"));
				if (!directory) return samePath(id, path);
				if (id.startsWith(path.endsWith(sep) ? path : `${path}${sep}`)) return true;
				if (!isLocalPath(id) || id.startsWith("<")) return false;
				// Match directory case aliases at an actual ancestor, keeping sibling prefixes out.
				for (let parent = dirname(id); ; parent = dirname(parent)) {
					if (samePath(parent, path)) return true;
					if (parent === dirname(parent)) return false;
				}
			}),
	);
}

/**
 * Provenance of an extension API call, stamped now. `caller` is undefined when the harness cannot name the
 * extension (a `withSession` context, the public session methods): every claim is then refused.
 */
export function resolveExtensionTurnProvenance(
	claim: unknown,
	caller: TurnProvenanceCaller | undefined,
	trust: TurnProvenanceTrust | undefined,
	receivedAt = new Date().toISOString(),
): TurnProvenance {
	const refused = stamp({ channel: "terminal" }, receivedAt);
	if (!isObject(claim) || !caller || (claim.v !== undefined && claim.v !== TURN_PROVENANCE_VERSION)) return refused;
	if (claim.channel === "voice") {
		const id = field(isObject(claim.principal) ? claim.principal.id : undefined);
		if (!id || !trusts(trust?.voiceExtensions, caller)) return refused;
		return stamp({ channel: "voice", principal: Object.freeze({ id, binding: "voice-call" }) }, receivedAt);
	}
	if (claim.channel === "fabric") {
		const from = sender(claim.sender);
		if (!from || (claim.via !== undefined && !FABRIC_VIA.has(claim.via))) return refused;
		if (!trusts(trust?.fabricExtensions, caller)) return refused;
		const via = claim.via as TurnFabricVia | undefined;
		return stamp({ channel: "fabric", sender: from, ...(via ? { via } : {}) }, receivedAt);
	}
	// keyboard, terminal or anything else: an extension cannot claim typed input.
	return refused;
}

/**
 * Provenance of host input, stamped now. Only input from the interactive editor is offered to the
 * attestation reader; any failure, malformed answer or other path gives `terminal` with no principal.
 */
export function resolveHostTurnProvenance(
	text: string,
	interactive: boolean,
	reader: InputAttestationReader,
	receivedAt = new Date().toISOString(),
): TurnProvenance {
	if (interactive) {
		let principal: string | undefined;
		try {
			const answer: unknown = reader.attest({ text, receivedAt });
			principal = isObject(answer) ? field(answer.principal) : undefined;
		} catch {
			principal = undefined;
		}
		if (principal) {
			return stamp(
				{ channel: "keyboard", principal: Object.freeze({ id: principal, binding: "herdr-client" }) },
				receivedAt,
			);
		}
	}
	return stamp({ channel: "terminal" }, receivedAt);
}

/**
 * Read a turn entry's provenance. Returns undefined, meaning UNKNOWN, for entries that are not turns, for
 * entries written before this field, and for any record that is not a well-formed v1 record. Nothing is
 * inferred from message text.
 */
export function getTurnProvenance(entry: SessionEntry): TurnProvenance | undefined {
	let record: unknown;
	if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "custom"))
		record = entry.provenance;
	else if (entry.type === "custom_message") record = entry.provenance;
	else return undefined;
	if (!isObject(record) || record.v !== TURN_PROVENANCE_VERSION) return undefined;
	if (
		typeof record.turnId !== "string" ||
		!UUID.test(record.turnId) ||
		typeof record.receivedAt !== "string" ||
		!ISO_UTC.test(record.receivedAt)
	) {
		return undefined;
	}
	// Require the writer's canonical UTC format and reject dates that Date.parse normalizes (e.g. February 30).
	const receivedAt = Date.parse(record.receivedAt);
	if (!Number.isFinite(receivedAt) || new Date(receivedAt).toISOString() !== record.receivedAt) return undefined;
	const principal = isObject(record.principal) && field(record.principal.id) ? record.principal.binding : undefined;
	const hasSenderOrVia = record.sender !== undefined || record.via !== undefined;
	let readable: boolean;
	switch (record.channel) {
		case "keyboard":
			readable = principal === "herdr-client" && !hasSenderOrVia;
			break;
		case "voice":
			readable = principal === "voice-call" && !hasSenderOrVia;
			break;
		case "terminal":
			readable = record.principal === undefined && !hasSenderOrVia;
			break;
		case "fabric":
			readable =
				record.principal === undefined &&
				sender(record.sender) !== undefined &&
				(record.via === undefined || FABRIC_VIA.has(record.via));
			break;
		default:
			readable = false;
	}
	return readable ? (record as unknown as TurnProvenance) : undefined;
}
