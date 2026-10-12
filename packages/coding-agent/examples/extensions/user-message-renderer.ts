/**
 * Display user text as a plain feed block without changing session or model content.
 * Load with: pi --extension examples/extensions/user-message-renderer.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.registerUserMessageRenderer((text, { timestamp, outputPad }) => {
		const time = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		const label = `\x1b[1m\x1b[33mYOU · ${time}\x1b[39m\x1b[22m`;
		const block = new Container();
		block.addChild(new Spacer(1));
		block.addChild(new Text(`${label}\n${text}`, outputPad, 0, (line) => `\x1b[48;5;237m${line}\x1b[49m`));
		// Native assistant blocks supply the following unshaded separator.
		return block;
	});
}
