/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	EventStream,
	getCurrentTools,
	getToolStateChanges,
	normalizeContext,
	type SystemMessage,
	type ToolResultMessage,
	type ToolStateChanges,
	toToolDeclaration,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { getDefaultStreamFn } from "./stream-fn.ts";
import { ToolCallQueue } from "./tool-call-queue.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	PrepareNextTurnContext,
	StreamFn,
} from "./types.ts";
import { captureToolImplementation, isToolImplementationCurrent } from "./types.ts";

/** sourceMessage identifies queued input when tool declaration normalization copies it. */
export type AgentEventSink = (event: AgentEvent, sourceMessage?: AgentMessage) => Promise<void> | void;

/**
 * Clone a tool result for a hook, restoring metadata and native state omitted by
 * structuredClone. Ordinary accessors have already been evaluated by the snapshot;
 * restoration must reuse those captured values rather than consume a getter again.
 */
function cloneToolResult<T>(value: T): T {
	const clone = structuredClone(value);
	const copies = new WeakMap<object, object>();

	const restoreNativeMetadata = (source: unknown, target?: unknown): unknown => {
		if (source === null || typeof source !== "object") return target === undefined ? structuredClone(source) : target;
		const existing = copies.get(source);
		if (existing) return existing;
		const copy: object = target === undefined ? structuredClone(source) : (target as object);
		copies.set(source, copy);

		// Native metadata may contain cycles or refer to values elsewhere in the result.
		// Reuse the same source-to-copy map through every supported container.
		if (source instanceof Map && copy instanceof Map) {
			const entries = [...copy.entries()];
			copy.clear();
			let index = 0;
			for (const [key, entry] of source) {
				const [copiedKey, copiedEntry] = entries[index++];
				copy.set(restoreNativeMetadata(key, copiedKey), restoreNativeMetadata(entry, copiedEntry));
			}
		} else if (source instanceof Set && copy instanceof Set) {
			const entries = [...copy.values()];
			copy.clear();
			let index = 0;
			for (const entry of source) copy.add(restoreNativeMetadata(entry, entries[index++]));
		}
		if (source instanceof AggregateError && copy instanceof Error) {
			Object.setPrototypeOf(copy, AggregateError.prototype);
		}

		const sourceRecord = source as Record<PropertyKey, unknown>;
		const copyRecord = copy as Record<PropertyKey, unknown>;
		for (const key of Reflect.ownKeys(source)) {
			const descriptor = Object.getOwnPropertyDescriptor(source, key);
			if (!descriptor) continue;
			const nativeState =
				(source instanceof Error && key === "cause") ||
				(source instanceof AggregateError && key === "errors") ||
				(source instanceof RegExp && key === "lastIndex");
			if (!descriptor.enumerable && !nativeState) continue;
			const copiedDescriptor = Object.getOwnPropertyDescriptor(copy, key);
			// A data descriptor lets us traverse the original graph without invoking
			// accessors again. A captured accessor value is already an isolated snapshot.
			const restored =
				"value" in descriptor
					? restoreNativeMetadata(
							descriptor.value,
							nativeState && key === "lastIndex" ? undefined : copiedDescriptor?.value,
						)
					: copiedDescriptor
						? copiedDescriptor.value
						: restoreNativeMetadata(sourceRecord[key]);
			Object.defineProperty(copyRecord, key, {
				value: restored,
				writable: true,
				enumerable: descriptor.enumerable,
				configurable: copiedDescriptor?.configurable ?? true,
			});
		}
		return copy;
	};

	restoreNativeMetadata(value, clone);
	return clone;
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const { stream, emit, fail } = createAgentStream(config);

	void runAgentLoop(prompts, context, config, emit, signal, streamFn).then((messages) => {
		stream.end(messages);
	}, fail);

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const { stream, emit, fail } = createAgentStream(config);

	void runAgentLoopContinue(context, config, emit, signal, streamFn).then((messages) => {
		stream.end(messages);
	}, fail);

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const hadPrompts = prompts.length > 0;
	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	const injectedPrompts = await appendPendingMessages(currentContext, newMessages, [prompts], emit);
	if (hadPrompts && !injectedPrompts) {
		await emit({ type: "agent_end", messages: newMessages });
		return newMessages;
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(config: AgentLoopConfig): {
	stream: EventStream<AgentEvent, AgentMessage[]>;
	emit: AgentEventSink;
	fail: (error: unknown) => void;
} {
	const stream = new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
	const messages: AgentMessage[] = [];
	return {
		stream,
		emit: (event) => {
			if (event.type === "message_end") messages.push(event.message);
			stream.push(event);
		},
		fail: () => {
			// The exported producer owns rejection. Preserve published outcomes and finish iteration/result.
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: config.model.api,
				provider: config.model.provider,
				model: config.model.id,
				stopReason: "error",
				errorMessage: "Agent loop failed",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			stream.push({ type: "message_start", message });
			stream.push({ type: "message_end", message });
			messages.push(message);
			stream.push({ type: "agent_end", messages });
			stream.end(messages);
		},
	};
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	let explicitContinuation = false;
	let contextOnlyTurn = false;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];
	let hasMoreToolCalls = true;

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0 || contextOnlyTurn) {
			let preparedMessages: AgentMessage[] = [];
			if (lastCompletedTurn) {
				const nextTurnSnapshot = signal?.aborted ? undefined : await config.prepareNextTurn?.(lastCompletedTurn);
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					preparedMessages = nextTurnSnapshot.messages ?? [];
					config = {
						...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning:
							nextTurnSnapshot.thinkingLevel === undefined
								? config.reasoning
								: nextTurnSnapshot.thinkingLevel === "off"
									? undefined
									: nextTurnSnapshot.thinkingLevel,
					};
				}
				// Preparation can be long-running (for example, compaction). Pick up steering
				// queued while it ran. Only poll again if the earlier poll returned nothing;
				// otherwise one-at-a-time mode would deliver two messages in this turn.
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getSteeringMessages?.()) || [];
				}
				if (!hasMoreToolCalls && !contextOnlyTurn && preparedMessages.length === 0 && pendingMessages.length === 0)
					break;
				await emit({ type: "turn_start" });
			}

			const injectedMessages = await appendPendingMessages(
				currentContext,
				newMessages,
				[preparedMessages, pendingMessages],
				emit,
			);
			pendingMessages = [];
			// Clearing queued input is not a context-only continuation decision.
			if (!hasMoreToolCalls && !contextOnlyTurn && !injectedMessages) break;
			contextOnlyTurn = false;

			// Queued input still reaches the provider with the aborted signal, as upstream does.
			// Do not re-enter request preparation (routing/compaction/state admission) for
			// an already-cancelled turn. Cancellation during preparation keeps its guards.
			const requestUpdate = signal?.aborted
				? undefined
				: await config.prepareRequest?.(
						{
							context: currentContext,
							model: config.model,
							thinkingLevel: config.reasoning ?? "off",
						},
						signal,
					);
			if (requestUpdate) {
				currentContext = requestUpdate.context ?? currentContext;
				config = {
					...config,
					model: requestUpdate.model ?? config.model,
					reasoning:
						requestUpdate.thinkingLevel === undefined
							? config.reasoning
							: requestUpdate.thinkingLevel === "off"
								? undefined
								: requestUpdate.thinkingLevel,
				};
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				lastCompletedTurn = {
					message,
					toolResults: [],
					context: currentContext,
					newMessages,
				};
				await config.finishTurn?.(lastCompletedTurn, signal);
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
				if (executedToolBatch.failure) throw executedToolBatch.failure.error;
			}

			lastCompletedTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const decision = await config.finishTurn?.(lastCompletedTurn, signal);
			await emit({ type: "turn_end", message, toolResults });

			if (decision?.action === "end") {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			explicitContinuation = decision?.action === "continue";
			pendingMessages = (await config.getSteeringMessages?.()) || [];
			if (hasMoreToolCalls || pendingMessages.length > 0) {
				explicitContinuation = false;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			explicitContinuation = false;
			pendingMessages = followUpMessages;
			continue;
		}

		// No natural request was selected, so fulfill the continuation decision with one context-only turn.
		if (explicitContinuation) {
			explicitContinuation = false;
			contextOnlyTurn = true;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

type PendingMessage = {
	message: AgentMessage;
	source?: { batch: AgentMessage[]; index: number; message: AgentMessage };
};

async function appendPendingMessages(
	context: AgentContext,
	newMessages: AgentMessage[],
	batches: AgentMessage[][],
	emit: AgentEventSink,
): Promise<boolean> {
	let injected = false;
	// The final pass reconciles tools if a pending system declaration was cleared
	// during an awaited event. A synthetic declaration never counts as queued input.
	for (const pending of [batches, []]) {
		for (const { message, source } of declareToolChanges(context, pending)) {
			if (source && source.batch[source.index] !== source.message) continue;
			await emit({ type: "message_start", message }, source?.message);
			await emit({ type: "message_end", message });
			context.messages.push(message);
			newMessages.push(message);
			if (source) injected = true;
		}
	}
	return injected;
}

/**
 * Declare tool loadout changes to the model.
 *
 * `context.tools` is what the runtime can execute; the transcript's system messages declare
 * what the model may call. Before each request the difference becomes `toolsAdded` and
 * `toolsRemoved` on a system message. When a pending system message exists, its tool fields
 * are treated as intent and replaced with the delta between the committed transcript and
 * the executable set, so replay always yields exactly `context.tools`. Otherwise a new
 * system message is inserted before the first non-system pending message.
 */
function declareToolChanges(context: AgentContext, batches: AgentMessage[][]): PendingMessage[] {
	// Keep each original reservation slot alongside its normalized message. The
	// caller rechecks that slot immediately before transferring it at message_start.
	const entries: PendingMessage[] = batches.flatMap((batch) =>
		batch.map((message, index) => ({ message, source: { batch, index, message } })),
	);
	const pendingMessages = entries.map((entry) => entry.message);
	let systemIndex = -1;
	for (let i = pendingMessages.length - 1; i >= 0; i--) {
		if (pendingMessages[i].role === "system") {
			systemIndex = i;
			break;
		}
	}
	const pending = pendingMessages[systemIndex] as SystemMessage | undefined;
	const baseline = pending
		? pendingMessages.map((message, index) =>
				index === systemIndex ? withToolChanges(pending, NO_CHANGES) : message,
			)
		: pendingMessages;
	const changes = getToolStateChanges(
		getCurrentTools([...context.messages, ...baseline]),
		(context.tools ?? []).map(toToolDeclaration),
	);
	const unchanged = changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;

	if (pending) {
		// Keep the caller's message object when it already declares no tool changes.
		if (unchanged && !pending.toolsAdded?.length && !pending.toolsRemoved?.length) return entries;
		return entries.map((entry, index) =>
			index === systemIndex ? { ...entry, message: withToolChanges(pending, changes) } : entry,
		);
	}
	if (unchanged) return entries;
	const update = withToolChanges({ role: "system", content: "", timestamp: Date.now() }, changes);
	const insertIndex = pendingMessages.findIndex((message) => message.role !== "system");
	const index = insertIndex === -1 ? pendingMessages.length : insertIndex;
	return [...entries.slice(0, index), { message: update }, ...entries.slice(index)];
}

const NO_CHANGES: ToolStateChanges = { toolsAdded: [], toolsRemoved: [] };

/** Copy a system message with its tool fields replaced by `changes`; empty lists omit the field. */
function withToolChanges(message: SystemMessage, { toolsAdded, toolsRemoved }: ToolStateChanges): SystemMessage {
	const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
	return {
		...rest,
		...(toolsAdded.length > 0 ? { toolsAdded } : {}),
		...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
	};
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	const llmContext = normalizeContext({ messages: llmMessages });

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});
	// Record the requested level, whichever stream function answered.
	const result = async () => Object.assign(await response.result(), { thinkingLevel: config.reasoning ?? "off" });

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	// Capture classification and callable methods before any awaited event or hook.
	const tools = (currentContext.tools ?? []).map((tool) =>
		captureToolImplementation(tool, config.getCurrentTools ?? (() => currentContext.tools ?? [])),
	);
	const queue = config.toolCallQueue ?? new ToolCallQueue();
	const hasSequentialToolCall = toolCalls.some(
		(tc) => tools.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(
			currentContext,
			assistantMessage,
			toolCalls,
			config,
			signal,
			emit,
			tools,
			queue,
		);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit, tools, queue);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
	failure?: { error: unknown };
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	tools: readonly AgentTool[],
	queue: ToolCallQueue,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];
	let failure: { error: unknown } | undefined;

	for (const toolCall of toolCalls) {
		await queue.run(
			{ id: toolCall.id, exclusive: true, signal },
			async () => {
				await emit({
					type: "tool_execution_start",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
				});

				const preparation = await prepareToolCall(
					currentContext,
					assistantMessage,
					toolCall,
					config,
					signal,
					tools,
				);
				let finalized: FinalizedToolCallOutcome;
				if (preparation.kind === "immediate") {
					finalized = {
						toolCall,
						result: preparation.result,
						isError: preparation.isError,
					};
				} else {
					const executed = await executePreparedToolCall(
						preparation,
						signal,
						emitToolExecutionUpdate(toolCall, emit),
					);
					finalized = await finalizeExecutedToolCall(
						currentContext,
						assistantMessage,
						preparation,
						executed,
						config,
						signal,
					);
				}

				failure ??= finalized.publicationFailure;
				await emitToolExecutionEnd(finalized, emit).catch((error: unknown) => {
					failure ??= { error };
				});
				const toolResultMessage = createToolResultMessage(finalized);
				await emitToolResultMessage(toolResultMessage, emit).catch((error: unknown) => {
					failure ??= { error };
				});
				finalizedCalls.push(finalized);
				messages.push(toolResultMessage);
			},
			async () => {
				const finalized: FinalizedToolCallOutcome = {
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
				await emit({
					type: "tool_execution_start",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
				});
				await emitToolExecutionEnd(finalized, emit).catch((error: unknown) => {
					failure ??= { error };
				});
				const message = createToolResultMessage(finalized);
				await emitToolResultMessage(message, emit).catch((error: unknown) => {
					failure ??= { error };
				});
				finalizedCalls.push(finalized);
				messages.push(message);
			},
		);

		if (failure) {
			break;
		}
	}

	return {
		messages,
		terminate: signal?.aborted === true || shouldTerminateToolBatch(finalizedCalls),
		failure,
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	tools: readonly AgentTool[],
	queue: ToolCallQueue,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];
	let failure: { error: unknown } | undefined;

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal, tools);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit).catch((error: unknown) => {
				failure ??= { error };
			});
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () =>
			queue.run(
				{
					id: toolCall.id,
					exclusive: preparation.tool.executionMode === "sequential",
					signal,
				},
				async () => {
					const executed = await executePreparedToolCall(
						preparation,
						signal,
						emitToolExecutionUpdate(toolCall, emit),
					);
					const finalized = await finalizeExecutedToolCall(
						currentContext,
						assistantMessage,
						preparation,
						executed,
						config,
						signal,
					);
					failure ??= finalized.publicationFailure;
					await emitToolExecutionEnd(finalized, emit).catch((error: unknown) => {
						failure ??= { error };
					});
					return finalized;
				},
				async () => {
					// #8935: start was emitted before preflight. Refused admission still
					// owes one end, but must not execute or invoke result hooks.
					const finalized = {
						toolCall,
						result: createErrorToolResult("Operation aborted"),
						isError: true,
					} satisfies FinalizedToolCallOutcome;
					await emitToolExecutionEnd(finalized, emit).catch((error: unknown) => {
						failure ??= { error };
					});
					return finalized;
				},
			),
		);
		if (signal?.aborted) {
			break;
		}
	}

	const settled = await Promise.allSettled(
		finalizedCalls.map((entry) =>
			(typeof entry === "function" ? entry() : Promise.resolve(entry)).catch((error: unknown) => {
				failure ??= { error };
				throw error;
			}),
		),
	);
	// End observers can fail while other tools still execute. Join every accepted
	// pipeline, then publish every known native outcome before propagating failure.
	const orderedFinalizedCalls = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit).catch((error: unknown) => {
			failure ??= { error };
		});
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
		failure,
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = Pick<AgentToolCallOutcome, "result" | "isError" | "publicationFailure">;

