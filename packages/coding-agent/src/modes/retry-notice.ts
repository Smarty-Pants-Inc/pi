import type { AgentSessionEvent } from "../core/agent-session.ts";

/** Headless diagnostics stay on stderr; stdout remains text or strict JSONL. */
export function writeRetryNotice(event: AgentSessionEvent): void {
	if (event.type === "auto_retry_start") {
		console.error(
			event.retryReason === "quota"
				? `quota refusal; retrying once in ${Math.ceil(event.delayMs / 1000)}s`
				: event.waitMessage !== undefined
					? `Waiting ${Math.ceil(event.delayMs / 1000)}s: ${event.waitMessage}`
					: `Retrying (${event.attempt}/${event.maxAttempts}) in ${event.delayMs}ms: ${event.errorMessage}`,
		);
	} else if (event.type === "auto_retry_fallback") {
		console.error(
			`Failed over from ${event.fromModel} to ${event.toModel} after ${event.attempt} retries: ${event.errorMessage}`,
		);
	} else if (event.type === "auto_retry_end" && !event.success) {
		console.error(`Retry failed after ${event.attempt} retries: ${event.finalError ?? "Unknown error"}`);
	}
}
