/**
 * Per-turn sender origin (consumer contract: smarty-dev#2636; smarty-dev#2264, smarty-knowledge-3#623).
 *
 * The harness writes one `origin` record on each user message entry and each extension custom message
 * entry at receipt time. It is derived only from the API path that delivered the turn, the identity of
 * the calling extension, and the launch binding. Message text never sets it, so text that claims to
 * come from Fabric, a voice call or a principal cannot change it.
 */
import type { SessionEntry } from "./session-manager.ts";
import type { SourceInfo } from "./source-info.ts";

/**
 * - `keyboard`: host input (interactive editor, print or JSON prompt, RPC or SDK prompt)
 * - `voice`: the trusted voice extension, bound to the call's principal
 * - `fabric`: injected by Fabric (steer, follow-up, actor) with the mesh-verified sender
 * - `unknown`: any other extension, or a claim the harness refused
 */
export type TurnChannel = "keyboard" | "voice" | "fabric" | "unknown";

/** A principal and how the harness bound it: `launch` (PI_LAUNCH_PRINCIPAL) or `voice-call` (the voice extension). */
export interface TurnPrincipal {
	readonly id: string;
	readonly binding: "launch" | "voice-call";
}

/** The Fabric sender: its verified mesh id and kind. */
export interface TurnSender {
	readonly id: string;
	readonly kind: string;
	readonly name?: string;
}

/** Harness-written origin of one turn. Stored on the session entry, frozen in memory. */
export interface TurnOrigin {
	readonly channel: TurnChannel;
	/** Stable per-turn id: the session entry id. */
	readonly turnId: string;
	/** ISO time at which the harness received the turn. */
	readonly receivedAt: string;
	readonly principal?: TurnPrincipal;
	readonly sender?: TurnSender;
	/** Entry point that stamped it: `interactive`, `print`, `json`, `rpc`, or `extension:<identity>`. */
	readonly via: string;
}

/** An origin before its entry exists; the session manager adds `turnId` when it appends the entry. */
export type TurnOriginDraft = Omit<TurnOrigin, "turnId">;

/** Read result for entries written before origins existed, or with an unreadable record. */
export interface UnknownTurnOrigin {
	readonly channel: "unknown";
}

/**
 * Channel claim an extension (or, for `fabric` only, an SDK or RPC host) may pass. The harness accepts
 * a claim only from a caller that trusted settings allow for that channel; otherwise it records `unknown`.
 */
export type TurnOriginClaim =
	| { channel: "voice"; principal: { id: string } }
	| { channel: "fabric"; sender: { id: string; kind: string; name?: string } };

/**
 * Trusted callers per claim channel. Read from global settings only: a project's settings must not grant
 * an extension the right to speak for a principal. Each item matches a package source
 * (for example `git:github.com/Smarty-Pants-Inc/smarty-voice`) or an extension's resolved path exactly;
 * an item ending in `/` matches every source or path under that directory (for example a release root).
 */
export interface TurnOriginTrust {
	voiceExtensions?: string[];
	fabricExtensions?: string[];
}

/** The calling extension, as the harness knows it (never supplied by the extension). */
export interface TurnOriginCaller {
	readonly resolvedPath: string;
	readonly sourceInfo: SourceInfo;
}

/** Host input path that stamped a keyboard turn. */
export type TurnHostVia = "interactive" | "print" | "json" | "rpc";

/** Environment variable a launcher (smarty-role) sets to the principal id bound to an interactive session. */
export const LAUNCH_PRINCIPAL_ENV = "PI_LAUNCH_PRINCIPAL";

export const UNKNOWN_TURN_ORIGIN: UnknownTurnOrigin = Object.freeze({ channel: "unknown" });

const MAX_FIELD_LENGTH = 200;
const CHANNELS = new Set<string>(["keyboard", "voice", "fabric", "unknown"]);

function field(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= MAX_FIELD_LENGTH ? trimmed : undefined;
}

// Read once, when the module loads: before any extension code runs and can change process.env.
const launchPrincipalAtStart = field(process.env[LAUNCH_PRINCIPAL_ENV]);

/** The principal bound at launch, or undefined. The CLI removes the variable so children do not inherit it. */
export function launchPrincipal(): string | undefined {
	return launchPrincipalAtStart;
}

/** Copy only known string fields; undefined when id or kind is missing. */
function sender(value: unknown): TurnSender | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const id = field(record.id);
	const kind = field(record.kind);
	if (!id || !kind) return undefined;
	const name = field(record.name);
	return Object.freeze({ id, kind, ...(name ? { name } : {}) });
}

