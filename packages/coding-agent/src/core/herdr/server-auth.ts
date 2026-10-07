/**
 * Herdr server authentication for the input consumer (smarty-dev#2636, decision 3 B).
 *
 * Problem: an agent can own a PTY master, start Pi on the slave and answer as a fake Herdr; the
 * nonce marker and a ptmx check both pass for it. So Pi trusts only answers bound to a key that
 * only the installed, setgid (non-dumpable) Herdr can read:
 * - enroll: Ed25519 signature over Pi's challenge, the epoch, SHA-256(epoch_key), the nonce, the
 *   pane id and the pane slave's dev/ino. Pi checks the key and that the tty is its own stdin.
 * - cut: HMAC-SHA256(epoch_key) over the request and the answer.
 * Every field is encoded as a u32 big-endian byte length plus UTF-8 bytes, so no two field lists
 * share an encoding. Any failure means "no epoch" or "unknown", never a label.
 */
import { createHash, createHmac, createPublicKey, type KeyObject, timingSafeEqual, verify } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const SERVER_PUBLIC_KEY_PATH = "/etc/herdr/server.pub";
const ENROLL_DOMAIN = "herdr-enroll-v1";
const CUT_DOMAIN = "herdr-cut-v1";

export interface TtyId {
	readonly dev: bigint;
	readonly ino: bigint;
}

export interface EnrollAnswer {
	readonly epoch: string;
	readonly epochKey: Buffer;
	readonly nonce: string;
	readonly tty: TtyId;
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

/** Length-prefixed field encoding shared by the signature and the MAC. */
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
		createHash("sha256").update(answer.epochKey).digest("hex"),
		answer.nonce,
		paneId,
		answer.tty.dev.toString(),
		answer.tty.ino.toString(),
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

export function cutMac(epochKey: Buffer, request: CutRequest, answer: CutAnswer): Buffer {
	return createHmac("sha256", epochKey).update(cutMessage(request, answer)).digest();
}

/** True only for a valid signature by the trust root over this challenge, for this process's own tty. */
export function verifyEnroll(
	trustRoot: KeyObject | undefined,
	challenge: Buffer,
	paneId: string,
	answer: EnrollAnswer,
	ownTty: TtyId,
): boolean {
	if (!trustRoot || answer.tty.dev !== ownTty.dev || answer.tty.ino !== ownTty.ino) return false;
	try {
		return verify(null, enrollMessage(challenge, paneId, answer), trustRoot, answer.sig);
	} catch {
		return false;
	}
}

export function verifyCut(epochKey: Buffer, request: CutRequest, answer: CutAnswer, mac: Buffer): boolean {
	const expected = cutMac(epochKey, request, answer);
	return mac.length === expected.length && timingSafeEqual(mac, expected);
}

/**
 * The production trust root. Returns undefined unless the key file and its directory are root-owned
 * and not group- or world-writable, and the key is Ed25519; same-uid agents must not be able to swap it.
 */
export function loadServerTrustRoot(path = SERVER_PUBLIC_KEY_PATH): KeyObject | undefined {
	try {
		for (const target of [path, dirname(path)]) {
			const stat = statSync(target);
			if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) return undefined;
		}
		const key = createPublicKey(readFileSync(path));
		return key.asymmetricKeyType === "ed25519" ? key : undefined;
	} catch {
		return undefined;
	}
}
