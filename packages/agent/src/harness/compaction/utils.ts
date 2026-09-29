import { contentText, type Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";

/** File paths touched by a session branch or compaction range. */
export interface FileOperations {
	/** Files read but not necessarily modified. */
	read: Set<string>;
	/** Files written by full-file write operations. */
	written: Set<string>;
	/** Files modified by edit operations. */
	edited: Set<string>;
}

/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/** Add file operations from assistant tool calls to an accumulator. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		const set =
			block.name === "read"
				? fileOps.read
				: block.name === "write"
					? fileOps.written
					: block.name === "edit"
						? fileOps.edited
						: undefined;
		// Delete first so each set stays ordered from least to most recently used.
		set?.delete(path);
		set?.add(path);
	}
}

/**
 * Most recent files kept per list. Earlier compactions carry their lists forward, so without a cap
 * the lists grow with the whole session (smarty-dev#2177: 4,891 paths, 510 KB, in one summary).
 */
export const MAX_SUMMARY_FILES = 50;

export interface FileLists {
	/** Read-only files, least to most recently used, at most MAX_SUMMARY_FILES. */
	readFiles: string[];
	/** Modified files, least to most recently used, at most MAX_SUMMARY_FILES. */
	modifiedFiles: string[];
	omittedReadFiles: number;
	omittedModifiedFiles: number;
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles, each capped to the most
 * recently used MAX_SUMMARY_FILES, in recency order so the next compaction keeps the newest.
 */
export function computeFileLists(fileOps: FileOperations): FileLists {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f));
	const modifiedFiles = [...modified];
	return {
		readFiles: readOnly.slice(-MAX_SUMMARY_FILES),
		modifiedFiles: modifiedFiles.slice(-MAX_SUMMARY_FILES),
		omittedReadFiles: Math.max(0, readOnly.length - MAX_SUMMARY_FILES),
		omittedModifiedFiles: Math.max(0, modifiedFiles.length - MAX_SUMMARY_FILES),
	};
}

/**
 * Format file operations as XML tags for summary. Lists are sorted for reading.
 */
export function formatFileOperations(lists: FileLists): string {
	const section = (tag: string, files: string[], omitted: number) => {
		const lines = [...files].sort();
		if (omitted > 0) lines.push(`(+${omitted} earlier files omitted)`);
		return `<${tag}>\n${lines.join("\n")}\n</${tag}>`;
	};
	const sections: string[] = [];
	if (lists.readFiles.length > 0) sections.push(section("read-files", lists.readFiles, lists.omittedReadFiles));
	if (lists.modifiedFiles.length > 0) {
		sections.push(section("modified-files", lists.modifiedFiles, lists.omittedModifiedFiles));
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

const TOOL_RESULT_MAX_CHARS = 2000;

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = contentText(msg.content, "");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}
