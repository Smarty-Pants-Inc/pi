import { Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import userMessageRendererExample from "../examples/extensions/user-message-renderer.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { UserMessageRenderer } from "../src/index.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

// Refs smarty-dev#5049: native user-message display must be extension-customizable without changing prompts.
const feedRenderer: UserMessageRenderer = (text, { timestamp, outputPad }) => {
	const block = new Container();
	block.addChild(new Spacer(1));
	block.addChild(
		new Text(
			`\x1b[1m\x1b[33mYOU · ${timestamp}\x1b[39m\x1b[22m\n${text}`,
			outputPad,
			0,
			(line) => `\x1b[48;5;237m${line}\x1b[49m`,
		),
	);
	block.addChild(new Spacer(1));
	return block;
};

describe("UserMessageComponent custom rendering", () => {
	test("checked feed example shares one separator with the following native assistant block", async () => {
		initTheme("dark");
		const extension = await loadExtensionFromFactory(
			userMessageRendererExample,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
		);
		const transcript = new Container();
		transcript.addChild(
			new UserMessageComponent("**plain**", undefined, 1, [], {
				renderer: extension.userMessageRenderer,
				timestamp: 1234,
			}),
		);
		// Native assistant blocks start with Spacer(1), so the feed must not add a second separator.
		transcript.addChild(new Spacer(1));
		transcript.addChild(new Text("assistant", 1, 0));
		const lines = transcript.render(40);
		expect(lines).toHaveLength(5);
		expect(lines[0]).toBe(OSC133_ZONE_START);
		expect(stripAnsi(lines[1])).toContain(" YOU · ");
		expect(stripAnsi(lines[2])).toContain(" **plain**");
		expect(lines[3]).toBe("");
		expect(stripAnsi(lines[4]).trim()).toBe("assistant");
	});

	test.each(["dark", "light"])(
		"undefined and throwing renderers preserve native %s output including transformers and zones",
		(name) => {
			initTheme(name);
			const transformers = [(text: string) => `${text} transformed`];
			const native = new UserMessageComponent("**hello**", undefined, 1, transformers).render(20);
			for (const renderer of [
				() => undefined,
				() => {
					throw new Error("renderer failed");
				},
			]) {
				const component = new UserMessageComponent("**hello**", undefined, 1, transformers, {
					renderer,
					leadingSpacer: true,
				});
				expect(component.render(20)).toEqual(["", ...native]);
			}
		},
	);

	test("custom renderer owns plain text, label, background and exactly one outer blank line", () => {
		initTheme("dark");
		const transform = vi.fn((text: string) => text.toUpperCase());
		const component = new UserMessageComponent("**literal**\nsecond line", undefined, 1, [transform], {
			renderer: feedRenderer,
			timestamp: 1234,
			leadingSpacer: true,
		});
		const lines = component.render(40);
		expect(lines).toHaveLength(5);
		expect(lines[0]).toBe(OSC133_ZONE_START);
		expect(lines[4]).toBe(OSC133_ZONE_END + OSC133_ZONE_FINAL);
		expect(lines[1]).toContain("\x1b[1m\x1b[33mYOU · 1234");
		for (const line of lines.slice(1, 4)) {
			expect(line).toContain("\x1b[48;5;237m");
			expect(line).toContain(BG_RESET);
		}
		expect(stripAnsi(lines[2])).toContain(" **literal**");
		expect(transform).not.toHaveBeenCalled();
	});

	test("reinvokes the renderer on invalidation and padding changes with original timestamp and current theme", () => {
		initTheme("dark");
		let enabled = true;
		const renderer = vi.fn<UserMessageRenderer>((text) => (enabled ? new Text(`custom ${text}`, 0, 0) : undefined));
		const component = new UserMessageComponent("hello", undefined, 1, [], { renderer, timestamp: 1234 });
		expect(renderer).toHaveBeenLastCalledWith("hello", { timestamp: 1234, outputPad: 1 }, theme);
		component.setOutputPad(0);
		expect(renderer).toHaveBeenLastCalledWith("hello", { timestamp: 1234, outputPad: 0 }, theme);
		initTheme("light");
		enabled = false;
		component.invalidate();
		expect(renderer).toHaveBeenLastCalledWith("hello", { timestamp: 1234, outputPad: 0 }, theme);
		expect(component.render(20)).toEqual(new UserMessageComponent("hello", undefined, 0).render(20));
		enabled = true;
		component.invalidate();
		expect(stripAnsi(component.render(20).join("\n"))).toContain("custom hello");
	});

	test("empty custom output has no orphan OSC zones", () => {
		initTheme("dark");
		const component = new UserMessageComponent("hidden", undefined, 1, [], { renderer: () => new Container() });
		expect(component.render(20)).toEqual([]);
	});

	test.each([4, 10, 40])("feed component fits width %i with wide and combining characters", (width) => {
		initTheme("dark");
		const component = new UserMessageComponent("界界 café é **plain**", undefined, 1, [], {
			renderer: feedRenderer,
			timestamp: 1234,
		});
		const lines = component.render(width);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(lines[0]).toBe(OSC133_ZONE_START);
		expect(lines.at(-1)).toBe(OSC133_ZONE_END + OSC133_ZONE_FINAL);
	});
});

describe("UserMessageComponent", () => {
	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});
});
