import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

// pi#193 / smarty-code#1681: loaded only via the real CLI's --extension flag.
export default function (pi: ExtensionAPI): void {
	let marked = false;
	pi.on("message_update", (event) => {
		if (marked || event.assistantMessageEvent.type !== "text_delta" || !event.assistantMessageEvent.delta) return;
		marked = true;
		pi.appendEntry("reply-began", { version: 1, turn: 1 });
	});
}
