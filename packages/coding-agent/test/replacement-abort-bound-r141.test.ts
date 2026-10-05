import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

// PR #141 cut item 3: cancellation must precede the outgoing abort/idle join.
describe("session replacement observer retirement", () => {
	it("cancels held settlement dispatch before joining and replacing outgoing session", async () => {
		const cancellation = new AbortController();
		const extensions = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(() => {}, process.cwd(), createEventBus(), extensions);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const manager = SessionManager.inMemory(process.cwd());
		const runner = new ExtensionRunner(
			[extension],
			extensions,
			process.cwd(),
			manager,
			registry,
			cancellation.signal,
		);
		let release!: () => void;
		let reached!: () => void;
		const started = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let observerCancelled = false;
		extension.handlers.set("agent_settled", [
			async () => {
				reached();
				await new Promise<void>((resolve) => {
					release = resolve;
					cancellation.signal.addEventListener(
						"abort",
						() => {
							observerCancelled = true;
							resolve();
						},
						{ once: true },
					);
				});
			},
		]);
		const dispatch = runner.emit({ type: "agent_settled", outcome: "completed" });
		void dispatch.catch(() => {});
		await started;
		const disposed = vi.fn(() => runner.invalidate());
		const outgoing = {
			sessionManager: manager,
			extensionRunner: runner,
			shutdownSignal: cancellation.signal,
			abort: vi.fn(async () => {
				await dispatch.catch(() => {});
			}),
			cancelForShutdown: () => cancellation.abort(new Error("synthetic retirement")),
			dispose: disposed,
		};
		const services = { cwd: process.cwd(), agentDir: process.cwd() } as AgentSessionServices;
		const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager }) => ({
			session: { sessionManager, extensionRunner: runner } as unknown as AgentSession,
			services,
			diagnostics: [],
			extensionsResult: { extensions: [extension], errors: [], runtime: extensions },
		});
		const host = new AgentSessionRuntime(outgoing as unknown as AgentSession, services, factory);
		let completed = false;
		const replacement = host.newSession().then(() => {
			completed = true;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(completed).toBe(true);
			expect(observerCancelled).toBe(true);
			expect(disposed).toHaveBeenCalledOnce();
			expect(outgoing.abort).toHaveBeenCalledOnce();
			expect(host.session).not.toBe(outgoing);
		} finally {
			release();
			await dispatch.catch(() => {});
			await replacement;
		}
	});
});
