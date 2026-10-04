import { randomUUID } from "node:crypto";
import type { TurnProvenance } from "./turn-provenance.ts";

declare const receiptBrand: unique symbol;
/** Package-private handle; a structural lookalike is not an issued receipt. */
export interface TurnReceipt {
	readonly [receiptBrand]: true;
}

type TerminalRecord = Readonly<Extract<TurnProvenance, { channel: "terminal" }>>;
const records = new WeakMap<TurnReceipt, TerminalRecord>();

export function captureTerminalTurnReceipt(): TurnReceipt {
	const receipt = Object.freeze({}) as TurnReceipt;
	records.set(
		receipt,
		Object.freeze({ v: 1, turnId: randomUUID(), receivedAt: new Date().toISOString(), channel: "terminal" }),
	);
	return receipt;
}

export function receiptRecord(receipt?: TurnReceipt): TerminalRecord {
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
