import { redactValues } from "../auth/oauth/credential-response.ts";
import type { AssistantMessage } from "../types.ts";

const MAX_STOP_DETAILS_BYTES = 4096;

/**
 * Record opaque Anthropic refusal data only. The adapter calls this after the terminal refusal reason is known;
 * mask before measuring. Never retain raw data from injected clients: their complete credentials are unknown.
 * Default-client records are byte-bounded and never become an outbound or recovery input.
 */
export async function recordAssistantMessageStopDetails(
	message: AssistantMessage,
	details: unknown,
	secrets: readonly string[] = [],
	injectedClient: boolean,
): Promise<void> {
	if (details == null) {
		message.stopDetailsState ??= "absent";
		return;
	}
	try {
		const serialized = JSON.stringify(details);
		if (serialized === undefined) return;
		// Size and fingerprint only the masked serialization, using all known request credentials.
		const redacted = redactValues(serialized, secrets);
		const bytes = new TextEncoder().encode(redacted);
		if (injectedClient || bytes.length > MAX_STOP_DETAILS_BYTES) {
			const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
			message.stopDetailsSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
			message.stopDetailsBytes = bytes.length;
			delete message.rawStopDetails;
			message.stopDetailsState = "discarded";
		} else {
			message.rawStopDetails = redacted;
			delete message.stopDetailsBytes;
			delete message.stopDetailsSha256;
			message.stopDetailsState = "retained";
		}
	} catch {
		// Diagnostic failure must never change the response outcome. No exception text or partial record is retained.
	}
}
