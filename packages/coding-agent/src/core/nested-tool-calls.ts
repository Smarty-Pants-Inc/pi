/**
 * Tool calls that a tool makes while it runs (`ctx.executeTool()`), for example from codemode
 * scripts. The agent loop does not know about them: the session runs each one through the agent's
 * tool pipeline (`runToolCall`) with its own hooks, emits `tool_execution_*` events with
 * `parentToolCallId`, and records the calls and their usage on the model-issued call's tool result
 * message.
 *
 * Parents are admitted for their execute lifetime. Nested work only starts through `ctx.executeTool()`.
 */

import type {
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { captureToolImplementation, ToolCallQueue } from "@earendil-works/pi-agent-core";
import type { JsonObject, NestedToolCallRecord, NestedToolCalls, TextContent, Usage } from "@earendil-works/pi-ai";
import { combineUsage } from "./usage-totals.ts";

/**
 * Limits of the nested-call record on a tool result: arguments
 * over the per-call or total size are omitted, calls beyond the count are dropped, and the record
 * is marked incomplete when any of that happens.
 */
export const NESTED_CALL_LIMITS = {
	maxCalls: 256,
	maxArgumentBytesPerCall: 8 * 1024,
	maxArgumentBytesTotal: 32 * 1024,
	maxErrorChars: 500,
} as const;

const encoder = new TextEncoder();

/** What the nested calls of one model-issued tool call leave on its tool result message. */
export interface NestedCallSummary {
	/** Becomes `nestedCalls`. Undefined when no nested call was made. */
	calls: NestedToolCalls | undefined;
	/** Summed `usage` of the nested results, added to the message's `usage`. */
	usage: Usage | undefined;
}

/**
 * Collects the nested calls of one model-issued tool call, including calls made by nested tools.
 * The snapshot becomes `nestedCalls` on the tool result message.
 */
export class NestedCallRecorder {
	private readonly calls: NestedToolCallRecord[] = [];
	private readonly startedAt = new Map<NestedToolCallRecord, number>();
	private complete = true;
	private argumentBytes = 0;
	/** Summed usage of every nested result, including calls dropped from the record. */
	private usage: Usage | undefined;

	/** Record a call as it starts. Returns undefined when the call is dropped. */
	start(toolCall: AgentToolCall): NestedToolCallRecord | undefined {
		if (this.calls.length >= NESTED_CALL_LIMITS.maxCalls) {
			this.complete = false;
			return undefined;
		}
		const record: NestedToolCallRecord = { id: toolCall.id, name: toolCall.name, status: "unfinished" };
		const json = JSON.stringify(toolCall.arguments ?? {});
		const bytes = encoder.encode(json).length;
		if (
			bytes > NESTED_CALL_LIMITS.maxArgumentBytesPerCall ||
			this.argumentBytes + bytes > NESTED_CALL_LIMITS.maxArgumentBytesTotal
		) {
			record.argumentsBytes = bytes;
			this.complete = false;
		} else {
			record.arguments = JSON.parse(json) as JsonObject;
			this.argumentBytes += bytes;
		}
		this.calls.push(record);
		this.startedAt.set(record, performance.now());
		return record;
	}

	finish(record: NestedToolCallRecord | undefined, isError: boolean, errorText: string): void {
		if (!record) return;
		record.status = isError ? "error" : "ok";
		record.durationMs = Math.round(performance.now() - (this.startedAt.get(record) ?? performance.now()));
		this.startedAt.delete(record);
		if (isError && errorText) record.error = errorText.slice(0, NESTED_CALL_LIMITS.maxErrorChars);
	}

	addUsage(usage: Usage): void {
		this.usage = this.usage ? combineUsage(this.usage, usage) : usage;
	}

	get totalUsage(): Usage | undefined {
		return this.usage;
	}

	/** Copy of the record so far, or undefined when no nested call was made. */
	snapshot(): NestedToolCalls | undefined {
		if (this.calls.length === 0 && this.complete) return undefined;
		const calls = this.calls.map((call) => ({ ...call }));
		return { calls, complete: this.complete && calls.every((call) => call.status !== "unfinished") };
	}
}

export interface NestedToolCallOptions {
	/** Additional cancellation; the calling tool's cancellation always applies. */
	signal?: AbortSignal;
	/** Receives partial results of the nested tool, in addition to `tool_execution_update` events. */
	onUpdate?: AgentToolUpdateCallback;
}

/** `tool_execution_*` events of nested calls. */
export type NestedToolExecutionEvent =
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; parentToolCallId: string }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: AgentToolResult<unknown>;
			parentToolCallId: string;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
			parentToolCallId: string;
	  };

