import { copyJson } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** Opaque JSON-serializable data. Pi snapshots it before dispatch and never sends it to the model. */
export type UserMessageMetadata = Readonly<Record<string, unknown>>;

export interface SendUserMessageOptions {
	deliverAs?: "steer" | "followUp";
	expandPromptTemplates?: boolean;
	/** Providing metadata opts into an admission receipt instead of waiting for the run to finish. */
	metadata?: UserMessageMetadata;
}

/** One receipt per input, including inputs consumed without starting a turn. */
export type SendUserMessageResult =
	| { readonly status: "handled"; readonly entryId: null; readonly metadata: UserMessageMetadata }
	| { readonly status: "turnStarted"; readonly entryId: string; readonly metadata: UserMessageMetadata };

/** Internal runtime signature; legacy extension hosts may still return void. */
export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: SendUserMessageOptions,
	// biome-ignore lint/suspicious/noConfusingVoidType: legacy extension actions return void
) => void | Promise<SendUserMessageResult>;

/** Capture JSON wire semantics now, not after an asynchronous handler or queued turn. */
export function snapshotUserMessageMetadata(metadata: UserMessageMetadata): UserMessageMetadata {
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
		throw new TypeError("User message metadata must be a JSON-serializable object");
	}
	const snapshot = copyJson(metadata) as UserMessageMetadata;
	const pending: object[] = [snapshot];
	while (pending.length > 0) {
		const value = pending.pop()!;
		Object.freeze(value);
		for (const child of Object.values(value)) {
			if (child !== null && typeof child === "object") pending.push(child);
		}
	}
	return snapshot as UserMessageMetadata;
}