type FinalizedToolCallOutcome = AgentToolCallOutcome;

/** The `beforeToolCall` and `afterToolCall` hooks of {@link AgentLoopConfig}. */
export type ToolCallHooks = Pick<AgentLoopConfig, "beforeToolCall" | "afterToolCall" | "getCurrentTools">;

type ToolUpdateSink = (partialResult: AgentToolResult<any>) => Promise<void> | void;

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

const MAX_LISTED_TOOLS = 40;

/** Name the tools valid in this session so the model can correct the call (smarty-dev#1528 K05). */
export function toolNotFoundMessage(name: string, tools: ReadonlyArray<{ name: string }>): string {
	const names = [...new Set(tools.map((t) => t.name))].sort();
	if (names.length === 0) return `Tool ${name} not found. No tools are available in this session.`;
	const listed = names.slice(0, MAX_LISTED_TOOLS).join(", ");
	const more = names.length > MAX_LISTED_TOOLS ? `, ... (${names.length - MAX_LISTED_TOOLS} more)` : "";
	return `Tool ${name} not found. Available tools in this session: ${listed}${more}`;
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const selected = tools.find((t) => t.name === toolCall.name);
	const tool = selected && captureToolImplementation(selected);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(toolNotFoundMessage(toolCall.name, tools)),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

function emitToolExecutionUpdate(toolCall: AgentToolCall, emit: AgentEventSink): ToolUpdateSink {
	return (partialResult) =>
		emit({
			type: "tool_execution_update",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
			partialResult,
		});
}

/** Options for {@link runToolCall}. */
export interface RunToolCallOptions extends ToolCallHooks {
	/** Tools the call resolves against. */
	tools: readonly AgentTool<any>[];
	/** Passed to the hooks as the message that issued the call. */
	assistantMessage: AssistantMessage;
	/** Passed to the hooks as the current agent context. */
	context: AgentContext;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateSink;
}

/**
 * Run one tool call through the same steps as a model-issued call: argument preparation, schema
 * validation, `beforeToolCall`, execution, and `afterToolCall`. Emits no events and adds no
 * messages. Tools that call other tools use this so the hooks (for example permission checks)
 * apply to those calls too.
 *
 * Never rejects for tool failures: unknown tools, validation errors, blocked calls, and thrown
 * errors come back as `isError: true`.
 */
export async function runToolCall(toolCall: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {
	const { assistantMessage, context, signal } = options;
	const tools = options.tools.map((tool) =>
		captureToolImplementation(tool, options.getCurrentTools ?? (() => options.tools)),
	);
	const preparation = await prepareToolCall(context, assistantMessage, toolCall, options, signal, tools);
	if (preparation.kind === "immediate") {
		return { toolCall, result: preparation.result, isError: preparation.isError };
	}
	const executed = await executePreparedToolCall(preparation, signal, options.onUpdate ?? (() => {}));
	const finalized = await finalizeExecutedToolCall(context, assistantMessage, preparation, executed, options, signal);
	if (!finalized.publicationFailure) return finalized;
	// Direct callers still receive a tool error, but the accepted effect and its accounting
	// remain available independently. Model-issued calls journal the native result first.
	const error = finalized.publicationFailure.error;
	return {
		...finalized,
		completedResult: finalized.result,
		result: {
			...finalized.result,
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		},
		isError: true,
	};
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;
	let failure: { error: unknown } | undefined;
	let result: AgentToolResult<unknown> | undefined;
	const retainFailure = (error: unknown) => {
		failure ??= { error };
	};

	try {
		if (signal?.aborted) return { result: createErrorToolResult("Operation aborted"), isError: true };
		if (!isToolImplementationCurrent(prepared.tool)) {
			return { result: createErrorToolResult("Tool registration is no longer callable"), isError: true };
		}
		result = await prepared.tool.execute(prepared.toolCall.id, prepared.args as never, signal, (partialResult) => {
			if (!acceptingUpdates) return;
			try {
				// Attach to the exact observer promise before returning to the tool.
				updateEvents.push(Promise.resolve(onUpdate(partialResult)).catch(retainFailure));
			} catch (error) {
				retainFailure(error);
			}
		});
	} catch (error) {
		retainFailure(error);
	} finally {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
	}
	if (result !== undefined) {
		// Observer failures do not undo a completed native effect. Drain updates above,
		// retain its receipt/usage, then propagate publication failure after journaling.
		return { result, isError: result.isError === true, publicationFailure: failure };
	}
	const error = failure?.error;
	return { result: createErrorToolResult(error instanceof Error ? error.message : String(error)), isError: true };
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;
	let publicationFailure = executed.publicationFailure;
	let completedResult = executed.result;

	if (config.afterToolCall) {
		try {
			// Hooks receive a working copy, never the retained completed-native facts.
			// If copying fails, skip the hook and report a transformation failure.
			completedResult = cloneToolResult(executed.result);
			result = cloneToolResult(completedResult);
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				// Structured content not replaced along with the content may no longer match it.
				const structuredContent =
					afterResult.structuredContent !== undefined
						? afterResult.structuredContent
						: afterResult.content
							? undefined
							: result.structuredContent;
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details !== undefined ? afterResult.details : result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				if (structuredContent === undefined) delete result.structuredContent;
				else result.structuredContent = structuredContent;
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = completedResult;
			isError = executed.isError;
			publicationFailure ??= { error };
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
		publicationFailure,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	let failure: { error: unknown } | undefined;
	try {
		await emit({ type: "message_start", message: toolResultMessage });
	} catch (error) {
		failure = { error };
	}
	try {
		await emit({ type: "message_end", message: toolResultMessage });
	} catch (error) {
		failure ??= { error };
	}
	if (failure) throw failure.error;
}
