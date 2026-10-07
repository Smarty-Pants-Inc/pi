/**
 * Herdr input-consumer client (smarty-dev#2636; decisions 1 and 3 B in the Pi PR).
 *
 * Talks Herdr's newline-delimited JSON API (`{id, method, params}` -> `{id, result}|{id, error}`).
 * The epoch_key stays in this closure; nothing here is reachable from extensions or settings.
 * Fail closed: any transport error, refusal, bad signature, tty mismatch, bad MAC or malformed
 * answer gives no epoch or an `unknown` cut, which callers record as `channel: "terminal"`.
 */
import { type KeyObject, randomBytes } from "node:crypto";
import { fstatSync } from "node:fs";
import { connectRpc } from "./rpc.ts";
import {
	type CutAnswer,
	type CutRequest,
	type EnrollAnswer,
	type TtyId,
	verifyCut,
	verifyEnroll,
} from "./server-auth.ts";

export type EnrollFailure = "no-trust-root" | "transport" | "refused" | "server-unauthenticated" | "malformed";

export interface HerdrEpoch {
	readonly epoch: string;
	readonly nonce: string;
	/** Ask who wrote the interval. Never rejects; a failed MAC also ends the epoch. */
	cut(request: Omit<CutRequest, "epoch">): Promise<CutAnswer>;
	release(): void;
}

export interface EnrollOptions {
	readonly socketPath: string;
	readonly paneId: string;
	readonly trustRoot: KeyObject | undefined;
	readonly timeoutMs?: number;
	/** The tty Pi reads; defaults to fd 0. */
	readonly ttyFd?: number;
}

const HEX = /^[0-9a-f]+$/;
const DECIMAL = /^[0-9]{1,20}$/;

function parseEnroll(result: Record<string, unknown>): EnrollAnswer | undefined {
	const { epoch, epoch_key, nonce, tty, sig } = result;
	if (typeof epoch !== "string" || !epoch || typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce))
		return undefined;
	if (typeof epoch_key !== "string" || epoch_key.length !== 64 || !HEX.test(epoch_key)) return undefined;
	if (typeof sig !== "string" || typeof tty !== "object" || tty === null) return undefined;
	const { dev, ino } = tty as { dev?: unknown; ino?: unknown };
	if (typeof dev !== "string" || !DECIMAL.test(dev) || typeof ino !== "string" || !DECIMAL.test(ino)) return undefined;
	return {
		epoch,
		epochKey: Buffer.from(epoch_key, "hex"),
		nonce,
		tty: { dev: BigInt(dev), ino: BigInt(ino) },
		sig: Buffer.from(sig, "base64"),
	};
}

function parseCut(result: Record<string, unknown>): { answer: CutAnswer; mac: Buffer } | undefined {
	const { result: kind, reason, principal, mac } = result;
	if (kind !== "client" && kind !== "api" && kind !== "mixed" && kind !== "unknown") return undefined;
	if (typeof mac !== "string" || mac.length !== 64 || !HEX.test(mac)) return undefined;
	if (reason !== undefined && typeof reason !== "string") return undefined;
	let parsed: CutAnswer["principal"];
	if (principal !== undefined && principal !== null) {
		const { smarty_id, display_name } = principal as { smarty_id?: unknown; display_name?: unknown };
		if (typeof smarty_id !== "string" || typeof display_name !== "string") return undefined;
		parsed = { smartyId: smarty_id, displayName: display_name };
	}
	return { answer: { result: kind, reason, principal: parsed }, mac: Buffer.from(mac, "hex") };
}

const UNSAFE_NAME = /[*\\():\p{Cc}]/u;

/**
 * The principal a cut answer attributes the interval to, or undefined. Only `client` with a
 * well-formed principal counts; a display name that could forge or break the sender label is unmapped.
 */
export function attestedPrincipal(answer: CutAnswer): { smartyId: string; displayName: string } | undefined {
	if (answer.result !== "client" || !answer.principal) return undefined;
	const { smartyId, displayName } = answer.principal;
	if (!/^[A-Za-z0-9_.-]{1,64}$/.test(smartyId)) return undefined;
	if (displayName.length < 1 || displayName.length > 80 || UNSAFE_NAME.test(displayName)) return undefined;
	return { smartyId, displayName };
}

function ownTty(fd: number): TtyId {
	const stat = fstatSync(fd, { bigint: true });
	return { dev: stat.dev, ino: stat.ino };
}

export async function enrollHerdrInputConsumer(
	options: EnrollOptions,
): Promise<{ ok: true; epoch: HerdrEpoch } | { ok: false; reason: EnrollFailure }> {
	if (!options.trustRoot) return { ok: false, reason: "no-trust-root" };
	const timeoutMs = options.timeoutMs ?? 2000;
	let connection: ReturnType<typeof connectRpc>;
	try {
		connection = connectRpc(options.socketPath, timeoutMs);
	} catch {
		return { ok: false, reason: "transport" };
	}
	const challenge = randomBytes(32);
	let result: Record<string, unknown>;
	try {
		result = await connection.rpc("pane.input_consumer.enroll", {
			pane_id: options.paneId,
			challenge: challenge.toString("hex"),
		});
	} catch (error) {
		connection.close();
		return { ok: false, reason: error instanceof Error && error.message === "refused" ? "refused" : "transport" };
	}
	const answer = parseEnroll(result);
	if (!answer) {
		connection.close();
		return { ok: false, reason: "malformed" };
	}
	let tty: TtyId;
	try {
		tty = ownTty(options.ttyFd ?? 0);
	} catch {
		connection.close();
		return { ok: false, reason: "server-unauthenticated" };
	}
	if (!verifyEnroll(options.trustRoot, challenge, options.paneId, answer, tty)) {
		connection.close();
		return { ok: false, reason: "server-unauthenticated" };
	}
	return { ok: true, epoch: openEpoch(connection, answer) };
}

function openEpoch(connection: ReturnType<typeof connectRpc>, enrolled: EnrollAnswer): HerdrEpoch {
	const epochKey = enrolled.epochKey;
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		connection
			.rpc("pane.input_consumer.release", { epoch: enrolled.epoch, epoch_key: epochKey.toString("hex") })
			.then(
				() => connection.close(),
				() => connection.close(),
			);
	};
	return {
		epoch: enrolled.epoch,
		nonce: enrolled.nonce,
		async cut(partial) {
			const unknown = (reason: string): CutAnswer => ({ result: "unknown", reason });
			if (ended) return unknown("epoch-ended");
			const request: CutRequest = { ...partial, epoch: enrolled.epoch };
			let result: Record<string, unknown>;
			try {
				result = await connection.rpc("pane.input_consumer.cut", {
					epoch: request.epoch,
					epoch_key: epochKey.toString("hex"),
					seq: request.seq,
					token: request.token,
					cut: request.cut,
					digest: request.digest,
					kind: request.kind,
				});
			} catch {
				return unknown("transport");
			}
			const parsed = parseCut(result);
			if (!parsed || !verifyCut(epochKey, request, parsed.answer, parsed.mac)) {
				end();
				return unknown("bad-mac");
			}
			return parsed.answer;
		},
		release: end,
	};
}
