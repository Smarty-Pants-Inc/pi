/**
 * Herdr server authentication for the input consumer, protocol E' v2 (smarty-dev#2636).
 *
 * Problem: an agent can replace Herdr's socket (it lives in the user's config directory) and answer
 * as a fake Herdr. v1 sent an `epoch_key` bearer on every cut, so a socket replacer could MAC its own
 * `client` answers (6b5724fd). v2 keeps no secret in Pi: Herdr signs every answer with its server key
 * (Ed25519; only the setgid, non-dumpable Herdr can read it) over values Pi chose:
 * - enroll: Pi's fresh challenge, the epoch, the nonce, the pane id, the pane slave's dev/ino, and
 *   the pid and pid namespace of the peer Herdr pinned. Pi checks that the tty is its stdin and that
 *   the pinned peer is itself; Herdr then accepts cuts for the epoch only from that process.
 * - cut: the whole request (with its fresh per-cut token) plus the result and principal.
 * Every field is encoded as a u32 big-endian byte length plus UTF-8 bytes, so two field lists of the
 * same count never share an encoding, and the domain label separates enroll from cut. Any failure
 * means "no epoch" or "unknown", never a label.
 */
import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const SERVER_PUBLIC_KEY_PATH = "/etc/herdr/server.pub";
const ENROLL_DOMAIN = "herdr-enroll-v2";
const CUT_DOMAIN = "herdr-cut-answer-v2";

export interface TtyId {
	readonly dev: bigint;
	readonly ino: bigint;
}

/** The process Herdr pinned at enroll: its pid in Herdr's pid namespace, and that namespace's inode. */
export interface PeerId {
	readonly pid: bigint;
	readonly pidns: bigint;
}

export interface EnrollAnswer {
	readonly epoch: string;
	readonly nonce: string;
	readonly tty: TtyId;
	readonly peer: PeerId;
	readonly sig: Buffer;
}

export interface CutRequest {
	readonly epoch: string;
	readonly seq: number;
	readonly token: string;
	readonly cut: number;
	readonly digest: string;
	readonly kind: "submit" | "discard";
}

export interface CutAnswer {
	readonly result: "client" | "api" | "mixed" | "unknown";
	readonly reason?: string;
	readonly principal?: { readonly smartyId: string; readonly displayName: string };
}

/** Length-prefixed field encoding shared by both signed messages. */
export function encodeFields(fields: readonly string[]): Buffer {
	const parts: Buffer[] = [];
	for (const field of fields) {
		const bytes = Buffer.from(field, "utf8");
		const length = Buffer.alloc(4);
		length.writeUInt32BE(bytes.length);
		parts.push(length, bytes);
	}
	return Buffer.concat(parts);
}

export function enrollMessage(challenge: Buffer, paneId: string, answer: Omit<EnrollAnswer, "sig">): Buffer {
	return encodeFields([
		ENROLL_DOMAIN,
		challenge.toString("hex"),
		answer.epoch,
		answer.nonce,
		paneId,
		answer.tty.dev.toString(),
		answer.tty.ino.toString(),
		answer.peer.pid.toString(),
		answer.peer.pidns.toString(),
	]);
}

export function cutMessage(request: CutRequest, answer: CutAnswer): Buffer {
	return encodeFields([
		CUT_DOMAIN,
		request.epoch,
		String(request.seq),
		request.token,
		String(request.cut),
		request.digest,
		request.kind,
		answer.result,
		answer.reason ?? "",
		answer.principal?.smartyId ?? "",
		answer.principal?.displayName ?? "",
	]);
}

function verifySig(trustRoot: KeyObject, message: Buffer, sig: Buffer): boolean {
	try {
		return sig.length === 64 && verify(null, message, trustRoot, sig);
	} catch {
		return false;
	}
}

/**
 * True only for a valid signature by the trust root over Pi's own challenge and pane, for this
 * process's own tty, pinning this process (pid and pid namespace) as the epoch's peer.
 */
export function verifyEnroll(
	trustRoot: KeyObject | undefined,
	challenge: Buffer,
	paneId: string,
	answer: EnrollAnswer,
	own: { readonly tty: TtyId; readonly peer: PeerId },
): boolean {
	if (!trustRoot) return false;
	if (answer.tty.dev !== own.tty.dev || answer.tty.ino !== own.tty.ino) return false;
	if (answer.peer.pid !== own.peer.pid || answer.peer.pidns !== own.peer.pidns) return false;
	return verifySig(trustRoot, enrollMessage(challenge, paneId, answer), answer.sig);
}

export function verifyCut(trustRoot: KeyObject, request: CutRequest, answer: CutAnswer, sig: Buffer): boolean {
	return verifySig(trustRoot, cutMessage(request, answer), sig);
}

/** A trust root key file that exists: either an accepted key or the check that rejected it. */
export type ServerTrustRoot = { readonly key: KeyObject } | { readonly rejected: string };

/**
 * The production trust root. Undefined when the key file does not exist (Herdr is not installed on
 * this host). Otherwise the key is accepted only if the key file and its directory are root-owned and
 * not group- or world-writable, and the key is Ed25519; same-uid agents must not be able to swap it.
 */
export function checkServerTrustRoot(path = SERVER_PUBLIC_KEY_PATH): ServerTrustRoot | undefined {
	try {
		lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return { rejected: "untrusted-trust-root" };
	}
	try {
		for (const target of [path, dirname(path)]) {
			const stat = statSync(target);
			if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) return { rejected: "untrusted-trust-root" };
		}
	} catch {
		// A dangling symlink or an unreadable directory: present, but not a key Pi can trust.
		return { rejected: "untrusted-trust-root" };
	}
	try {
		const key = createPublicKey(readFileSync(path));
		return key.asymmetricKeyType === "ed25519" ? { key } : { rejected: "trust-root-not-ed25519" };
	} catch {
		return { rejected: "unparsable-trust-root" };
	}
}

export function loadServerTrustRoot(path = SERVER_PUBLIC_KEY_PATH): KeyObject | undefined {
	const root = checkServerTrustRoot(path);
	return root && "key" in root ? root.key : undefined;
}