export interface NestedToolCallHost {
	/** Tools nested calls resolve against. */
	getTools(): readonly AgentTool[];
	/** Whether every nested call runs exclusively, as when the agent executes tool calls sequentially. */
	isSequential(): boolean;
	/** Same admission queue as model-issued calls. */
	queue?: ToolCallQueue;
	/** Run the call through the tool pipeline, with hooks that report `parentToolCallId`. */
	runToolCall(
		toolCall: AgentToolCall,
		parentToolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: (partialResult: AgentToolResult<unknown>) => Promise<void>,
		tools: readonly AgentTool[],
	): Promise<AgentToolCallOutcome>;
	emit(event: NestedToolExecutionEvent): Promise<void>;
}

/** Calls below one model-issued call share its recorder. */
interface CallScope {
	recorder: NestedCallRecorder;
	nextId: number;
	accepting: boolean;
	controller: AbortController;
	signal: AbortSignal;
	pending: Promise<void>[];
	failure?: { error: unknown };
	closing?: Promise<void>;
}

function textOf(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export class NestedToolCallRunner {
	private readonly host: NestedToolCallHost;
	/** Scopes by the id of the calling tool call. */
	private readonly scopes = new Map<string, CallScope>();
	private readonly queue: ToolCallQueue;

	constructor(host: NestedToolCallHost) {
		this.host = host;
		this.queue = host.queue ?? new ToolCallQueue();
	}

	/** Admit a model-issued parent for exactly its execute lifetime. */
	open(toolCallId: string, signal?: AbortSignal): void {
		if (this.scopes.has(toolCallId)) throw new Error("Tool call is already admitted");
		const controller = new AbortController();
		this.scopes.set(toolCallId, {
			recorder: new NestedCallRecorder(),
			nextId: 1,
			accepting: true,
			controller,
			signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
			pending: [],
		});
	}

	async runParent<T>(
		toolCallId: string,
		signal: AbortSignal | undefined,
		execute: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const nested = this.scopes.get(toolCallId);
		// Nested dispatch owns its full pipeline, including result hooks and end delivery.
		if (nested) {
			if (!nested.accepting) throw new Error("Parent tool call has retired");
			return execute(nested.signal);
		}
		this.open(toolCallId, signal);
		const scope = this.scopes.get(toolCallId)!;
		try {
			return await execute(scope.signal);
		} catch (error) {
			scope.failure ??= { error };
			throw error;
		} finally {
			await this.closeScope(scope);
		}
	}

	/** Retire admission before cancelling and joining every accepted descendant. */
	close(toolCallId: string): Promise<void> {
		const scope = this.scopes.get(toolCallId);
		return scope ? this.closeScope(scope) : Promise.resolve();
	}

	private closeScope(scope: CallScope): Promise<void> {
		if (scope.closing) return scope.closing;
		scope.accepting = false;
		scope.controller.abort(new Error("Parent tool execution finished"));
		scope.closing = Promise.all(scope.pending).then(() => {
			if (scope.failure) throw scope.failure.error;
		});
		return scope.closing;
	}

	/**
	 * Run `name` on behalf of the call `callerId`. The nested call gets the id `<callerId>/<n>`.
	 * Tool failures return `isError: true`; retired admission and observer failures reject.
	 */
	execute(
		callerId: string,
		name: string,
		args: unknown,
		options: NestedToolCallOptions = {},
	): Promise<AgentToolCallOutcome> {
		const scope = this.scopes.get(callerId);
		if (!scope?.accepting) return Promise.reject(new Error("Parent tool call has retired"));
		const signals = options.signal ? [scope.signal, options.signal] : [scope.signal];
		const signal = AbortSignal.any(signals);
		if (signal.aborted) return Promise.reject(signal.reason);
		const operation = this.executeCall(callerId, scope, name, args, { ...options, signal });
		// Observe the exact child promise immediately, including fire-and-forget callers.
		scope.pending.push(
			operation.then(
				() => {},
				(error: unknown) => {
					scope.failure ??= { error };
				},
			),
		);
		return operation;
	}

	private async executeCall(
		callerId: string,
		scope: CallScope,
		name: string,
		args: unknown,
		options: NestedToolCallOptions,
	): Promise<AgentToolCallOutcome> {
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: `${callerId}/${scope.nextId++}`,
			name,
			arguments: (args ?? {}) as AgentToolCall["arguments"],
		};
		const tools = this.host.getTools().map(captureToolImplementation);
		const record = scope.recorder.start(toolCall);
		await this.host.emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: name,
			args: toolCall.arguments,
			parentToolCallId: callerId,
		});

		const exclusive =
			this.host.isSequential() || tools.find((tool) => tool.name === name)?.executionMode === "sequential";
		const controller = new AbortController();
		const child: CallScope = {
			recorder: scope.recorder,
			nextId: 1,
			accepting: true,
			controller,
			signal: AbortSignal.any([options.signal!, controller.signal]),
			pending: [],
		};
		let finalized = false;
		try {
			// Provider/display IDs are not invocation authority. Refuse an alias
			// collision before mutation, retaining the other invocation's custody.
			if (this.scopes.has(toolCall.id)) throw new Error("Nested tool call ID collision");
			this.scopes.set(toolCall.id, child);
			return await this.queue.run(
				{
					id: toolCall.id,
					parentId: this.queue.has(callerId) ? callerId : undefined,
					exclusive,
					signal: options.signal,
				},
				async () => {
					options.signal?.throwIfAborted();
					const outcome = await this.host.runToolCall(
						toolCall,
						callerId,
						options.signal,
						async (partialResult) => {
							await options.onUpdate?.(partialResult);
							await this.host.emit({
								type: "tool_execution_update",
								toolCallId: toolCall.id,
								toolName: name,
								args: toolCall.arguments,
								partialResult,
								parentToolCallId: callerId,
							});
						},
						tools,
					);
					await this.closeScope(child);

					finalized = true;
					scope.recorder.finish(record, outcome.isError, textOf(outcome.result));
					// Nested results are not persisted, so their usage is only counted through the recorder.
					if (outcome.result.usage) scope.recorder.addUsage(outcome.result.usage);
					await this.host.emit({
						type: "tool_execution_end",
						toolCallId: toolCall.id,
						toolName: name,
						result: outcome.result,
						isError: outcome.isError,
						parentToolCallId: callerId,
					});
					return outcome;
				},
			);
		} catch (error) {
			// Every published start owns one end, including refused/cancelled lease admission.
			// Mark before delivery so a rejecting observer cannot cause a second end attempt.
			if (!finalized) {
				finalized = true;
				const result: AgentToolResult<unknown> = {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
				};
				scope.recorder.finish(record, true, textOf(result));
				await this.host.emit({
					type: "tool_execution_end",
					toolCallId: toolCall.id,
					toolName: name,
					result,
					isError: true,
					parentToolCallId: callerId,
				});
			}
			child.failure ??= { error };
			throw error;
		} finally {
			try {
				await this.closeScope(child);
			} finally {
				if (this.scopes.get(toolCall.id) === child) this.scopes.delete(toolCall.id);
			}
		}
	}

	/** Remove and return the record of the nested calls a model-issued call made. */
	takeRecord(toolCallId: string): NestedCallSummary | undefined {
		const scope = this.scopes.get(toolCallId);
		this.scopes.delete(toolCallId);
		if (!scope) return undefined;
		return { calls: scope.recorder.snapshot(), usage: scope.recorder.totalUsage };
	}

	async clear(): Promise<void> {
		const settled = await Promise.allSettled([...this.scopes.values()].map((scope) => this.closeScope(scope)));
		this.scopes.clear();
		const failure = settled.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}
}
