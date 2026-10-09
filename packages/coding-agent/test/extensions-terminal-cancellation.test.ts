import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionEvent } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const user = { role: "user", content: "original", timestamp: 0 } as const;
const cases: Array<{ event: ExtensionEvent["type"]; invoke: (runner: ExtensionRunner) => Promise<unknown> }> = [
	{
		event: "provider_stream_event",
		invoke: (runner) =>
			runner.emit({
				type: "provider_stream_event",
				data: {},
				provider: "offline",
				api: "openai-completions",
				model: "offline",
			}),
	},
	{
		event: "after_provider_response",
		invoke: (runner) => runner.emit({ type: "after_provider_response", status: 200, headers: {} }),
	},
	{ event: "agent_start", invoke: (runner) => runner.emit({ type: "agent_start" }) },
	{
		event: "agent_settled",
		invoke: (runner) => runner.emit({ type: "agent_settled", outcome: "completed", aborted: false }),
	},
	{
		event: "session_before_switch",
		invoke: (runner) => runner.emit({ type: "session_before_switch", reason: "new" }),
	},
	{
		event: "cache_warming_decision",
		invoke: (runner) =>
			runner.emitCacheWarmingDecision({
				type: "cache_warming_decision",
				action: "warm",
				warmCost: 0,
				missCost: 0,
				continuationProbability: 1,
			}),
	},
	{ event: "message_end", invoke: (runner) => runner.emitMessageEnd({ type: "message_end", message: { ...user } }) },
	{
		event: "tool_call",
		invoke: (runner) =>
			runner.emitToolCall({ type: "tool_call", toolName: "probe", toolCallId: "probe-1", input: {} }),
	},
	{
		event: "tool_result",
		invoke: (runner) =>
			runner.emitToolResult({
				type: "tool_result",
				toolName: "probe",
				toolCallId: "probe-1",
				input: {},
				content: [],
				details: {},
				isError: false,
			}),
	},
	{
		event: "user_bash",
		invoke: (runner) =>
			runner.emitUserBash({ type: "user_bash", command: "offline", excludeFromContext: false, cwd: process.cwd() }),
	},
	{ event: "context", invoke: (runner) => runner.emitContext([{ ...user }]) },
	{ event: "context_with_system", invoke: (runner) => runner.emitContext([{ ...user }]) },
	{ event: "before_provider_request", invoke: (runner) => runner.emitBeforeProviderRequest({ original: true }) },
	{ event: "before_provider_headers", invoke: (runner) => runner.emitBeforeProviderHeaders({ original: "yes" }) },
	{
		event: "before_agent_start",
		invoke: (runner) => runner.emitBeforeAgentStart("original", undefined, { cwd: process.cwd() }),
	},
	{ event: "resources_discover", invoke: (runner) => runner.emitResourcesDiscover(process.cwd(), "startup") },
	...(["turn_end", "agent_before_settle"] as const).map((event) => ({
		event,
		invoke: (runner: ExtensionRunner) =>
			runner.emitBoundary(
				event === "turn_end"
					? {
							type: event,
							outcome: "completed",
							turnIndex: 0,
							message: { ...user },
							toolResults: [],
							messageEntryId: "user",
							toolResultEntryIds: [],
						}
					: { type: event, outcome: "completed" },
				() => ({
					contextEntries: [],
					contextMessages: [],
					llmMessages: [],
					pendingMessages: [],
					canContinue: false,
				}),
			),
	})),
	{ event: "input", invoke: (runner) => runner.emitInput("original", undefined, "rpc") },
];

