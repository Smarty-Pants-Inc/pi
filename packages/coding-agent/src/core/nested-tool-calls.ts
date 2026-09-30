/**
 * Tool calls that a tool makes while it runs (`ctx.executeTool()`), for example from codemode
 * scripts. The agent loop does not know about them: the session runs each one through the agent's
 * tool pipeline (`runToolCall`) with its own hooks, emits `tool_execution_*` events with
 * `parentToolCallId`, and records the calls and their usage on the model-issued call's tool result
 * message.
 *
 * Fork-only: AgentSession also scopes native callbacks so accepted unawaited children join
 * before publication. Explicit effect metadata enables shared admission; undeclared parallel
 * callbacks keep legacy scheduling (#2241).
 */

import { AsyncLocalStorage } from "node:async_hooks";
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
		admittedTools: readonly AgentTool[],
	): Promise<AgentToolCallOutcome>;
	emit(event: NestedToolExecutionEvent): Promise<void>;
}

/** Calls below one model-issued call share its recorder. */
interface CallScope {
	recorder: NestedCallRecorder;
	nextId: number;
	queue: CallQueue;
	ancestors: readonly EffectLease[];
	releaseEffect?: () => void;
	accepting: boolean;
	signal?: AbortSignal;
}

interface EffectLease {
	ancestors: readonly EffectLease[];
	exclusive: boolean;
}

/** Fork-only: opt-in effect leaves share admission; undeclared/orchestration parents take only exclusive tickets. */
class EffectCallQueue {
	private readonly active = new Set<EffectLease>();
	private readonly waiting: { lease: EffectLease; admit: () => void }[] = [];

