/**
 * Per-turn sender provenance (smarty-dev#2264, smarty-knowledge-3#623).
 *
 * The harness writes one `provenance` record on each user message entry and each extension custom
 * message entry. It is derived only from the API path that delivered the turn and the identity of
 * the calling extension. Message text never sets it, so text that claims to come from an agent or a
 * voice call cannot change it.
 */
import type { SessionEntry } from "./session-manager.ts";
import type { SourceInfo } from "./source-info.ts";

/** A person or agent named by a provenance record. */
export interface TurnParty {
	/** Stable id (for example a Fabric agent id or a principal id). */
	readonly id: string;
	/** Display name. */
	readonly name?: string;
	/** Kind label from the sender's system (for example "main", "task", "principal"). */
	readonly kind?: string;
}

/**
 * How the turn reached the session:
 * - `tui`, `print`, `json`, `rpc`: the host input path (interactive editor, print or JSON mode, RPC command)
 * - `extension`: an extension API call (`pi.sendUserMessage`, `pi.sendMessage`)
 */
export type TurnVia = "tui" | "print" | "json" | "rpc" | "extension";

/** Harness-written origin of one turn. Stored on the session entry, frozen in memory. */
export interface TurnProvenance {
	/**
	 * - `keyboard`: the host input path (editor submit, print prompt, RPC prompt) with no agent claim
	 * - `voice`: the trusted voice extension, bound to the call's principal
	 * - `agent`: an agent-injected turn (Fabric steer or follow-up) with its sender
	 * - `extension`: any other extension-injected turn; names no person
	 */
	readonly kind: "keyboard" | "voice" | "agent" | "extension";
	readonly via: TurnVia;
	/** Identity of the calling extension (package source, or resolved path), written by the harness. */
	readonly extension?: string;
	/** For `voice`: the call's principal, supplied by the trusted voice extension. */
	readonly principal?: TurnParty;
	/** For `agent`: the sending agent. */
	readonly sender?: TurnParty;
	/** A voice or agent claim the harness refused (caller not trusted for it); the kind stays `extension`. */
	readonly rejectedClaim?: "voice" | "agent";
}

/** Read result for entries written before provenance existed, or with an unreadable record. */
export interface UnknownTurnProvenance {
	readonly kind: "unknown";
}

/**
 * Origin claim an extension (or, for `agent` only, an SDK or RPC host) may pass. The harness accepts a
 * claim only from a caller that trusted settings allow for that kind; otherwise it records `extension`.
 */
export type TurnOriginClaim = { kind: "voice"; principal: TurnParty } | { kind: "agent"; sender: TurnParty };

/**
 * Trusted callers per claim kind. Read from global settings only: a project's settings must not grant
 * an extension the right to speak for a principal. Each item matches a package source
 * (for example `git:github.com/Smarty-Pants-Inc/smarty-voice`) or an extension's resolved path.
 */
export interface TurnProvenanceTrust {
	voiceExtensions?: string[];
	agentExtensions?: string[];
}

/** The calling extension, as the harness knows it (never supplied by the extension). */
export interface TurnProvenanceCaller {
	readonly resolvedPath: string;
	readonly sourceInfo: SourceInfo;
}

export const UNKNOWN_TURN_PROVENANCE: UnknownTurnProvenance = Object.freeze({ kind: "unknown" });

const MAX_FIELD_LENGTH = 200;
const KINDS = new Set(["keyboard", "voice", "agent", "extension"]);
const VIAS = new Set(["tui", "print", "json", "rpc", "extension"]);

function field(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= MAX_FIELD_LENGTH ? trimmed : undefined;
}

/** Copy only known string fields; undefined when the id is missing. */
function party(value: unknown): TurnParty | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const id = field(record.id);
	if (!id) return undefined;
	const name = field(record.name);
	const kind = field(record.kind);
	return Object.freeze({ id, ...(name ? { name } : {}), ...(kind ? { kind } : {}) });
}

function claimKind(claim: unknown): "voice" | "agent" | undefined {
	if (typeof claim !== "object" || claim === null) return undefined;
	const kind = (claim as { kind?: unknown }).kind;
	return kind === "voice" || kind === "agent" ? kind : undefined;
}

function freeze(provenance: TurnProvenance): TurnProvenance {
	return Object.freeze(provenance);
}

/** Stable identity of an extension: its package source when installed as a package, else its resolved path. */
export function extensionIdentity(caller: TurnProvenanceCaller): string {
	return caller.sourceInfo.origin === "package" ? caller.sourceInfo.source : caller.resolvedPath;
}

/** Provenance for an extension API call. `caller` is undefined when the harness cannot name the extension. */
export function resolveExtensionTurnProvenance(
	claim: unknown,
	caller: TurnProvenanceCaller | undefined,
	trust: TurnProvenanceTrust | undefined,
): TurnProvenance {
	const extension = caller ? extensionIdentity(caller) : undefined;
	const base: TurnProvenance = { kind: "extension", via: "extension", ...(extension ? { extension } : {}) };
	if (claim === undefined) return freeze(base);
	const kind = claimKind(claim);
	if (!kind) return freeze(base);
	const allowed = kind === "voice" ? trust?.voiceExtensions : trust?.agentExtensions;
	const trusted =
		caller !== undefined &&
		// A project-scoped extension comes from the checked-out repository, not from the user.
		caller.sourceInfo.scope !== "project" &&
		Array.isArray(allowed) &&
		(allowed.includes(extensionIdentity(caller)) || allowed.includes(caller.resolvedPath));
	const who =
		kind === "voice"
			? party((claim as { principal?: unknown }).principal)
			: party((claim as { sender?: unknown }).sender);
	if (!trusted || !who) return freeze({ ...base, rejectedClaim: kind });
	return freeze(
		kind === "voice"
			? { kind: "voice", via: "extension", extension, principal: who }
			: { kind: "agent", via: "extension", extension, sender: who },
	);
}

/**
 * Provenance for the host input path (interactive editor, print, JSON or RPC). The host process owner
 * may mark a turn as agent-sent (a downgrade from keyboard). It cannot claim a voice turn.
 * @throws Error on a voice claim or a malformed agent claim
 */
export function resolveHostTurnProvenance(claim: unknown, via: Exclude<TurnVia, "extension">): TurnProvenance {
	if (claim === undefined) return freeze({ kind: "keyboard", via });
	if (claimKind(claim) !== "agent") {
		throw new Error('Only an origin of kind "agent" is accepted on this input path');
	}
	const sender = party((claim as { sender?: unknown }).sender);
	if (!sender) throw new Error("An agent origin needs sender.id (a non-empty string of at most 200 characters)");
	return freeze({ kind: "agent", via, sender });
}

/**
 * Read a turn entry's provenance. User message entries and custom message entries return their record,
 * or `unknown` when none was written (sessions from before this field) or the record is unreadable.
 * Other entries return undefined: they are not turns. Nothing is inferred from message text.
 */
export function getTurnProvenance(entry: SessionEntry): TurnProvenance | UnknownTurnProvenance | undefined {
	if (entry.type === "message") {
		if (entry.message.role !== "user") return undefined;
	} else if (entry.type !== "custom_message") {
		return undefined;
	}
	const stored: unknown = entry.provenance;
	if (typeof stored !== "object" || stored === null) return UNKNOWN_TURN_PROVENANCE;
	const record = stored as Record<string, unknown>;
	if (!KINDS.has(record.kind as string) || !VIAS.has(record.via as string)) return UNKNOWN_TURN_PROVENANCE;
	return stored as TurnProvenance;
}
