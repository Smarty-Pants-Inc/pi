import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { ordinaryOwnerOf } from "../ordinary-owner-context.ts";
import { currentSessionOwnership } from "../session-ownership.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { writeRenderers } from "./renderers/write.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or complete rewrites."],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	const owner = options && ordinaryOwnerOf(options);
	if (owner && options?.operations) throw new Error("OWNER_TOOL_OPERATIONS");
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			if (!owner && currentSessionOwnership()) throw new Error("OWNER_TOOL_BINDING_REQUIRED");
			owner?.assertActive();
			if (owner && ctx && (ctx.sessionManager !== owner.owner.manager || ctx.cwd !== cwd))
				throw new Error("OWNER_TOOL_CONTEXT");
			const absolutePath = resolveToCwd(path, owner ? cwd : ctx?.cwd || cwd);
			const target = owner?.fileTarget(absolutePath, true);
			const dir = dirname(absolutePath);
			const execute = () =>
				withFileMutationQueue(absolutePath, async () => {
					// Do not reject from an abort event listener here: that would release the
					// mutation queue while an in-flight filesystem operation may still finish.
					// Checking signal.aborted after each await observes the same aborts while
					// keeping the queue locked until the current operation has settled.
					const throwIfAborted = (): void => {
						if (signal?.aborted) throw new Error("Operation aborted");
						owner?.assertActive();
					};

					throwIfAborted();
					// Create parent directories if needed.
					if (!owner) await ops.mkdir(dir);
					throwIfAborted();

					// Write the file contents.
					if (owner && target) {
						// Native write owns parent creation, replacement and durable readback.
						await owner.owner.writeFile(
							target.root,
							target.relativePath,
							Buffer.from(content),
							undefined,
							signal,
						);
					} else {
						await ops.writeFile(absolutePath, content);
					}
					throwIfAborted();

					return {
						content: [{ type: "text" as const, text: `Successfully wrote to ${path}` }],
						details: undefined,
					};
				});
			return owner ? owner.within(execute) : execute();
		},
		...writeRenderers,
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