	async acquire(lease: EffectLease, signal?: AbortSignal): Promise<() => void> {
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

	private conflicts(active: EffectLease, candidate: EffectLease): boolean {
		return !candidate.ancestors.includes(active) && (active.exclusive || candidate.exclusive);
	}

	private admit(): void {
		const blocked: EffectLease[] = [];
		for (let index = 0; index < this.waiting.length; ) {
			const waiter = this.waiting[index];
			const active = [...this.active];
			if (
				active.every((lease) => !this.conflicts(lease, waiter.lease)) &&
				blocked.every(
					(earlier) =>
						(!earlier.exclusive && !waiter.lease.exclusive) ||
						// A blocked unrelated waiter cannot precede the descendant needed
						// to release its blocker. A common exclusive ancestor that already
						// admits both cousins is not itself such a blocker.
						active.some((lease) => waiter.lease.ancestors.includes(lease) && this.conflicts(lease, earlier)),
				)
			) {
				this.waiting.splice(index, 1);
				this.active.add(waiter.lease);
				waiter.admit();
			} else {
				blocked.push(waiter.lease);
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
	private readonly effectQueue = new EffectCallQueue();
	private readonly nativeCompletions = new Map<string, { signal: AbortSignal; claimed: boolean }>();
	private readonly completionOwner = new AsyncLocalStorage<{
		toolCallId: string;
		active: boolean;
		claimed: boolean;
	}>();

	/** Native events reserve completion ownership, never effect admission. This also
	 * covers SDK request hooks that replace the session's tool-context projection. */
	startParent(toolCallId: string, signal: AbortSignal): void {
		this.nativeCompletions.set(toolCallId, { signal, claimed: false });
	}

	/** Only native dispatch owns completion after the callback, through its public after-hooks. */
	runWithParentCompletion<T>(toolCallId: string, run: () => Promise<T>): Promise<T> {
		const owner = { toolCallId, active: true, claimed: false };
		return this.completionOwner.run(owner, async () => {
			try {
				return await run();
			} finally {
				// Deferred bare calls can inherit async context, but not this invocation's authority.
				owner.active = false;
			}
		});
	}

	/** Own native callbacks too. Nested calls already have a scope and admission ticket. */
	async runParent<T>(
		toolCallId: string,
		signal: AbortSignal | undefined,
		exclusive: boolean,
		executionKind: AgentTool["executionKind"],
		run: (isAccepting: () => boolean) => Promise<T>,
	): Promise<T> {
		let scope = this.scopes.get(toolCallId);
		let pipelineOwned = !!scope;
		const owner = this.completionOwner.getStore();
		if (!scope && owner?.active && !owner.claimed && owner.toolCallId === toolCallId) {
			owner.claimed = true;
			pipelineOwned = true;
		}
		const nativeCompletion = this.nativeCompletions.get(toolCallId);
		if (!scope && nativeCompletion && !nativeCompletion.claimed && nativeCompletion.signal === signal) {
			nativeCompletion.claimed = true;
			pipelineOwned = true;
		}
		if (!scope) {
			const lease: EffectLease | undefined =
				exclusive || executionKind === "effect" ? { ancestors: [], exclusive } : undefined;
			scope = {
				recorder: new NestedCallRecorder(),
				nextId: 1,
				queue: new CallQueue(),
				ancestors: lease ? [lease] : [],
				accepting: true,
				signal,
			};
			this.scopes.set(toolCallId, scope);
			if (lease) scope.releaseEffect = await this.effectQueue.acquire(lease, signal);
		}
		const owned = scope;
		try {
			signal?.throwIfAborted();
			return await run(() => owned.accepting);
		} finally {
			// Close admission before joining. Descendants keep their own live scopes.
			owned.accepting = false;
			await owned.queue.drain();
			// Native/nested pipelines release after their public after-hooks. A bare
			// registry invocation has no completion event: its callback/child join owns release.
			if (!pipelineOwned) {
				owned.releaseEffect?.();
				if (this.scopes.get(toolCallId) === owned) this.scopes.delete(toolCallId);
			}
		}
	}

	/** Native after-hooks have finished; nested calls release in execute's finally. */
	finishParent(toolCallId: string): void {
		this.nativeCompletions.delete(toolCallId);
		const scope = this.scopes.get(toolCallId);
		scope?.releaseEffect?.();
		if (scope) scope.releaseEffect = undefined;
	}

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
			scope = {
				recorder: new NestedCallRecorder(),
				nextId: 1,
				queue: this.rootQueue,
				ancestors: [],
				accepting: true,
			};
			this.scopes.set(callerId, scope);
		}
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: `${callerId}/${scope.nextId++}`,
			name,
			arguments: (args ?? {}) as AgentToolCall["arguments"],
		};
		if (!scope.accepting) {
			return {
				toolCall,
				result: { content: [{ type: "text", text: "Calling tool has retired" }], details: {} },
				isError: true,
			};
		}
		const signal = scope.signal
			? options.signal && options.signal !== scope.signal
				? AbortSignal.any([scope.signal, options.signal])
				: scope.signal
			: options.signal;
		const record = scope.recorder.start(toolCall);
		// Bind dispatch to this admitted registry snapshot. Start observers and hooks
		// may replace registrations, but cannot change this call's execution contract.
		const admittedTools = this.host.getTools().slice();
		const tool = admittedTools.find((tool) => tool.name === name);
		const exclusive = this.host.isSequential() || tool?.executionMode === "sequential";
		// Fork-only opt-in: omitted metadata preserves legacy parallel composite scheduling.
		const effectAdmission = exclusive || tool?.executionKind === "effect";
		// Reserve before the first await so a parent joins even unawaited accepted children.
		const admission = scope.queue.acquire(exclusive, signal);
		let release: (() => void) | undefined;
		let childScope: CallScope | undefined;
		try {
			await this.host.emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: name,
				args: toolCall.arguments,
				parentToolCallId: callerId,
			});
			release = await admission;
			const lease: EffectLease = { ancestors: scope.ancestors, exclusive };
			// Local admission precedes global admission so an awaiting sibling does not
			// block the descendants needed to release its local barrier.
			const releaseEffect = effectAdmission ? await this.effectQueue.acquire(lease, signal) : undefined;
			childScope = {
				recorder: scope.recorder,
				nextId: 1,
				queue: new CallQueue(),
				ancestors: effectAdmission ? [...scope.ancestors, lease] : scope.ancestors,
				releaseEffect,
				accepting: true,
				signal,
			};
			this.scopes.set(toolCall.id, childScope);
			let outcome: AgentToolCallOutcome;
			if (!signal?.aborted) {
				const children = childScope.queue;
				try {
					outcome = await this.host.runToolCall(
						toolCall,
						callerId,
						signal,
						async (partialResult) => {
							options.onUpdate?.(partialResult);
							await this.host.emit({
								type: "tool_execution_update",
								toolCallId: toolCall.id,
								toolName: name,
								args: toolCall.arguments,
								partialResult,
								parentToolCallId: callerId,
							});
						},
						admittedTools,
					);
				} finally {
					childScope.accepting = false;
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
			childScope?.releaseEffect?.();
			(release ?? (await admission))();
		}
	}

	/** Remove and return the record of the nested calls a model-issued call made. */
	takeRecord(toolCallId: string): NestedCallSummary | undefined {
		this.nativeCompletions.delete(toolCallId);
		const scope = this.scopes.get(toolCallId);
		this.scopes.delete(toolCallId);
		if (!scope) return undefined;
		scope.accepting = false;
		scope.releaseEffect?.();
		return { calls: scope.recorder.snapshot(), usage: scope.recorder.totalUsage };
	}

	clear(): void {
		this.nativeCompletions.clear();
		for (const scope of this.scopes.values()) {
			scope.accepting = false;
			scope.releaseEffect?.();
		}
		this.scopes.clear();
	}
}
