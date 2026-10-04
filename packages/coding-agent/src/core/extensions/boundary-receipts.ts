import { captureTerminalTurnReceipt, type TurnReceipt } from "../turn-receipts.ts";
import type { SessionBoundaryDraft } from "./types.ts";

/** Snapshot references before dispatch; each repeated reference owns a FIFO slot. */
export function boundaryReceiptSlots(entries: SessionBoundaryDraft[], receipts: (TurnReceipt | undefined)[]) {
	const slots = new Map<SessionBoundaryDraft, (TurnReceipt | undefined)[]>();
	for (let index = 0; index < entries.length; index++) {
		const draft = entries[index];
		const queue = slots.get(draft);
		if (queue) queue.push(receipts[index]);
		else slots.set(draft, [receipts[index]]);
	}
	return slots;
}

/** Clone once, keeping receipt slots separate from extension-visible drafts. */
export function receiveBoundaryEntries(
	selected: SessionBoundaryDraft[],
	slots: ReturnType<typeof boundaryReceiptSlots>,
	observed: TurnReceipt,
): { entries: SessionBoundaryDraft[]; receipts: (TurnReceipt | undefined)[] } {
	if (!Array.isArray(selected)) return { entries: structuredClone(selected), receipts: [] };
	let firstNew = true;
	const consumed = new Map<SessionBoundaryDraft, number>();
	// Capture every possible fresh slot before indexed selectors or draft accessors run.
	const candidates = new Array<TurnReceipt>(selected.length);
	for (let index = 0, length = candidates.length; index < length; index++) {
		candidates[index] = captureTerminalTurnReceipt();
	}
	// Materialize indexed selection once; receipt slots and cloning must share these references.
	const materialized = new Array<SessionBoundaryDraft>(candidates.length);
	for (let index = 0, length = selected.length; index < length; index++) {
		if (index in selected) materialized[index] = selected[index];
	}
	for (let index = 0, length = materialized.length; index < length; index++) {
		if (!(index in materialized)) continue;
		const draft = materialized[index];
		const occurrence = consumed.get(draft) ?? 0;
		consumed.set(draft, occurrence + 1);
		const prior = slots.get(draft)?.[occurrence];
		candidates[index] = prior ?? (firstNew ? observed : candidates[index]);
		if (!prior) firstNew = false;
	}
	const entries = structuredClone(materialized);
	// Classify the snapshot, not a retained accessor that can change on later reads.
	const receipts = new Array<TurnReceipt | undefined>(entries.length);
	for (let index = 0, length = entries.length; index < length; index++) {
		if (index in entries) receipts[index] = entries[index]?.type === "custom_message" ? candidates[index] : undefined;
	}
	return { entries, receipts };
}