// smarty-dev#3048 / PR #110: cover the whole runner boundary, including abandoned settlement.
describe("terminal extension dispatch cancellation", () => {
	it.each(cases)(
		"$event releases its waiter, skips remaining handlers and discards late results",
		async ({ event, invoke }) => {
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(() => {}, process.cwd(), createEventBus(), runtime);
			const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
			const cancellation = new AbortController();
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				process.cwd(),
				SessionManager.inMemory(),
				registry,
				cancellation.signal,
			);
			let release!: (value: unknown) => void;
			let rejectLate!: (error: unknown) => void;
			const held = new Promise<unknown>((resolve) => {
				release = resolve;
			});
			const first = vi.fn(async () => held);
			const next = vi.fn(async () => undefined);
			const laterExtension = await loadExtensionFromFactory(
				() => {},
				process.cwd(),
				createEventBus(),
				runtime,
				"<later>",
			);
			laterExtension.handlers.set(event, [next]);
			// Also test the next extension's handler, not just handlers in one extension.
			const withLater = new ExtensionRunner(
				[extension, laterExtension],
				runtime,
				process.cwd(),
				SessionManager.inMemory(),
				registry,
				cancellation.signal,
			);
			extension.handlers.set(event, [first, next]);
			const errors = vi.fn();
			withLater.onError(errors);
			const reason = new Error("terminal cancellation");
			try {
				const operation = invoke(withLater);
				await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
				cancellation.abort(reason);
				await expect(operation).rejects.toBe(reason);
				const late = {
					messages: [{ ...user, content: "late" }],
					message: { ...user, content: "late" },
					payload: "late",
					action: "transform",
					text: "late",
					content: [{ type: "text", text: "late" }],
					continue: true,
					entries: [],
					skillPaths: ["late"],
					block: true,
					cancel: true,
				};
				release(late);
				await held;
				// Allow the original abandoned handler chain to finish if it survived cancellation.
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(next).not.toHaveBeenCalled();
				expect(errors).not.toHaveBeenCalled();
				await expect(invoke(runner)).rejects.toBe(reason);
				expect(first).toHaveBeenCalledOnce();
				// A late rejection must be observed too, even for fire-and-forget generic emit.
				const rejected = new Promise<unknown>((_resolve, reject) => {
					rejectLate = reject;
				});
				const other = new AbortController();
				const otherRunner = new ExtensionRunner(
					[extension],
					runtime,
					process.cwd(),
					SessionManager.inMemory(),
					registry,
					other.signal,
				);
				const rejecting = vi.fn(async () => rejected);
				extension.handlers.set(event, [rejecting, next]);
				const abandoned = invoke(otherRunner);
				await vi.waitFor(() => expect(rejecting).toHaveBeenCalledOnce());
				other.abort(reason);
				await expect(abandoned).rejects.toBe(reason);
				rejectLate(new Error("late rejection"));
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(next).not.toHaveBeenCalled();
			} finally {
				release(undefined);
			}
		},
	);

	// smarty-dev#3048: cancellation may arrive after the helper settles but before the emitter applies a result.
	it("drops a resolved payload when shutdown precedes the emitter continuation", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(() => {}, process.cwd(), createEventBus(), runtime);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const cancellation = new AbortController();
		const reason = new Error("terminal cancellation");
		const next = vi.fn(async () => undefined);
		extension.handlers.set("before_provider_request", [
			async () => {
				const result = Promise.resolve({ late: true });
				void result.then(() => queueMicrotask(() => queueMicrotask(() => cancellation.abort(reason))));
				return result;
			},
			next,
		]);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			registry,
			cancellation.signal,
		);
		await expect(runner.emitBeforeProviderRequest({ original: true })).rejects.toBe(reason);
		expect(next).not.toHaveBeenCalled();
	});
	it("preserves the separately bounded shutdown cleanup after terminal cancellation", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(() => {}, process.cwd(), createEventBus(), runtime);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const cancellation = new AbortController();
		const cleanup = vi.fn(async () => undefined);
		extension.handlers.set("session_shutdown", [cleanup, cleanup]);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			registry,
			cancellation.signal,
		);
		cancellation.abort(new Error("terminal cancellation"));
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		expect(cleanup).toHaveBeenCalledTimes(2);
	});
});
