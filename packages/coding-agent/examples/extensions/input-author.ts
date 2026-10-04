/**
 * Render direct-prompt author data without changing the native user message.
 *
 * An integration returns metadata from input_submission or supplies prompt({ metadata }).
 * Capture the directly accepted sender before input processing, never from the latest
 * input at message_start. Herdr's pane.last_input lookup belongs to its integration:
 * only genuine interactive client input may supply { name, source: "herdr-client", verified: false }.
 * Anonymous, stale or unavailable attribution supplies no author. Queued/staged input
 * deliberately has no submission metadata; do not infer attribution from text or order.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

function readAuthor(data: unknown): { name: string; source: "herdr-client"; verified: false } | undefined {
	if (!data || typeof data !== "object" || !("author" in data)) return;
	const author = data.author;
	if (
		!author ||
		typeof author !== "object" ||
		Array.isArray(author) ||
		!("name" in author) ||
		typeof author.name !== "string" ||
		!("source" in author) ||
		author.source !== "herdr-client" ||
		!("verified" in author) ||
		author.verified !== false
	)
		return;
	// Remove terminal controls, bidi/format controls and line separators before adding theme escapes.
	const name = author.name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();
	if (!name) return;
	return { name, source: "herdr-client", verified: false };
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer("input-author", (entry, _options, theme) => {
		const author = readAuthor(entry.data);
		if (author) return new Text(theme.fg("muted", `${author.name}:`), 0, 0);
	});
	pi.on("message_start", (event) => {
		if (event.message.role !== "user" || !event.input) return;
		const author = readAuthor(event.input.metadata);
		if (author) pi.appendEntry("input-author", { author });
	});
}
