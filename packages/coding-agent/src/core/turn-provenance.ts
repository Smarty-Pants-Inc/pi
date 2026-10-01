/**
 * Per-turn sender provenance, v1 (contract: smarty-dev#2636 comment 5913265017; smarty-dev#2264).
 *
 * The harness writes one `provenance` record on each user message entry and each extension custom message
 * entry, once, at first receipt. It comes only from the API path that delivered the turn, the identity the
 * extension loader knows for the calling extension, and (for typed input) a herdr input attestation.
 * Message text never sets it, and nothing rewrites it later.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, sep } from "node:path";
import { canonicalizePath, isLocalPath, normalizePath, resolvePath } from "../utils/paths.ts";
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
 * package source) exactly. Local paths are resolved and symlinks followed before matching; npm/git sources
 * match exactly without filesystem normalization. An item ending in `/` matches everything under that
 * directory, for example the smarty-voice release root, whose release directories the installer verifies.
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

/** Host-only: finalize once, after the resource loader has assigned authoritative source metadata. */
export function finalizeExtensionTurnProvenanceCaller(
	extension: TurnProvenanceCaller,
	localPackageBaseDir?: string,
): void {
	if (extensionCallers.has(extension)) return;
	const sourceInfo = { ...extension.sourceInfo };
	if (sourceInfo.origin === "package" && isLocalPath(sourceInfo.source)) {
		// Keep the configured spelling for inspection, never for attribution. The default loader knows
		// the package's scope base; a custom loader without one can only use an absolute source or file.
		sourceInfo.source = localPackageBaseDir
			? normalizeIdentity(sourceInfo.source, localPackageBaseDir)
			: extensionIdentity(extension);
	}
	extensionCallers.set(
		extension,
		Object.freeze({
			resolvedPath: normalizeIdentity(extension.resolvedPath),
			sourceInfo: Object.freeze(sourceInfo),
		}),
	);
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

function normalizeIdentity(identity: string, baseDir?: string): string {
	if (identity.startsWith("<") || !isLocalPath(identity)) return identity;
	// Let realpath restore filesystem spelling, not blanket case-folding: even Windows can have
	// case-sensitive directories, whose distinct files must not share attribution authority.
	return canonicalizePath(resolvePath(identity, baseDir, { trim: true, homeDir: process.env.HOME || homedir() }));
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

/** Package identity or resolved file, never an unresolved local package spelling. */
export function extensionIdentity(caller: TurnProvenanceCaller): string {
	if (caller.sourceInfo.origin === "package") {
		const source = caller.sourceInfo.source;
		if (!isLocalPath(source)) return source;
		if (isAbsolute(normalizePath(source))) return normalizeIdentity(source);
	}
	return normalizeIdentity(caller.resolvedPath);
}

function trusts(allowed: unknown, caller: TurnProvenanceCaller): boolean {
	// A project-scoped extension comes from the checked-out repository, not from the user.
	if (caller.sourceInfo.scope === "project" || !Array.isArray(allowed)) return false;
	return [extensionIdentity(caller), normalizeIdentity(caller.resolvedPath)].some((id) =>
		allowed.some((item) => {
			if (typeof item !== "string" || item.trim() === "") return false;
			if (!isLocalPath(item) || item.startsWith("<")) return id === item;
			const path = normalizeIdentity(item);
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
