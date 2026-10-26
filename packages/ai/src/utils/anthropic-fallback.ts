import { redactValues } from "../auth/oauth/credential-response.ts";
import type { AssistantMessageFallback } from "../types.ts";

const MAX_FALLBACK_BLOCK_BYTES = 4096;

/** Mask before measuring; discard raw fields when injected or SDK-managed credentials are unknown. */
export async function recordAnthropicFallback(
	block: unknown,
	blockIndex: number,
	position: AssistantMessageFallback["position"],
	secrets: readonly string[],
	unknownCredentials: boolean,
): Promise<AssistantMessageFallback> {
	const record: AssistantMessageFallback = { position, blockIndex, blockState: "discarded" };
	try {
		// Strip content recursively, including content nested in future/compatible-provider block fields.
		const serialized = JSON.stringify(block, (key, value: unknown) => (key === "content" ? undefined : value));
		if (serialized === undefined) return record;
		const redacted = redactValues(serialized, secrets);
		const bytes = new TextEncoder().encode(redacted);
		if (unknownCredentials || bytes.length > MAX_FALLBACK_BLOCK_BYTES) {
			const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
			record.blockBytes = bytes.length;
			record.blockSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
		} else {
			record.rawBlock = redacted;
			record.blockState = "retained";
		}
	} catch {
		// Recording must not change the response outcome or expose an exception/partial serialization.
	}
	return record;
}
