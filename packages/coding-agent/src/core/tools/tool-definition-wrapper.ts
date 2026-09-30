import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";

/** Creates the context for one tool call. */
export type ToolContextFactory = (toolCallId: string, signal: AbortSignal | undefined) => ExtensionToolContext;

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: ToolContextFactory,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		outputSchema: definition.outputSchema,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		executionKind: definition.executionKind,
		execute: (toolCallId, params, signal, onUpdate, ctx?: ExtensionToolContext) =>
			definition.execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx ?? (ctxFactory?.(toolCallId, signal) as ExtensionToolContext),
			),
	};
}

/** Own accepted ctx.executeTool work before a native callback can return. */
export function scopeToolDefinition(
	definition: ToolDefinition,
	runScope: <T>(
		toolCallId: string,
		signal: AbortSignal | undefined,
		run: (isAccepting: () => boolean) => Promise<T>,
	) => Promise<T>,
): ToolDefinition {
	const admittedDefinition = { ...definition };
	return {
		...admittedDefinition,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			runScope(toolCallId, signal, async (isAccepting) => {
				// Keep lazy context getters, and bind admission to this exact invocation,
				// not a reusable call id or the next agent run's signal.
				const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(ctx);
				delete descriptors.executeTool;
				const ownedContext = Object.defineProperties({}, descriptors) as ExtensionToolContext;
				Object.defineProperty(ownedContext, "executeTool", {
					value: (name: string, args: unknown, options = {}) => {
						if (isAccepting()) return ctx.executeTool(name, args, options);
						return Promise.resolve({
							toolCall: { type: "toolCall" as const, id: `${toolCallId}/0`, name, arguments: {} },
							result: { content: [{ type: "text" as const, text: "Calling tool has retired" }], details: {} },
							isError: true,
						});
					},
				});
				return admittedDefinition.execute(toolCallId, params, signal, onUpdate, ownedContext);
			}),
	};
}

/** Native dispatch owns admission through completion hooks; the public registry remains directly callable. */
export function wrapToolWithCompletionOwner(
	tool: AgentTool,
	runWithOwner: <T>(toolCallId: string, run: () => Promise<T>) => Promise<T>,
): AgentTool {
	return {
		...tool,
		execute: (toolCallId, params, signal, onUpdate) =>
			runWithOwner(toolCallId, () => tool.execute(toolCallId, params, signal, onUpdate)),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: ToolContextFactory,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		outputSchema: tool.outputSchema,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		executionKind: tool.executionKind,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
