/**
 * Tool calls that a tool makes while it runs (`ctx.executeTool()`), for example from codemode
 * scripts. The agent loop does not know about them: the session runs each one through the agent's
 * tool pipeline (`runToolCall`) with its own hooks, emits `tool_execution_*` events with
 * `parentToolCallId`, and records the calls and their usage on the model-issued call's tool result
 * message.
 *
 * Nothing here runs until a tool calls `ctx.executeTool()`.
 */

import type {
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
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
	/** Defaults to the calling tool's signal. */
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
	/** Run the call through the tool pipeline, with hooks that report `parentToolCallId`. */
	runToolCall(
		toolCall: AgentToolCall,
		parentToolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: (partialResult: AgentToolResult<unknown>) => Promise<void>,
	): Promise<AgentToolCallOutcome>;
	emit(event: NestedToolExecutionEvent): Promise<void>;
}

/** Calls below one model-issued call share its recorder. */
interface CallScope {
	recorder: NestedCallRecorder;
	nextId: number;
	queue: CallQueue;
	writers: readonly WriterLease[];
}

interface WriterLease {
	ancestors: readonly WriterLease[];
}

/** Only sequential calls hold global leases; parallel composites never block writer admission. */
class SequentialCallQueue {
	private readonly active = new Set<WriterLease>();
	private readonly waiting: { lease: WriterLease; admit: () => void }[] = [];

	async acquire(lease: WriterLease, signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return () => {};
		const admitted = Promise.withResolvers<void>();
		const waiter = { lease, admit: admitted.resolve };
		const onAbort = () => {
			const index = this.waiting.indexOf(waiter);
			if (index < 0) return;
			this.waiting.splice(index, 1);
			admitted.resolve();
			this.admit();
		};
		this.waiting.push(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });
		this.admit();
		try {
			await admitted.promise;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		return () => {
			this.active.delete(lease);
			this.admit();
		};
	}

	private admit(): void {
		for (let index = 0; index < this.waiting.length; ) {
			const waiter = this.waiting[index];
			if ([...this.active].every((active) => waiter.lease.ancestors.includes(active))) {
				this.waiting.splice(index, 1);
				this.active.add(waiter.lease);
				waiter.admit();
			} else {
				// A waiting unrelated writer cannot precede a descendant needed by
				// its blocking ancestor. Otherwise the first eligible writer wins.
				index++;
			}
		}
	}
}

/** Arrival-ordered shared/exclusive admission for one set of siblings. */
class CallQueue {
	private tail: Promise<void> = Promise.resolve();
	private exclusiveTail: Promise<void> = Promise.resolve();

	async acquire(exclusive: boolean, signal?: AbortSignal): Promise<() => void> {
		const previous = exclusive ? this.tail : this.exclusiveTail;
		const done = Promise.withResolvers<void>();
		// Even a cancelled waiter retains the previous barrier. Releasing its ticket
		// early must not let later calls pass an active exclusive predecessor.
		const completed = previous.then(() => done.promise);
		if (exclusive) {
			this.tail = completed;
			this.exclusiveTail = completed;
		} else {
			this.tail = Promise.all([this.tail, completed]).then(() => {});
		}

		const aborted = Promise.withResolvers<void>();
		const onAbort = () => aborted.resolve();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (!signal?.aborted) await Promise.race([previous, aborted.promise]);
			return done.resolve;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async drain(): Promise<void> {
		let tail: Promise<void>;
		do {
			tail = this.tail;
			await tail;
		} while (tail !== this.tail);
	}
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
	private readonly rootQueue = new CallQueue();
	private readonly sequentialQueue = new SequentialCallQueue();

	constructor(host: NestedToolCallHost) {
		this.host = host;
	}

	/**
	 * Run `name` on behalf of the call `callerId`. The nested call gets the id `<callerId>/<n>`.
	 * Never rejects for tool failures: they come back as `isError: true`.
	 */
	async execute(
		callerId: string,
		name: string,
		args: unknown,
		options: NestedToolCallOptions = {},
	): Promise<AgentToolCallOutcome> {
		let scope = this.scopes.get(callerId);
		if (!scope) {
			scope = { recorder: new NestedCallRecorder(), nextId: 1, queue: this.rootQueue, writers: [] };
			this.scopes.set(callerId, scope);
		}
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: `${callerId}/${scope.nextId++}`,
			name,
			arguments: (args ?? {}) as AgentToolCall["arguments"],
		};
		const record = scope.recorder.start(toolCall);
		const exclusive =
			this.host.isSequential() ||
			this.host.getTools().find((tool) => tool.name === name)?.executionMode === "sequential";
		// Reserve before the first await so a parent joins even unawaited accepted children.
		const admission = scope.queue.acquire(exclusive, options.signal);
		let release: (() => void) | undefined;
		let releaseWriter: (() => void) | undefined;
		try {
			await this.host.emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: name,
				args: toolCall.arguments,
				parentToolCallId: callerId,
			});
			release = await admission;
			const writer: WriterLease = { ancestors: scope.writers };
			// Acquire only after local admission: a writer waiting behind a parallel
			// sibling must not block that sibling's awaited sequential descendants.
			if (exclusive) releaseWriter = await this.sequentialQueue.acquire(writer, options.signal);
			let outcome: AgentToolCallOutcome;
			if (!options.signal?.aborted) {
				const children = new CallQueue();
				this.scopes.set(toolCall.id, {
					recorder: scope.recorder,
					nextId: 1,
					queue: children,
					writers: exclusive ? [...scope.writers, writer] : scope.writers,
				});
				try {
					outcome = await this.host.runToolCall(toolCall, callerId, options.signal, async (partialResult) => {
						options.onUpdate?.(partialResult);
						await this.host.emit({
							type: "tool_execution_update",
							toolCallId: toolCall.id,
							toolName: name,
							args: toolCall.arguments,
							partialResult,
							parentToolCallId: callerId,
						});
					});
				} finally {
					await children.drain();
				}
			} else {
				outcome = {
					toolCall,
					result: { content: [{ type: "text", text: "Operation aborted" }], details: {} },
					isError: true,
				};
			}

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
		} finally {
			this.scopes.delete(toolCall.id);
			releaseWriter?.();
			(release ?? (await admission))();
		}
	}

	/** Remove and return the record of the nested calls a model-issued call made. */
	takeRecord(toolCallId: string): NestedCallSummary | undefined {
		const scope = this.scopes.get(toolCallId);
		this.scopes.delete(toolCallId);
		if (!scope) return undefined;
		return { calls: scope.recorder.snapshot(), usage: scope.recorder.totalUsage };
	}

	clear(): void {
		this.scopes.clear();
	}
}
