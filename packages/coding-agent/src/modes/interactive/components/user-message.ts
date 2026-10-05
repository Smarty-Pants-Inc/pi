import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { MarkdownTransformer, UserMessageRenderer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

interface UserMessageComponentOptions {
	renderer?: UserMessageRenderer;
	timestamp?: number;
	/** Native transcript separation; custom renderers own their spacing. */
	leadingSpacer?: boolean;
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private options: UserMessageComponentOptions;
	private timestamp: number;
	private customRendered = false;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		options: UserMessageComponentOptions = {},
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.options = options;
		this.timestamp = options.timestamp ?? Date.now();
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(useRenderer = true): void {
		this.clear();
		this.customRendered = false;
		if (useRenderer && this.options.renderer) {
			try {
				const component = this.options.renderer(
					this.text,
					{ outputPad: this.outputPad, timestamp: this.timestamp },
					theme,
				);
				if (component) {
					this.customRendered = true;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to native rendering, as with custom-message renderers.
			}
		}
		const contentBox = new Box(this.outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
		contentBox.addChild(
			new Markdown(
				this.text,
				0,
				0,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
				},
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform("user", false, this.markdownTransformers),
				},
			),
		);
		this.addChild(contentBox);
	}

	override render(width: number): string[] {
		let lines = super.render(width);
		if (this.customRendered && lines.length === 0) {
			// Empty custom output must not hide the user message or leave an orphan prompt zone.
			this.rebuild(false);
			lines = super.render(width);
		}
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		const last = lines.length - 1;
		if (this.customRendered) {
			// Close after all custom content, including when start and end share one row.
			lines[last] += OSC133_ZONE_END + OSC133_ZONE_FINAL;
		} else {
			// Keep native closing markers before its bottom-padding row, byte for byte.
			lines[last] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[last];
		}
		if (!this.customRendered && this.options.leadingSpacer) {
			lines.unshift("");
		}
		return lines;
	}
}
