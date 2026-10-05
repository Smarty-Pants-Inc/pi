import type { UserMessage } from "@earendil-works/pi-ai";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { UserMessageRenderer } from "../src/index.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

function createMode(renderer?: UserMessageRenderer) {
	return {
		chatContainer: new Container(),
		editor: { addToHistory: vi.fn() },
		outputPad: 1,
		toolOutputExpanded: false,
		session: { extensionRunner: { getUserMessageRenderer: () => renderer } },
		getUserMessageText: Reflect.get(InteractiveMode.prototype, "getUserMessageText"),
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
	};
}
const addMessage = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
	this: ReturnType<typeof createMode>,
	message: UserMessage,
	options?: { populateHistory?: boolean },
) => void;

describe("interactive user-message renderer dispatch", () => {
	// Refs smarty-dev#5049: display projection must preserve history and complete message bytes.
	test.each([false, true])(
		"routes live/replayed text (populateHistory=%s) without exposing or modifying image content",
		(populateHistory) => {
			initTheme("dark");
			const renderer = vi.fn<UserMessageRenderer>((text) => new Text(`YOU ${text}`, 0, 0));
			const mode = createMode(renderer);
			const message: UserMessage = {
				role: "user",
				timestamp: 1234,
				content: [
					{ type: "text", text: "**plain**" },
					{ type: "image", data: "image-bytes", mimeType: "image/png" },
					{ type: "text", text: " more" },
				],
			};
			const original = JSON.stringify(message);
			addMessage.call(mode, message, { populateHistory });
			expect(renderer.mock.calls[0].slice(0, 2)).toEqual(["**plain** more", { timestamp: 1234, outputPad: 1 }]);
			expect(JSON.stringify(message)).toBe(original);
			expect(mode.editor.addToHistory.mock.calls).toEqual(populateHistory ? [["**plain** more"]] : []);
			expect(mode.chatContainer.children).toHaveLength(1);
			expect(mode.chatContainer.children[0]).toBeInstanceOf(UserMessageComponent);
		},
	);

	test("leaves skill controls native and routes only trailing user text with its original timestamp", () => {
		initTheme("dark");
		const renderer = vi.fn<UserMessageRenderer>((text) => new Text(text, 0, 0));
		const mode = createMode(renderer);
		const message: UserMessage = {
			role: "user",
			timestamp: 5678,
			content: '<skill name="demo" location="/skills/demo/SKILL.md">\nInstructions\n</skill>\n\nPrincipal text',
		};
		const original = JSON.stringify(message);
		addMessage.call(mode, message, { populateHistory: true });
		expect(mode.chatContainer.children[0]).toBeInstanceOf(SkillInvocationMessageComponent);
		expect(mode.chatContainer.children[1]).toBeInstanceOf(UserMessageComponent);
		expect(renderer.mock.calls[0].slice(0, 2)).toEqual(["Principal text", { timestamp: 5678, outputPad: 1 }]);
		expect(mode.editor.addToHistory).toHaveBeenCalledWith(message.content);
		expect(JSON.stringify(message)).toBe(original);
	});

	test("native transcript separation and OSC placement remain byte-identical with or without a fallback renderer", () => {
		initTheme("dark");
		for (const renderer of [undefined, () => undefined]) {
			const mode = createMode(renderer);
			mode.chatContainer.addChild(new Text("previous", 0, 0));
			addMessage.call(mode, { role: "user", timestamp: 1234, content: "hello" });
			const native = new Container();
			native.addChild(new Text("previous", 0, 0));
			native.addChild(new Spacer(1));
			native.addChild(new UserMessageComponent("hello"));
			expect(mode.chatContainer.render(40)).toEqual(native.render(40));
		}
	});
});
