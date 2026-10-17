import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

// Inherited shared-review P2: failed bootstrap must release only its own policy lease.
// Keep reason: construction failure and shared-owner identity are hard to reach in a user flow.
describe.each(["SDK", "services"] as const)("%s model-policy bootstrap leases", (entryPoint) => {
	let harness: Harness;
	let bootstrapSettings: SettingsManager;
	let releaseUnrelatedOwner: () => void;
	const sessions: AgentSession[] = [];
	const policyCleanups: Array<() => void> = [];

	beforeEach(async () => {
		harness = await createHarness({
			models: [{ id: "selected" }, { id: "bootstrap-blocked" }, { id: "unrelated-blocked" }],
			settings: { defaultTools: [] },
		});
		const selected = harness.getModel("selected")!;
		bootstrapSettings = SettingsManager.inMemory({
			defaultTools: [],
			modelPolicy: { allow: [`${selected.provider}/selected`, `${selected.provider}/unrelated-blocked`] },
		});
		const unrelatedSettings = SettingsManager.inMemory({
			modelPolicy: { allow: [`${selected.provider}/selected`, `${selected.provider}/bootstrap-blocked`] },
		});
		releaseUnrelatedOwner = harness.modelRuntime.addModelPolicy(unrelatedSettings);
		policyCleanups.push(releaseUnrelatedOwner);

		if (entryPoint === "services") {
			// Isolate resource discovery, not model-policy admission or cleanup.
			vi.spyOn(DefaultResourceLoader.prototype, "reload").mockImplementation(async () => {
				expect(harness.modelRuntime.isModelAllowed(harness.getModel("bootstrap-blocked")!)).toBe(false);
			});
		}
	});

	afterEach(async () => {
		try {
			for (const session of sessions) session.dispose();
		} finally {
			sessions.length = 0;
			for (const cleanup of policyCleanups) cleanup();
			policyCleanups.length = 0;
			vi.restoreAllMocks();
			await harness?.cleanup();
		}
	});

	it("rolls back a failed bootstrap without releasing a shared settings registration or unrelated owner", async () => {
		const { modelRuntime } = harness;
		const selected = harness.getModel("selected")!;
		const bootstrapBlocked = harness.getModel("bootstrap-blocked")!;
		const unrelatedBlocked = harness.getModel("unrelated-blocked")!;
		expect(modelRuntime.isModelAllowed(selected)).toBe(true);
		expect(modelRuntime.isModelAllowed(bootstrapBlocked)).toBe(true);
		expect(modelRuntime.isModelAllowed(unrelatedBlocked)).toBe(false);

		// The same SettingsManager already has a separate owner; rollback must decrement, not erase it.
		const releaseExistingOwner = modelRuntime.addModelPolicy(bootstrapSettings);
		policyCleanups.push(releaseExistingOwner);
		if (entryPoint === "SDK") {
			await expect(
				createAgentSession({
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					modelRuntime,
					model: selected,
					settingsManager: bootstrapSettings,
					sessionManager: SessionManager.inMemory(harness.tempDir),
					resourceLoader: harness.resourceLoader,
					tools: ["+read", "write"],
				}),
			).rejects.toThrow("Invalid tools option:");
		} else {
			const failure = new Error("resource reload failed after policy registration");
			vi.mocked(DefaultResourceLoader.prototype.reload).mockImplementationOnce(async () => {
				expect(modelRuntime.isModelAllowed(bootstrapBlocked)).toBe(false);
				throw failure;
			});
			await expect(
				createAgentSessionServices({
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					modelRuntime,
					settingsManager: bootstrapSettings,
				}),
			).rejects.toBe(failure);
		}

		expect(modelRuntime.isModelAllowed(bootstrapBlocked)).toBe(false);
		expect(modelRuntime.isModelAllowed(unrelatedBlocked)).toBe(false);
		releaseExistingOwner();
		// A leaked bootstrap lease would keep blocking this model after its other owner leaves.
		expect(modelRuntime.isModelAllowed(bootstrapBlocked)).toBe(true);
		expect(modelRuntime.isModelAllowed(unrelatedBlocked)).toBe(false);
		expect(modelRuntime.isModelAllowed(selected)).toBe(true);
		releaseUnrelatedOwner();
		expect(modelRuntime.isModelAllowed(unrelatedBlocked)).toBe(true);
	});

	it("retains successful leases until their own sessions are disposed, even with a shared session ID", async () => {
		const { modelRuntime } = harness;
		const selected = harness.getModel("selected")!;
		const bootstrapBlocked = harness.getModel("bootstrap-blocked")!;
		const unrelatedBlocked = harness.getModel("unrelated-blocked")!;
		const sessionManager = SessionManager.inMemory(harness.tempDir);
		expect(modelRuntime.isModelAllowed(bootstrapBlocked)).toBe(true);

		const construct = async () => {
			if (entryPoint === "SDK") {
				return createAgentSession({
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					modelRuntime,
					model: selected,
					settingsManager: bootstrapSettings,
					sessionManager,
					resourceLoader: harness.resourceLoader,
					tools: [],
				});
			}
			const services = await createAgentSessionServices({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime,
				settingsManager: bootstrapSettings,
			});
			// Services own a lease before a receiving session has been created.
			expect(modelRuntime.isModelAllowed(bootstrapBlocked)).toBe(false);
			return createAgentSessionFromServices({ services, sessionManager, model: selected, tools: [] });
		};

		const first = (await construct()).session;
		sessions.push(first);
		expect(modelRuntime.isModelAllowed(bootstrapBlocked)).toBe(false);
		expect(modelRuntime.isModelAllowed(unrelatedBlocked)).toBe(false);
		const second = (await construct()).session;
		sessions.push(second);
		expect(first.sessionId).toBe(second.sessionId);

		first.dispose();
		expect(first.isDisposed).toBe(true);
		expect(second.isDisposed).toBe(false);
		expect(modelRuntime.isModelAllowed(bootstrapBlocked)).toBe(false);
		expect(modelRuntime.isModelAllowed(unrelatedBlocked)).toBe(false);

		second.dispose();
		expect(modelRuntime.isModelAllowed(bootstrapBlocked)).toBe(true);
		expect(modelRuntime.isModelAllowed(unrelatedBlocked)).toBe(false);
		expect(modelRuntime.isModelAllowed(selected)).toBe(true);
		releaseUnrelatedOwner();
		expect(modelRuntime.isModelAllowed(unrelatedBlocked)).toBe(true);
	});
});
