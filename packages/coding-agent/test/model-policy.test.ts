import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, fauxAssistantMessage, fauxProvider, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { generateSummary } from "../src/core/compaction/compaction.ts";
import { resolveCliModel, resolveModelScope } from "../src/core/model-resolver.ts";
import { ModelPolicyError, ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createTestResourceLoader } from "./utilities.ts";

const allow = ["anthropic/claude-*-5-5", "openai/gpt-6*"];
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };

function settings(global?: string[], project?: string[]) {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify(global === undefined ? {} : { modelPolicy: { allow: global } }));
	storage.withLock("project", () => JSON.stringify(project === undefined ? {} : { modelPolicy: { allow: project } }));
	return SettingsManager.fromStorage(storage);
}

async function createRuntime(settingsManager = settings()) {
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "inert-anthropic-key" },
			openai: { type: "api_key", key: "inert-openai-key" },
		}),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		settingsManager,
	});
}

async function createFauxRuntime(settingsManager = settings()) {
	const runtime = await createRuntime(settingsManager);
	const faux = fauxProvider({ models: [{ id: "gpt-5.5" }, { id: "gpt-6" }] });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	return { runtime, faux, old: runtime.getModel("faux", "gpt-5.5")!, current: runtime.getModel("faux", "gpt-6")! };
}

