/**
 * Presentation for the grep tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `grep.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { dirname } from "node:path";
import { getCapabilities, Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { GrepToolDetails } from "../grep.ts";
import { resolveToCwd } from "../path-utils.ts";
import { getTextOutput, invalidArgText, linkGrepOutputLine, shortenPath, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: Theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}
/** Grep prints paths relative to a searched directory, or the bare file name when the search path is a file. */
function grepLinkBase(rawPath: string, cwd: string, searchIsFile: boolean | undefined): string {
	const searchPath = resolveToCwd(rawPath || ".", cwd);
	return searchIsFile ? dirname(searchPath) : searchPath;
}
function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	rawPath: string | null,
	cwd: string,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		const linkBase =
			getCapabilities().hyperlinks && rawPath !== null
				? grepLinkBase(rawPath, cwd, result.details?.searchIsFile)
				: undefined;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", linkBase ? linkGrepOutputLine(line, linkBase) : line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export const grepRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatGrepCall(args as any, theme));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatGrepResult(
				result as any,
				options,
				theme,
				context.showImages,
				context.isError ? null : str((context.args as { path?: unknown } | undefined)?.path),
				context.cwd,
			),
		);
		return text;
	},
};
