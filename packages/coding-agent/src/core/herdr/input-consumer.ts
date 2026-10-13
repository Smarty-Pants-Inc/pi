/**
 * Herdr input-consumer client (smarty-dev#2636; decisions 1 and 3 B in the Pi PR).
 *
 * Talks Herdr's newline-delimited JSON API (`{id, method, params}` -> `{id, result}|{id, error}`).
 * Herdr answers one request per connection and then closes it, so every request (enroll, each cut,
 * release) opens its own connection. Protocol E' v2: Pi holds no secret. Herdr finds an epoch by
 * `epoch` and accepts its cut and release only from the process it pinned at enroll; Pi checks at
 * enroll that the signed pin names itself, and verifies Herdr's signature on every cut answer.
 * Fail closed: any transport error, refusal, bad signature, tty or peer mismatch, or malformed
 * answer gives no epoch or an `unknown` cut, which callers record as `channel: "terminal"`.
 */
import { type KeyObject, randomBytes } from "node:crypto";
import { fstatSync, statSync } from "node:fs";
import { connectRpc, HerdrRpcProtocolError } from "./rpc.ts";
import {
	type CutAnswer,
	type CutRequest,
	type EnrollAnswer,
	type PeerId,
	type TtyId,
	verifyCut,
	verifyEnroll,
} from "./server-auth.ts";

export type EnrollFailure = "no-trust-root" | "transport" | "refused" | "server-unauthenticated" | "malformed";

export interface HerdrEpoch {
	readonly epoch: string;
	readonly nonce: string;
	/** Ask who wrote the interval. Never rejects; a bad or missing signature also ends the epoch. */
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

const EPOCH = /^[0-9a-f]{32}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

type Fields = Record<string, unknown>;

/** A JSON object whose keys are all in `allowed`; v2 answers carry nothing else (no `epoch_key`, no `mac`). */
function strict(value: unknown, allowed: readonly string[]): Fields | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return Object.keys(value).every((key) => allowed.includes(key)) ? (value as Fields) : undefined;
}

function decimal(value: unknown): bigint | undefined {
	return typeof value === "string" && DECIMAL.test(value) ? BigInt(value) : undefined;
}

/** Canonical base64 of exactly 64 bytes (an Ed25519 signature), else undefined. */
function signature(value: unknown): Buffer | undefined {
	if (typeof value !== "string") return undefined;
	const bytes = Buffer.from(value, "base64");
	return bytes.length === 64 && bytes.toString("base64") === value ? bytes : undefined;
}

function parseEnroll(value: Fields): EnrollAnswer | undefined {
	const result = strict(value, ["epoch", "nonce", "tty", "peer", "sig"]);
	if (!result) return undefined;
	const { epoch, nonce } = result;
	if (typeof epoch !== "string" || !EPOCH.test(epoch) || typeof nonce !== "string" || !NONCE.test(nonce))
		return undefined;
	const tty = strict(result.tty, ["dev", "ino"]);
	const peer = strict(result.peer, ["pid", "pidns"]);
	const dev = decimal(tty?.dev);
	const ino = decimal(tty?.ino);
	const pid = decimal(peer?.pid);
	const pidns = decimal(peer?.pidns);
	const sig = signature(result.sig);
	if (dev === undefined || ino === undefined || pid === undefined || pidns === undefined || !sig) return undefined;
	return { epoch, nonce, tty: { dev, ino }, peer: { pid, pidns }, sig };
}

function parseCut(value: Fields): { answer: CutAnswer; sig: Buffer } | undefined {
	const result = strict(value, ["result", "reason", "principal", "sig"]);
	if (!result) return undefined;
	const { result: kind, reason, principal } = result;
	if (kind !== "client" && kind !== "api" && kind !== "mixed" && kind !== "unknown") return undefined;
	if (reason !== undefined && typeof reason !== "string") return undefined;
	const sig = signature(result.sig);
	if (!sig) return undefined;
	let parsed: CutAnswer["principal"];
	if (principal !== undefined && principal !== null) {
		const fields = strict(principal, ["smarty_id", "display_name"]);
		if (typeof fields?.smarty_id !== "string" || typeof fields.display_name !== "string") return undefined;
		parsed = { smartyId: fields.smarty_id, displayName: fields.display_name };
	}
	return { answer: { result: kind, reason, principal: parsed }, sig };
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

/** This process as Herdr must have pinned it: the tty it reads, its pid and its active pid namespace. */
function ownIdentity(fd: number): { tty: TtyId; peer: PeerId } {
	const stat = fstatSync(fd, { bigint: true });
	const pidns = statSync("/proc/self/ns/pid", { bigint: true }).ino;
	return { tty: { dev: stat.dev, ino: stat.ino }, peer: { pid: BigInt(process.pid), pidns } };
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
		if (error instanceof HerdrRpcProtocolError) return { ok: false, reason: "malformed" };
		return { ok: false, reason: error instanceof Error && error.message === "refused" ? "refused" : "transport" };
	} finally {
		connection.close();
	}
	const answer = parseEnroll(result);
	if (!answer) return { ok: false, reason: "malformed" };
	let own: ReturnType<typeof ownIdentity>;
	try {
		own = ownIdentity(options.ttyFd ?? 0);
	} catch {
		return { ok: false, reason: "server-unauthenticated" };
	}
	if (!verifyEnroll(options.trustRoot, challenge, options.paneId, answer, own)) {
		return { ok: false, reason: "server-unauthenticated" };
	}
	return { ok: true, epoch: openEpoch(options.socketPath, timeoutMs, options.trustRoot, answer) };
}

/** One request on a fresh connection, closed after the answer (pi#160 E2E: Herdr closes it anyway). */
async function oneRequest(
	socketPath: string,
	timeoutMs: number,
	method: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const connection = connectRpc(socketPath, timeoutMs);
	try {
		return await connection.rpc(method, params);
	} finally {
		connection.close();
	}
}

function openEpoch(socketPath: string, timeoutMs: number, trustRoot: KeyObject, enrolled: EnrollAnswer): HerdrEpoch {
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		oneRequest(socketPath, timeoutMs, "pane.input_consumer.release", { epoch: enrolled.epoch }).catch(() => {});
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
				result = await oneRequest(socketPath, timeoutMs, "pane.input_consumer.cut", {
					epoch: request.epoch,
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
			if (!parsed || !verifyCut(trustRoot, request, parsed.answer, parsed.sig)) {
				end();
				return unknown("bad-signature");
			}
			return parsed.answer;
		},
		release: end,
	};
}
