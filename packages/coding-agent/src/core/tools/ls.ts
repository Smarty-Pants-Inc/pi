import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import nodePath from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { lsRenderers } from "./renderers/ls.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

export const lsToolSystemPromptContribution = {
	snippet: "List directory contents",
	guidelines: [],
} as const;

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Get file or directory stats. Throws if not found. */
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	/** Read directory entries */
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
	exists: pathExists,
	stat: fsStat,
	readdir: fsReaddir,
};

export interface LsToolOptions {
	/** Custom operations for directory listing. Default: local filesystem */
	operations?: LsOperations;
}

export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	const ops = options?.operations ?? defaultLsOperations;
	return {
		name: "ls",
		label: "ls",
		executionKind: "effect",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: lsToolSystemPromptContribution.snippet,
		parameters: lsSchema,
		async execute(
			_toolCallId,
			{ path, limit }: { path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			// #2241: cancellation cannot retire the shared ticket while backend I/O is pending.
			const throwIfAborted = () => {
				if (signal?.aborted) throw new Error("Operation aborted");
			};
			throwIfAborted();
			try {
				const dirPath = resolveToCwd(path || ".", ctx?.cwd || cwd);
				const effectiveLimit = limit ?? DEFAULT_LIMIT;

				// Check if path exists.
				const exists = await ops.exists(dirPath);
				throwIfAborted();
				if (!exists) throw new Error(`Path not found: ${dirPath}`);

				// Check if path is a directory.
				const stat = await ops.stat(dirPath);
				throwIfAborted();
				if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

				// Read directory entries.
				let entries: string[];
				try {
					entries = await ops.readdir(dirPath);
				} catch (error: unknown) {
					throwIfAborted();
					throw new Error(`Cannot read directory: ${error instanceof Error ? error.message : String(error)}`);
				}
				throwIfAborted();

				// Sort alphabetically, case-insensitive.
				entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

				// Format entries with directory indicators.
				const results: string[] = [];
				let entryLimitReached = false;
				for (const entry of entries) {
					if (results.length >= effectiveLimit) {
						entryLimitReached = true;
						break;
					}

					const fullPath = nodePath.join(dirPath, entry);
					let suffix = "";
					try {
						const entryStat = await ops.stat(fullPath);
						throwIfAborted();
						if (entryStat.isDirectory()) suffix = "/";
					} catch {
						throwIfAborted();
						// Skip entries we cannot stat.
						continue;
					}
					throwIfAborted();
					results.push(entry + suffix);
				}

				throwIfAborted();
				if (results.length === 0) {
					return { content: [{ type: "text" as const, text: "(empty directory)" }], details: undefined };
				}

				const rawOutput = results.join("\n");
				// Apply byte truncation. There is no separate line limit because entry count is already capped.
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
				let output = truncation.content;
				const details: LsToolDetails = {};
				// Build actionable notices for truncation and entry limits.
				const notices: string[] = [];
				if (entryLimitReached) {
					notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
					details.entryLimitReached = effectiveLimit;
				}
				if (truncation.truncated) {
					notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
					details.truncation = truncation;
				}
				if (notices.length > 0) {
					output += `\n\n[${notices.join(". ")}]`;
				}

				return {
					content: [{ type: "text" as const, text: output }],
					details: Object.keys(details).length > 0 ? details : undefined,
				};
			} catch (error: unknown) {
				throwIfAborted();
				throw error;
			}
		},
		...lsRenderers,
	};
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