function claimChannel(claim: unknown): "voice" | "fabric" | undefined {
	if (typeof claim !== "object" || claim === null) return undefined;
	const channel = (claim as { channel?: unknown }).channel;
	return channel === "voice" || channel === "fabric" ? channel : undefined;
}

/** Stable identity of an extension: its package source when installed as a package, else its resolved path. */
export function extensionIdentity(caller: TurnOriginCaller): string {
	return caller.sourceInfo.origin === "package" ? caller.sourceInfo.source : caller.resolvedPath;
}

function trusts(allowed: unknown, caller: TurnOriginCaller): boolean {
	// A project-scoped extension comes from the checked-out repository, not from the user.
	if (caller.sourceInfo.scope === "project" || !Array.isArray(allowed)) return false;
	return [extensionIdentity(caller), caller.resolvedPath].some((id) =>
		allowed.some(
			(item) => typeof item === "string" && item !== "" && (item.endsWith("/") ? id.startsWith(item) : id === item),
		),
	);
}

/** Origin of an extension API call. `caller` is undefined when the harness cannot name the extension. */
export function resolveExtensionTurnOrigin(
	claim: unknown,
	caller: TurnOriginCaller | undefined,
	trust: TurnOriginTrust | undefined,
	receivedAt: string,
): TurnOriginDraft {
	const via = caller ? `extension:${extensionIdentity(caller)}` : "extension";
	const unknown: TurnOriginDraft = { channel: "unknown", receivedAt, via };
	const channel = claimChannel(claim);
	if (!channel || !caller) return unknown;
	if (channel === "voice") {
		const id = field((claim as { principal?: { id?: unknown } }).principal?.id);
		if (!id || !trusts(trust?.voiceExtensions, caller)) return unknown;
		return { channel, receivedAt, principal: Object.freeze({ id, binding: "voice-call" }), via };
	}
	const from = sender((claim as { sender?: unknown }).sender);
	if (!from || !trusts(trust?.fabricExtensions, caller)) return unknown;
	return { channel, receivedAt, sender: from, via };
}

/**
 * Origin of host input. The host process owner may mark a turn as Fabric-sent; it cannot claim a voice
 * turn. A keyboard turn carries the launch principal only on the interactive editor path: RPC and print
 * hosts can be other programs (a Fabric process worker inherits its parent's environment).
 * @throws Error on a voice claim or a malformed Fabric claim
 */
export function resolveHostTurnOrigin(
	claim: unknown,
	via: TurnHostVia,
	principalId: string | undefined,
	receivedAt: string,
): TurnOriginDraft {
	if (claim === undefined) {
		return {
			channel: "keyboard",
			receivedAt,
			...(principalId && via === "interactive"
				? { principal: Object.freeze({ id: principalId, binding: "launch" as const }) }
				: {}),
			via,
		};
	}
	if (claimChannel(claim) !== "fabric") {
		throw new Error('Only an origin of channel "fabric" is accepted on this input path');
	}
	const from = sender((claim as { sender?: unknown }).sender);
	if (!from) throw new Error("A fabric origin needs sender.id and sender.kind (non-empty, at most 200 characters)");
	return { channel: "fabric", receivedAt, sender: from, via };
}

/** Complete a draft with its entry id. */
export function stampTurnOrigin(draft: TurnOriginDraft, turnId: string): TurnOrigin {
	return Object.freeze({ ...draft, turnId });
}

/**
 * Read a turn entry's origin. User message entries and custom message entries return their record, or
 * `{channel: "unknown"}` when none was written (sessions from before this field) or the record is
 * unreadable. Other entries return undefined: they are not turns. Nothing is inferred from message text.
 */
export function getTurnOrigin(entry: SessionEntry): TurnOrigin | UnknownTurnOrigin | undefined {
	if (entry.type === "message") {
		if (entry.message.role !== "user") return undefined;
	} else if (entry.type !== "custom_message") {
		return undefined;
	}
	const stored: unknown = entry.origin;
	if (typeof stored !== "object" || stored === null) return UNKNOWN_TURN_ORIGIN;
	const record = stored as Record<string, unknown>;
	const principal = record.principal as Record<string, unknown> | undefined;
	const readable =
		CHANNELS.has(record.channel as string) &&
		record.turnId === entry.id &&
		typeof record.receivedAt === "string" &&
		typeof record.via === "string" &&
		(record.channel !== "voice" || principal?.binding === "voice-call") &&
		(record.channel !== "keyboard" || principal === undefined || principal.binding === "launch") &&
		(record.channel !== "fabric" || typeof (record.sender as Record<string, unknown> | undefined)?.id === "string");
	return readable ? (stored as TurnOrigin) : UNKNOWN_TURN_ORIGIN;
}
