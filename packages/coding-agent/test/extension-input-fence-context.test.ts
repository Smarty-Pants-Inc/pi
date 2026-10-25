import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionInputFence,
	ExtensionInputState,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	ExtensionInputFence as PublicExtensionInputFence,
	ExtensionInputState as PublicExtensionInputState,
} from "../src/index.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const actions: ExtensionActions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	getSettings: () => ({}),
	setActiveTools: () => {},
	refreshTools: () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: () => {},
};

// Deliberately omit the optional fence hooks, as custom hosts and other modes may do.
const contextActions: ExtensionContextActions = {
	getModel: () => undefined,
	getScopedModels: () => [],
	isIdle: () => true,
	isSettling: () => false,
	isProjectTrusted: () => true,
	getSignal: () => undefined,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: () => {},
	getSystemPrompt: () => "",
};

async function makeRunner() {
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	return new ExtensionRunner([], createExtensionRuntime(), process.cwd(), SessionManager.inMemory(), registry);
}

// smarty-dev#15310: keep these focused runner tests for the unsupported-host failure boundary
// and compile-time contract. Session-backed behavior is covered in suite/extension-input-fence.test.ts.
describe("extension input fence context contract (#15310)", () => {
	it("exports a zero-option acquisition API and readonly native state (spec 1/9)", () => {
		expectTypeOf<ExtensionContext["fenceInputs"]>().parameters.toEqualTypeOf<[]>();
		expectTypeOf<ExtensionContext["fenceInputs"]>().returns.toEqualTypeOf<Promise<ExtensionInputFence>>();
		expectTypeOf<ExtensionContext["getInputState"]>().parameters.toEqualTypeOf<[]>();
		expectTypeOf<ExtensionContext["getInputState"]>().returns.toEqualTypeOf<ExtensionInputState>();
		expectTypeOf<ExtensionInputFence>().toEqualTypeOf<PublicExtensionInputFence>();
		expectTypeOf<ExtensionInputState>().toEqualTypeOf<PublicExtensionInputState>();
		expectTypeOf<ExtensionContextActions["fenceInputs"]>().toEqualTypeOf<
			(() => Promise<ExtensionInputFence>) | undefined
		>();
		expectTypeOf<ExtensionContextActions["getInputState"]>().toEqualTypeOf<(() => ExtensionInputState) | undefined>();
		const checkInvalidCalls = (ctx: ExtensionContext, state: ExtensionInputState) => {
			// @ts-expect-error The extension API must not expose native queue rejection options.
			void ctx.fenceInputs({ rejectQueuedInput: () => {} });
			// @ts-expect-error Native input snapshots are readonly at the TypeScript boundary.
			state.inputsFenced = false;
			// @ts-expect-error Native input snapshots are readonly at the TypeScript boundary.
			state.inputAdmissionCount = 0;
			// @ts-expect-error Native input snapshots are readonly at the TypeScript boundary.
			state.queued = 0;
			// @ts-expect-error Native input snapshots are readonly at the TypeScript boundary.
			state.drained = true;
		};
		// Compile the invalid calls, never execute them.
		void checkInvalidCalls;
	});

	it.each(["unbound", "bound-without-hooks"] as const)("fails closed for an %s host", async (host) => {
		const runner = await makeRunner();
		if (host === "bound-without-hooks") runner.bindCore(actions, contextActions);
		const ctx = runner.createContext();
		await expect(Promise.resolve().then(() => ctx.fenceInputs())).rejects.toThrow(/not available|unavailable/i);
		expect(() => ctx.getInputState()).toThrow(/not available|unavailable/i);
	});

	it.each(["fenceInputs", "getInputState"] as const)("fails closed when only %s is bound", async (hook) => {
		const runner = await makeRunner();
		const release = vi.fn();
		const state: ExtensionInputState = { inputsFenced: true, inputAdmissionCount: 0, queued: 0, drained: true };
		runner.bindCore(actions, {
			...contextActions,
			...(hook === "fenceInputs" ? { fenceInputs: async () => ({ release }) } : { getInputState: () => state }),
		});
		const ctx = runner.createContext();
		if (hook === "fenceInputs") {
			expect(() => ctx.getInputState()).toThrow(/not available|unavailable/i);
			(await ctx.fenceInputs()).release();
			expect(release).toHaveBeenCalledOnce();
		} else {
			await expect(Promise.resolve().then(() => ctx.fenceInputs())).rejects.toThrow(/not available|unavailable/i);
			expect(ctx.getInputState()).toEqual(state);
		}
	});

	it("resolves hooks and state at call time and fails closed if a rebind removes support", async () => {
		const runner = await makeRunner();
		const ctx = runner.createCommandContext();
		let state: ExtensionInputState = { inputsFenced: false, inputAdmissionCount: 0, queued: 0, drained: true };
		const acquire = vi.fn(async () => ({ release: () => {} }));
		runner.bindCore(actions, { ...contextActions, fenceInputs: acquire, getInputState: () => state });
		expect(ctx.getInputState()).toEqual(state);
		state = { inputsFenced: false, inputAdmissionCount: 1, queued: 2, drained: false };
		expect(ctx.getInputState()).toEqual(state);
		const withExtraArgument = ctx.fenceInputs as (extra: unknown) => Promise<ExtensionInputFence>;
		await withExtraArgument({ rejectQueuedInput: () => {} });
		expect(acquire).toHaveBeenCalledExactlyOnceWith();
		runner.bindCore(actions, contextActions);
		await expect(Promise.resolve().then(() => ctx.fenceInputs())).rejects.toThrow(/not available|unavailable/i);
		expect(() => ctx.getInputState()).toThrow(/not available|unavailable/i);
	});

	it.each(["context", "command", "tool"] as const)(
		"guards both methods on an invalidated %s context (spec 11)",
		async (kind) => {
			const runner = await makeRunner();
			const acquire = vi.fn(async () => ({ release: () => {} }));
			const getState = vi.fn(() => ({ inputsFenced: false, inputAdmissionCount: 0, queued: 0, drained: true }));
			runner.bindCore(actions, { ...contextActions, fenceInputs: acquire, getInputState: getState });
			const ctx =
				kind === "context"
					? runner.createContext()
					: kind === "command"
						? runner.createCommandContext()
						: runner.createToolContext("fence-test-parent", undefined);
			runner.invalidate();
			expect(() => ctx.getInputState()).toThrow(/extension ctx is stale/);
			await expect(Promise.resolve().then(() => ctx.fenceInputs())).rejects.toThrow(/extension ctx is stale/);
			expect(acquire).not.toHaveBeenCalled();
			expect(getState).not.toHaveBeenCalled();
		},
	);
});
