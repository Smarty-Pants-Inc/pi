/**
 * Render submission-bound author metadata without changing the native user message.
 *
 * An integration supplies metadata from input_submission or passes a previously
 * captured submission to session.prompt(). This example never infers an author
 * from the latest input, message text, or queue order.
 *
 * Herdr's agent-state extension should read pane.last_input in input_submission,
 * only for genuine interactive client input, and return author metadata with
 * source: "herdr-client", verified: false. RPC, anonymous, stale, or unavailable
 * attribution must return no author. The pane lookup belongs to that extension,
 * not Pi core; never postpone it until input processing or message_start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface AuthorData {
	author: {
		name: string;
		source: "herdr-client";
		verified: false;
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<AuthorData>("input-author", (entry, _options, theme) => {
		if (!entry.data) return;
		const name = entry.data.author.name.replace(/\p{Cc}/gu, " ").trim();
		if (!name) return;
		return new Text(theme.fg("muted", `${name}:`), 0, 0);
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "user" || event.input?.source !== "interactive") return;
		const author = event.input.metadata?.author;
		if (
			!author ||
			typeof author !== "object" ||
			!("name" in author) ||
			typeof author.name !== "string" ||
			!author.name.trim() ||
			!("source" in author) ||
			author.source !== "herdr-client" ||
			!("verified" in author) ||
			author.verified !== false
		) {
			return;
		}
		pi.appendEntry<AuthorData>("input-author", {
			author: { name: author.name, source: author.source, verified: author.verified },
		});
	});
}
