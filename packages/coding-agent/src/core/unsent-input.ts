import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type { CustomMessage } from "./messages.ts";
import type { TurnProvenance } from "./turn-provenance.ts";
import type { TurnReceipt } from "./turn-receipts.ts";
import type { UserMessageMetadata, UserMessageMetadataSource } from "./user-message-metadata.ts";

/** State-only session entry; never included in model context until delivery. */
export const UNSENT_INPUT_TYPE = "pi.unsent-input";

/** Local resume authority, not authentication against a writer with the same UID. */
export interface UnsentInputOrigin {
	sessionId: string;
	host: string;
	uid: number;
}

export interface UnsentInput {
	origin?: UnsentInputOrigin;
	message: AgentMessage;
	mode: "steer" | "followUp" | "nextTurn" | "context";
	provenance?: TurnProvenance;
	metadata?: UserMessageMetadata;
	metadataSource?: UserMessageMetadataSource;
}

/** Accept only displayable input, never assistant/tool messages or executable content blocks. */
export function readUnsentInput(value: unknown): UnsentInput | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	if (!["steer", "followUp", "nextTurn", "context"].includes(String(input.mode))) return undefined;
	if (!input.message || typeof input.message !== "object") return undefined;
	const raw = input.message as Record<string, unknown>;
	if (raw.role !== "user" && raw.role !== "custom") return undefined;
	if (typeof raw.timestamp !== "number" || !Number.isFinite(raw.timestamp)) return undefined;
	let content: string | (TextContent | ImageContent)[];
	if (typeof raw.content === "string") content = raw.content;
	else if (Array.isArray(raw.content)) {
		content = [];
		for (const part of raw.content) {
			if (!part || typeof part !== "object") return undefined;
			if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
			else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string")
				content.push({ type: "image", data: part.data, mimeType: part.mimeType });
			else return undefined;
		}
	} else return undefined;
	let message: AgentMessage;
	if (raw.role === "user") {
		if (input.mode !== "steer" && input.mode !== "followUp") return undefined;
		message = { role: "user", content, timestamp: raw.timestamp };
	} else {
		if (typeof raw.customType !== "string" || typeof raw.display !== "boolean") return undefined;
		message = {
			role: "custom",
			customType: raw.customType,
			content,
			display: raw.display,
			details: raw.details,
			timestamp: raw.timestamp,
		} satisfies CustomMessage;
	}
	return { ...(input as unknown as UnsentInput), message };
}

// Link consumption to the actual message append, not queue reconstruction or message_start.
const transfers = new WeakMap<TurnReceipt, string>();

export function linkUnsentInputTransfer(receipt: TurnReceipt, entryId: string): void {
	transfers.set(receipt, entryId);
}

export function getUnsentInputTransfer(receipt?: TurnReceipt): string | undefined {
	return receipt ? transfers.get(receipt) : undefined;
}
