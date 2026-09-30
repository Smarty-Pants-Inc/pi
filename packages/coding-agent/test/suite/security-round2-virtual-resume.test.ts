import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ModelRouteRequest } from "../../src/core/virtual-models.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const resumedSessions: AgentSession[] = [];

afterEach(() => {
	for (const session of resumedSessions.splice(0)) session.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function freshRuntime(faux: FauxProviderRegistration) {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const model = faux.getModel();
	runtime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models,
	});
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

describe("SDK resource-loader virtual selection bootstrap", () => {
	// #2241 Astra8: no manual virtual preregistration; reopen the persisted public path with a fresh runtime.
	it("preserves the saved virtual selection after a physical response and routes the next prompt", async () => {
		const requests: ModelRouteRequest[] = [];
		const router: ExtensionFactory = (pi) => {
			pi.registerVirtualModel({
				provider: "router",
				id: "auto",
				name: "Auto",
				contextWindow: 50_000,
				route(request, ctx) {
					requests.push(request);
					return {
						model: ctx.modelRegistry.find("faux", requests.length === 1 ? "large" : "small")!,
						thinkingLevel: "off",
					};
				},
			});
		};
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "large" }, { id: "small" }],
			extensionFactories: [router],
			tools: [],
		});
		harnesses.push(harness);
		harness.session.agent.streamFunction = (model, context, options) =>
			harness.session.modelRuntime.streamSimple(model, context, options);
		await harness.session.setModel(harness.session.modelRuntime.getModel("router", "auto")!);
		harness.setResponses([fauxAssistantMessage("saved physical response")]);
		await harness.session.prompt("first turn");
		const sessionFile = harness.session.sessionFile!;
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", provider: "faux", model: "large" });
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "model_change" && entry.provider === "router"),
		).toBe(true);
		harness.session.dispose();

		const runtime = await freshRuntime(harness.faux);
		const settingsManager = SettingsManager.inMemory({});
		const loader = new DefaultResourceLoader({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			settingsManager,
			extensionFactories: [router],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().runtime.pendingVirtualModelRegistrations).toHaveLength(1);
		expect(runtime.getModel("router", "auto")).toBeUndefined();
		const result = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: runtime,
			settingsManager,
			resourceLoader: loader,
			sessionManager: SessionManager.open(sessionFile),
			tools: [],
		});
		resumedSessions.push(result.session);
		const restoredSelection = result.session.model;
		harness.setResponses([fauxAssistantMessage("routed resumed response")]);
		await result.session.prompt("resumed turn");

		// Probe the effect before checking selection: the original code silently sends large instead of small.
		expect(result.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			provider: "faux",
			model: "small",
			stopReason: "stop",
		});
		expect(restoredSelection).toMatchObject({ provider: "router", id: "auto" });
		expect(result.session.model).toMatchObject({ provider: "router", id: "auto" });
		expect(result.modelFallbackMessage).toBeUndefined();
		expect(requests.map((request) => request.reason)).toEqual(["user", "user"]);
		expect(requests[1].previous?.model.id).toBe("large");
		expect(harness.faux.state.callCount).toBe(2);
		expect(result.extensionsResult.runtime.pendingVirtualModelRegistrations).toEqual([]);
		expect(result.session.getAllTools().map((tool) => tool.name)).not.toContain("codemode");
	});

	// #2241 Astra8 counterexamples: keep physical restoration and warning behavior when no router can be restored.
	it.each(["physical", "missing", "removed-router"] as const)(
		"preserves restoration/fallback semantics (%s)",
		async (selection) => {
			const harness = await createHarness({ persistSession: true, tools: [] });
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("physical response")]);
			await harness.session.prompt("first");
			if (selection === "missing") harness.sessionManager.appendModelChange("missing", "unavailable");
			if (selection === "removed-router") {
				// An absent router still yields to a later physical response, without a new fallback warning.
				const manager = harness.sessionManager;
				const response = harness.session.messages.at(-1);
				if (response?.role !== "assistant") throw new Error("Missing physical response");
				manager.appendModelChange("router", "removed");
				manager.appendMessage(response);
			}
			const runtime = await freshRuntime(harness.faux);
			const result = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: runtime,
				settingsManager: SettingsManager.inMemory({}),
				resourceLoader: new DefaultResourceLoader({ cwd: harness.tempDir, agentDir: harness.tempDir }),
				sessionManager: SessionManager.open(harness.session.sessionFile!),
				tools: [],
			});
			resumedSessions.push(result.session);
			expect(result.session.model).toMatchObject({ provider: "faux", id: harness.getModel().id });
			expect(result.modelFallbackMessage).toBe(
				selection === "missing"
					? `Could not restore model missing/unavailable. Using faux/${harness.getModel().id}`
					: undefined,
			);
		},
	);
});
