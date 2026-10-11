import { randomUUID } from "node:crypto";
import type { TurnProvenance } from "./turn-provenance.ts";

declare const receiptBrand: unique symbol;
/** Package-private handle; a structural lookalike is not an issued receipt. */
export interface TurnReceipt {
	readonly [receiptBrand]: true;
}

type ReceiptRecord = Readonly<Extract<TurnProvenance, { channel: "terminal" | "keyboard" }>>;
const records = new WeakMap<TurnReceipt, ReceiptRecord>();

function issue(record: ReceiptRecord): TurnReceipt {
	const receipt = Object.freeze({}) as TurnReceipt;
	records.set(receipt, Object.freeze(record));
	return receipt;
}

export function captureTerminalTurnReceipt(): TurnReceipt {
	return issue({ v: 1, turnId: randomUUID(), receivedAt: new Date().toISOString(), channel: "terminal" });
}

/** A Pi-minted 128-bit submission token (lowercase hex); never caller text. */
const SUBMISSION_TOKEN = /^[0-9a-f]{32}$/;

function submissionToken(token: unknown): string {
	if (typeof token !== "string" || !SUBMISSION_TOKEN.test(token)) throw new Error("Invalid submission token");
	return token;
}

/** An editor submit that Herdr did not attest: still correlated by its token, never attributed. */
export function captureTerminalSubmitReceipt(token: string): TurnReceipt {
	return issue({
		v: 1,
		turnId: randomUUID(),
		receivedAt: new Date().toISOString(),
		channel: "terminal",
		submissionToken: submissionToken(token),
	});
}

/**
 * Herdr attested this submit's byte interval to `principalId` (smarty-dev#2636). Only the editor-submit
 * path calls this, after the cut answer verified and the draft stayed untainted; callers never choose it.
 */
export function captureKeyboardTurnReceipt(principalId: string, token: string, receivedAt: string): TurnReceipt {
	if (typeof principalId !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(principalId))
		throw new Error("Invalid principal");
	if (typeof receivedAt !== "string" || new Date(receivedAt).toISOString() !== receivedAt)
		throw new Error("Invalid receipt time");
	return issue({
		v: 1,
		turnId: randomUUID(),
		receivedAt,
		channel: "keyboard",
		principal: Object.freeze({ id: principalId, binding: "herdr-client" as const }),
		submissionToken: submissionToken(token),
	});
}

/** Issue another occurrence at an already trusted observation, never a caller-provided time. */
export function captureSiblingTerminalTurnReceipt(observed: TurnReceipt): TurnReceipt {
	const record = records.get(observed);
	if (!record) throw new Error("Turn receipt was not issued by the harness");
	// A sibling is a turn the hook created, not the attested keystrokes: never keyboard.
	return issue({ v: 1, turnId: randomUUID(), receivedAt: record.receivedAt, channel: "terminal" });
}
/** The same submission without its attribution (hook transform, template expansion). */
export function withoutAttribution(receipt: TurnReceipt): TurnReceipt {
	const record = records.get(receipt);
	if (!record || record.channel !== "keyboard") return receipt;
	return issue({
		v: 1,
		turnId: record.turnId,
		receivedAt: record.receivedAt,
		channel: "terminal",
		...(record.submissionToken ? { submissionToken: record.submissionToken } : {}),
	});
}
export function receiptRecord(receipt?: TurnReceipt): ReceiptRecord {
	return (receipt && records.get(receipt)) ?? records.get(captureTerminalTurnReceipt())!;
}

const sealedEntries = new WeakSet<object>();
/** Protect only the reserved provenance JSON graph, including missing historical records. */
export function sealEntryProvenance(entry: object, reserveSerializer: boolean): void {
	if (!sealedEntries.has(entry)) {
		const raw: unknown = Reflect.get(entry, "provenance");
		const value: unknown = raw === undefined ? undefined : JSON.parse(JSON.stringify(raw));
		const pending: unknown[] = [value];
		while (pending.length) {
			const node = pending.pop();
			if (node !== null && typeof node === "object") {
				for (const child of Object.values(node)) pending.push(child);
				Object.freeze(node);
			}
		}
		// copyEntry may carry an already locked descriptor from a sealed source.
		const slot = Object.getOwnPropertyDescriptor(entry, "provenance");
		if (slot?.configurable === false && "value" in slot) {
			// Such copies already own the detached frozen record (or undefined).
			sealedEntries.add(entry);
		} else {
			Object.defineProperty(entry, "provenance", { value, enumerable: true, writable: false, configurable: false });
			sealedEntries.add(entry);
		}
	}
	if (reserveSerializer && Object.getOwnPropertyDescriptor(entry, "toJSON")?.configurable !== false) {
		// Entry-local serializers can erase a locked receipt; nested data/details keep normal JSON behavior.
		const slot = Object.getOwnPropertyDescriptor(entry, "toJSON");
		Object.defineProperty(entry, "toJSON", {
			value: slot && "value" in slot ? slot.value : undefined,
			enumerable: slot?.enumerable ?? false,
			writable: false,
			configurable: false,
		});
	}
}
