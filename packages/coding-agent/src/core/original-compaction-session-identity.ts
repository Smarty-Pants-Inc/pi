import type { SessionManager } from "./session-manager.ts";

const ACCOUNTING_ENTRY_TYPES = new Set([
	"smarty-sense:count-reservation-v1",
	"smarty-sense:count-qualification-v1",
	"smarty-sense:provider-reservation-v1",
	"smarty-sense:provider-usage-v1",
]);

type BranchIdentity = ReturnType<SessionManager["getBranchIdentity"]>;

/**
 * Fence an original compaction to one active branch without cloning or serializing message bodies.
 * Only the four known accounting-only custom-entry appends may extend the captured branch.
 */
export function createOriginalCompactionSessionIdentity(manager: SessionManager): {
	check(): void;
	afterAppend(): void;
} {
	let baseline = manager.getBranchIdentity();

	return {
		check() {
			const current = manager.getBranchIdentity();
			if (sameBranchIdentity(current, baseline) || hasOnlyAccountingAppend(current, baseline)) return;
			throw new Error("OPS_COMPACTION_SESSION_CHANGED");
		},
		afterAppend() {
			baseline = manager.getBranchIdentity();
		},
	};
}

function sameBranchIdentity(current: BranchIdentity, baseline: BranchIdentity): boolean {
	return (
		current.sessionEpoch === baseline.sessionEpoch &&
		current.revision === baseline.revision &&
		current.leafId === baseline.leafId &&
		current.entries.length === baseline.entries.length &&
		current.entries.every((entry, index) => {
			const previous = baseline.entries[index];
			return (
				previous !== undefined &&
				entry.id === previous.id &&
				entry.type === previous.type &&
				entry.customType === previous.customType
			);
		})
	);
}

function hasOnlyAccountingAppend(current: BranchIdentity, baseline: BranchIdentity): boolean {
	if (
		current.sessionEpoch !== baseline.sessionEpoch ||
		current.revision === baseline.revision ||
		current.entries.length <= baseline.entries.length ||
		current.leafId !== current.entries[current.entries.length - 1]?.id
	)
		return false;

	for (let index = 0; index < baseline.entries.length; index++) {
		const currentEntry = current.entries[index];
		const previous = baseline.entries[index];
		if (
			!currentEntry ||
			!previous ||
			currentEntry.id !== previous.id ||
			currentEntry.type !== previous.type ||
			currentEntry.customType !== previous.customType
		)
			return false;
	}

	for (let index = baseline.entries.length; index < current.entries.length; index++) {
		const entry = current.entries[index];
		if (entry?.type !== "custom" || !entry.customType || !ACCOUNTING_ENTRY_TYPES.has(entry.customType)) return false;
	}
	return true;
}
