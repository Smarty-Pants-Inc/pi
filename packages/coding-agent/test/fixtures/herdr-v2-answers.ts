/**
 * Herdr's side of protocol E' v2 for fake servers in tests (smarty-dev#2636): signs enroll and cut
 * answers with a test key exactly as Herdr does, and shapes them as Herdr sends them.
 */
import { type KeyObject, sign } from "node:crypto";
import {
	type CutAnswer,
	type CutRequest,
	cutMessage,
	type EnrollAnswer,
	enrollMessage,
} from "../../src/core/herdr/server-auth.ts";

export interface WirePrincipal {
	readonly smarty_id: string;
	readonly display_name: string;
}

/** A cut answer as Herdr's ledger produces it, before signing. */
export interface WireCut {
	readonly result: CutAnswer["result"];
	readonly reason?: string;
	readonly principal?: WirePrincipal | null;
}

export function enrollResult(
	key: KeyObject,
	challengeHex: string,
	paneId: string,
	answer: Omit<EnrollAnswer, "sig">,
): Record<string, unknown> {
	const sig = sign(null, enrollMessage(Buffer.from(challengeHex, "hex"), paneId, answer), key);
	return {
		epoch: answer.epoch,
		nonce: answer.nonce,
		tty: { dev: answer.tty.dev.toString(), ino: answer.tty.ino.toString() },
		peer: { pid: answer.peer.pid.toString(), pidns: answer.peer.pidns.toString() },
		sig: sig.toString("base64"),
	};
}

export function cutSignature(key: KeyObject, request: CutRequest, cut: WireCut): Buffer {
	const answer: CutAnswer = {
		result: cut.result,
		reason: cut.reason,
		principal: cut.principal
			? { smartyId: cut.principal.smarty_id, displayName: cut.principal.display_name }
			: undefined,
	};
	return sign(null, cutMessage(request, answer), key);
}

export function cutResult(key: KeyObject, request: CutRequest, cut: WireCut): Record<string, unknown> {
	return { ...cut, sig: cutSignature(key, request, cut).toString("base64") };
}

/** The cut request fields Herdr signs, from the params Pi sent. */
export function cutRequestOf(params: Record<string, unknown>): CutRequest {
	return {
		epoch: String(params.epoch),
		seq: Number(params.seq),
		token: String(params.token),
		cut: Number(params.cut),
		digest: String(params.digest),
		kind: params.kind === "discard" ? "discard" : "submit",
	};
}