// smarty-dev#12939: operator model policy is a trust boundary, not a cycling preference.
describe("modelPolicy.allow", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([
		["anthropic", "claude-haiku-4-5"],
		["openai", "gpt-5.5"],
	])("refuses native %s/%s with a typed error before auth or network", async (provider, id) => {
		const runtime = await createRuntime(settings(allow));
		const model = runtime.getModel(provider, id)!;
		expect(model).toBeDefined();
		const auth = vi.spyOn(runtime, "getAuth");
		const fetch = vi.fn(() => Promise.reject(new Error("must not fetch")));
		for (const request of [
			() => runtime.stream(model, context, { fetch }),
			() => runtime.streamSimple(model, context, { fetch }),
			() => runtime.complete(model, context, { fetch }),
			() => runtime.completeSimple(model, context, { fetch }),
		]) {
			expect(request).toThrow(ModelPolicyError);
			expect(request).toThrow(`model ${provider}/${id} is not allowed by modelPolicy.allow`);
		}
		expect(auth).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		["anthropic", "claude-sonnet-5-5", "claude-haiku-4-5"],
		["openai", "gpt-6", "gpt-5.5"],
	])("admits native %s/%s", async (provider, id, templateId) => {
		const runtime = await createRuntime(settings(allow));
		// Future allowed IDs need not be in the bundled catalog. Keep the native provider/API.
		const model: Model<Api> = { ...runtime.getModel(provider, templateId)!, id };
		const fetch = vi.fn(() => Promise.reject(new Error("inert fetch receipt")));
		const response = await runtime.completeSimple(model, context, { fetch, maxRetries: 0 });
		expect(fetch).toHaveBeenCalled();
		expect(response.errorMessage).not.toContain("modelPolicy.allow");
	});

	it("refuses model-scoped credential preparation used before auxiliary requests", async () => {
		const { runtime, old } = await createFauxRuntime(settings(["faux/gpt-6"]));
		await expect(runtime.getAuth(old)).rejects.toBeInstanceOf(ModelPolicyError);
	});

	it("rechecks the final identity after asynchronous request transforms", async () => {
		const { runtime, faux, current } = await createFauxRuntime(settings(["faux/gpt-6"]));
		const model = { ...current };
		const result = await runtime.completeSimple(model, context, {
			transformHeaders: async (headers) => {
				model.id = "gpt-5.5";
				return headers;
			},
		});
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "model faux/gpt-5.5 is not allowed by modelPolicy.allow",
		});
		expect(faux.state.callCount).toBe(0);
	});

	it("filters catalog, available snapshots, picker, cycling scope and CLI listing", async () => {
		const { runtime, old, current } = await createFauxRuntime(settings(["faux/gpt-6*"]));
		expect(runtime.getModels()).toEqual([current]);
		expect(runtime.getModelsOfType("chat")).toEqual([current]);
		expect(runtime.getAllModels()).toEqual([current]);
		expect(await runtime.getAvailable()).toEqual([current]);
		expect(await runtime.getAvailable("faux")).toEqual([current]);
		expect(await runtime.getAvailableOfType("chat")).toEqual([current]);
		expect(await runtime.getAllAvailable()).toEqual([current]);
		expect(runtime.getAvailableSnapshot()).toEqual([current]);
		expect((await resolveModelScope(["*"], runtime)).map((entry) => entry.model)).toEqual([current]);
		initTheme("dark");
		const picker = new ModelSelectorComponent(
			{ requestRender() {} } as TUI,
			undefined,
			runtime,
			[{ model: old }, { model: current }],
			() => {},
			() => {},
		);
		onTestFinished(() => picker.dispose());
		const rendered = picker.render(120).join("\n");
		expect(rendered).toContain("gpt-6");
		expect(rendered).not.toContain("gpt-5.5");
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		await listModels(runtime);
		expect(output.mock.calls.flat().join("\n")).toContain("gpt-6");
		expect(output.mock.calls.flat().join("\n")).not.toContain("gpt-5.5");
	});

	it("retains explicit CLI identities so hidden models reach typed request refusal", async () => {
		const runtime = await createRuntime(settings([]));
		const result = resolveCliModel({ cliProvider: "anthropic", cliModel: "claude-haiku-4-5", modelRuntime: runtime });
		expect(result.error).toBeUndefined();
		expect(result.model).toBe(runtime.getModel("anthropic", "claude-haiku-4-5"));
		expect(() => runtime.streamSimple(result.model!, context)).toThrow(ModelPolicyError);
	});

	it("does not change behavior when the setting is absent", async () => {
		const { runtime, faux, old } = await createFauxRuntime();
		faux.setResponses([fauxAssistantMessage("unchanged")]);
		expect(runtime.getModels("faux").map((model) => model.id)).toEqual(["gpt-5.5", "gpt-6"]);
		expect((await runtime.completeSimple(old, context)).stopReason).toBe("stop");
	});

	it("treats an empty allow list as deny-all", async () => {
		const { runtime, old } = await createFauxRuntime(settings([]));
		expect(runtime.getModels()).toEqual([]);
		expect(() => runtime.streamSimple(old, context)).toThrow(ModelPolicyError);
	});

	it("matches only full provider/model globs, case-insensitively, including slashes", async () => {
		const manager = settings(["OPENROUTER/ANTHROPIC/*5-5", "openai/gpt-6.*"]);
		const model = (provider: string, id: string) => ({ provider, id });
		expect(manager.isModelAllowed(model("openrouter", "anthropic/claude-sonnet-5-5"))).toBe(true);
		expect(manager.isModelAllowed(model("openai", "gpt-6.1"))).toBe(true);
		expect(manager.isModelAllowed(model("openai", "gpt-6x1"))).toBe(false);
		expect(manager.isModelAllowed(model("openai", "gpt-5.5"))).toBe(false);
		expect(manager.isModelAllowed(model("anthropic", "claude-sonnet-5-5"))).toBe(false);
	});

	it("intersects project and global policies instead of replacing or unioning patterns", async () => {
		const model = { provider: "faux", id: "gpt-6" };
		const manager = settings(["faux/*6*"], ["*/gpt-*"]);
		expect(manager.isModelAllowed(model)).toBe(true);
		expect(manager.isModelAllowed({ ...model, id: "gpt-5.5" })).toBe(false);
		expect(manager.isModelAllowed({ ...model, provider: "other" })).toBe(false);
		const { runtime, old, current } = await createFauxRuntime(settings(["faux/gpt-6"], ["*"]));
		expect(runtime.getModels()).toEqual([current]);
		expect(() => runtime.streamSimple(old, context)).toThrow(ModelPolicyError);
		expect(settings(undefined, ["faux/gpt-6"]).isModelAllowed(model)).toBe(true);
		expect(settings([], ["*"]).isModelAllowed(model)).toBe(false);
		expect(settings(["faux/gpt-6"]).isModelAllowed({ ...model, id: "gpt-6\n" })).toBe(false);
	});

	it("cannot widen a policy through project null, malformed values or launch overrides", () => {
		const manager = settings(["faux/gpt-6"]);
		manager.applyOverrides({ modelPolicy: { allow: ["*"] } });
		expect(manager.isModelAllowed({ provider: "faux", id: "gpt-5.5" })).toBe(false);
		for (const value of [null, {}, { allow: null }, { allow: "*" }, { allow: [42] }]) {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ modelPolicy: { allow: ["faux/gpt-6"] } }));
			storage.withLock("project", () => JSON.stringify({ modelPolicy: value }));
			const malformed = SettingsManager.fromStorage(storage);
			expect(malformed.isModelAllowed({ provider: "faux", id: "gpt-5.5" })).toBe(false);
			expect(malformed.isModelAllowed({ provider: "faux", id: "gpt-6" })).toBe(false);
		}
	});

	it("uses current settings after reload", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-model-policy-"));
		onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
		writeFileSync(join(directory, "settings.json"), JSON.stringify({ modelPolicy: { allow: ["faux/gpt-6"] } }));
		const manager = SettingsManager.create(directory, directory, { projectTrusted: false });
		const { runtime, old } = await createFauxRuntime(manager);
		expect(() => runtime.streamSimple(old, context)).toThrow(ModelPolicyError);
		writeFileSync(join(directory, "settings.json"), JSON.stringify({ modelPolicy: { allow: ["faux/*"] } }));
		await manager.reload();
		expect(runtime.getModels("faux")).toHaveLength(2);
	});

	it("binds session settings to the supplied runtime for main turns, cycling and summaries", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-model-policy-session-"));
		onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
		const { runtime, faux, old, current } = await createFauxRuntime();
		faux.setResponses([fauxAssistantMessage("should remain unused")]);
		const manager = settings(["faux/gpt-6"]);
		manager.setEnabledModels(["faux/gpt-6"]);
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			settingsManager: manager,
			sessionManager: SessionManager.inMemory(directory),
			resourceLoader: createTestResourceLoader(),
			model: old,
			tools: [],
			scopedModels: [{ model: old }, { model: current }],
		});
		onTestFinished(() => session.dispose());
		await session.prompt("hello");
		expect(session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "model faux/gpt-5.5 is not allowed by modelPolicy.allow",
		});
		expect(faux.state.callCount).toBe(0);
		await expect(
			generateSummary(
				context.messages,
				old,
				1000,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				session.agent.streamFunction,
			),
		).rejects.toBeInstanceOf(ModelPolicyError);
		expect(faux.state.callCount).toBe(0);
		await session.setModel(current);
		expect(await session.cycleModel()).toBeUndefined();
		session.setScopedModels([{ model: current }]);
		await session.setModel(old, { persist: true });
		expect(manager.getEnabledModels()).toContain("faux/gpt-5.5");
		await manager.flush();
		expect(manager.getGlobalSettings().modelPolicy).toEqual({ allow: ["faux/gpt-6"] });
	});

	it("refuses a disallowed virtual selection even if its target is allowed", async () => {
		const { runtime, current } = await createFauxRuntime(settings(["faux/gpt-6"]));
		const route = vi.fn(() => ({ model: current, thinkingLevel: "off" as const }));
		runtime.registerVirtualModel({ provider: "router", id: "auto", name: "Auto", route });
		const virtual = runtime.getModel("router", "auto")!;
		expect(() => runtime.streamSimple(virtual, context)).toThrow(ModelPolicyError);
		await expect(runtime.resolveModel(virtual, [], { reason: "user", thinkingLevel: "off" })).rejects.toBeInstanceOf(
			ModelPolicyError,
		);
		expect(route).not.toHaveBeenCalled();
	});

	it("refuses disallowed deferred handles even when the caller supplies an allowed model", async () => {
		const { runtime, faux, current, old } = await createFauxRuntime(settings(["faux/gpt-6"]));
		const handle = { provider: old.provider, modelId: old.id, api: old.api, id: "inert" };
		expect(() => runtime.streamDeferred(current, handle)).toThrow(ModelPolicyError);
		await expect(runtime.cancelDeferred(current, handle)).rejects.toBeInstanceOf(ModelPolicyError);
		expect(faux.state.deferredFetchCount).toBe(0);
		expect(faux.state.cancelledDeferred).toEqual([]);
	});

	it("checks the physical target of a virtual route", async () => {
		const { runtime, faux, old } = await createFauxRuntime(settings(["router/*", "faux/gpt-6"]));
		runtime.registerVirtualModel({
			provider: "router",
			id: "auto",
			name: "Auto",
			route: () => ({ model: old, thinkingLevel: "off" }),
		});
		const result = await runtime.completeSimple(runtime.getModel("router", "auto")!, context);
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "model faux/gpt-5.5 is not allowed by modelPolicy.allow",
		});
		expect(faux.state.callCount).toBe(0);
	});

	it("enforces non-chat and deferred operations before error conversion", async () => {
		const runtime = await createRuntime();
		const all = runtime.getAllModels();
		runtime.addModelPolicy(settings([]));
		const native = runtime.getModel("openai", "gpt-5.5")!;
		const handle = { id: "inert", provider: native.provider, api: native.api, modelId: native.id };
		expect(() => runtime.streamDeferred(native, handle)).toThrow(ModelPolicyError);
		await expect(runtime.cancelDeferred(native, handle)).rejects.toBeInstanceOf(ModelPolicyError);
		// Lookups are deliberately not listing filters: explicit requests must get a policy refusal.
		expect(all.some((model) => model.type === "image")).toBe(true);
		expect(all.some((model) => model.type === "classifier")).toBe(true);
		for (const model of all) {
			if (model.type === "image")
				await expect(
					runtime.generateImages(model, { input: [{ type: "text", text: "inert" }] }),
				).rejects.toBeInstanceOf(ModelPolicyError);
			if (model.type === "classifier")
				await expect(runtime.classify(model, { state: {}, questions: {} })).rejects.toBeInstanceOf(
					ModelPolicyError,
				);
		}
	});
});
