import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/**
 * OSC 8 file URL for a path. Herdr runs its link handlers on the Herdr server host, which may not be the
 * client's host, so for Herdr the URL names this host (as the OSC 8 spec suggests) and puts the line in the
 * fragment (`#42`, as kitty's hyperlinked grep does). Other terminals and Pi's own click-to-open get a plain
 * `file:///path`, which every opener accepts; on Windows a host would turn the URL into a UNC path.
 */
export function fileLinkUrl(
	absolutePath: string,
	line?: number,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	const url = pathToFileURL(absolutePath);
	const herdr = env.TERM_PROGRAM === "herdr" || env.HERDR_ENV === "1";
	if (!herdr || platform === "win32") return url.href;
	const fragment = line !== undefined && Number.isInteger(line) && line > 0 ? `#${line}` : "";
	return `file://${os.hostname()}${url.pathname}${fragment}`;
}

export function linkPath(styledText: string, rawPath: string, cwd: string, line?: number): string {
	if (!getCapabilities().hyperlinks) return styledText;
	return hyperlink(styledText, fileLinkUrl(resolvePath(rawPath, cwd), line));
}

/** Link the path in each `path:line: text` or `path-line- text` row of grep output. Paths resolve against `baseDir`. */
export function linkGrepOutputLine(line: string, baseDir: string): string {
	const match = /^(.+?)(?::(\d+): |-(\d+)- )/.exec(line);
	if (!match) return line;
	const [, path, matchLine, contextLine] = match;
	return linkPath(path, path, baseDir, Number(matchLine ?? contextLine)) + line.slice(path.length);
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string; line?: number },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd, options?.line);
}
