import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnProvenance } from "./turn-provenance.ts";
import type { TurnReceipt } from "./turn-receipts.ts";
import type { UserMessageMetadata, UserMessageMetadataSource } from "./user-message-metadata.ts";

/** State-only session entry; never included in model context until delivery. */
export const UNSENT_INPUT_TYPE = "pi.unsent-input";

export interface UnsentInput {
	message: AgentMessage;
	mode: "steer" | "followUp" | "nextTurn" | "context";
	provenance?: TurnProvenance;
	metadata?: UserMessageMetadata;
	metadataSource?: UserMessageMetadataSource;
}

// Link consumption to the actual message append, not queue reconstruction or message_start.
const transfers = new WeakMap<TurnReceipt, string>();

export function linkUnsentInputTransfer(receipt: TurnReceipt, entryId: string): void {
	transfers.set(receipt, entryId);
}

export function getUnsentInputTransfer(receipt?: TurnReceipt): string | undefined {
	return receipt ? transfers.get(receipt) : undefined;
}
