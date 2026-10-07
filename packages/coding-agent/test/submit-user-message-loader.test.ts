import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionContextActions } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "./utilities.ts";

const request: Parameters<ExtensionAPI["submitUserMessage"]>[0] = {
	registrationEpoch: "loader-epoch",
	requestId: "loader-request",
	sessionGeneration: "loader-generation",
	text: "must not be submitted",
	deliverAs: "followUp",
	expandPromptTemplates: false,
};

// #5533: these failure paths cannot occur in AgentSession, which always binds its ingress.
// Exercise the actual loader API and Runner.bindCore for hosts without an active session or ingress.
describe("submitUserMessage loader admission failures (#5533)", () => {
	it("returns a no_session receipt during extension loading, not a thrown action-stub error", async () => {
		let receipt: Awaited<ReturnType<ExtensionAPI["submitUserMessage"]>> | undefined;
		const loaded = await createTestExtensionsResult([
			async (pi) => {
				receipt = await pi.submitUserMessage(request);
			},
		]);
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(1);
		expect(receipt).toEqual({
			status: "rejected",
			sessionGeneration: request.sessionGeneration,
			reason: "no_session",
		});
	});

	it("returns unsupported when a custom host binds without the optional ingress action", async () => {
		let api!: ExtensionAPI;
		const loaded = await createTestExtensionsResult([
			(pi) => {
				api = pi;
			},
		]);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			process.cwd(),
			SessionManager.inMemory(),
			registry,
		);
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
		// Use the loader's real action stubs for unused methods; no successful core path is replaced.
		const { submitUserMessage: _unboundIngress, ...hostActions } = loaded.runtime;
		runner.bindCore(hostActions, contextActions);
		expect(loaded.runtime.submitUserMessage).toBeUndefined();
		await expect(api.submitUserMessage(request)).resolves.toEqual({
			status: "rejected",
			sessionGeneration: request.sessionGeneration,
			reason: "unsupported",
		});
	});
});
