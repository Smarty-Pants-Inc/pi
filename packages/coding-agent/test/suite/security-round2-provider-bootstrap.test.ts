import type { Provider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { bootstrapExtensionModels, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { type ExtensionFactory, ExtensionRunner } from "../../src/core/extensions/index.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import * as ownership from "../../src/core/ordinary-owner-context.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ModelRouteRequest } from "../../src/core/virtual-models.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const sessions: AgentSession[] = [];

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const resourceOptions = {
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
};

async function freshRuntime(harness: Harness) {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const model = harness.getModel();
	runtime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: harness.faux.api,
		apiKey: "faux-key",
		models: harness.faux.models,
	});
	await runtime.refresh({ allowNetwork: false });
	expect(runtime.getProvider("openai")?.getModels().length).toBeGreaterThan(0);
	expect(runtime.hasConfiguredAuth("openai")).toBe(false);
	expect(runtime.hasConfiguredAuth("faux")).toBe(true);
	return runtime;
}

async function load(harness: Harness, extension: ExtensionFactory) {
	const settingsManager = SettingsManager.inMemory({});
	const loader = new DefaultResourceLoader({
		...resourceOptions,
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		settingsManager,
		extensionFactories: [extension],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	return { loader, settingsManager };
}

describe("SDK dependency-complete model bootstrap", () => {
	// #2241: early bootstrap must retain runner precedence for an explicit pre-registration snapshot.
	it.each(["provider", "native"] as const)(
		"refreshes an explicit registered model after successful %s override and sends the new URL",
		async (kind) => {
			const harness = await createHarness({ tools: [] });
			harnesses.push(harness);
			const runtime = harness.session.modelRuntime;
			const snapshot = runtime.getModel("faux", harness.getModel().id)!;
			const baseUrl = `http://localhost:8080/${kind}-override`;
			const faux = fauxProvider({ api: snapshot.api, provider: snapshot.provider, models: [{ id: snapshot.id }] });
			const stream = vi.fn(faux.provider.streamSimple);
			const { loader, settingsManager } = await load(harness, (pi) => {
				if (kind === "provider") {
					pi.registerProvider(snapshot.provider, {
						baseUrl,
						api: faux.api,
						models: [{ ...snapshot, baseUrl: undefined }],
						streamSimple: stream,
					});
				} else {
					pi.registerProvider({
						...faux.provider,
						baseUrl,
						getModels: () => faux.models.map((model) => ({ ...model, baseUrl })),
						streamSimple: stream,
					});
				}
			});
			const { session } = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				model: snapshot,
				modelRuntime: runtime,
				resourceLoader: loader,
				settingsManager,
				sessionManager: SessionManager.inMemory(harness.tempDir),
				tools: [],
			});
			sessions.push(session);
			const immediateModel = session.model;
			faux.setResponses([fauxAssistantMessage("overridden faux request")]);
			await session.prompt("hello");
			expect(stream).toHaveBeenCalledTimes(1);
			expect(stream.mock.calls[0][0]).toMatchObject({ provider: snapshot.provider, id: snapshot.id, baseUrl });
			expect(session.messages.at(-1)).toMatchObject({ provider: "faux", model: snapshot.id, stopReason: "stop" });
			expect(immediateModel?.baseUrl).toBe(baseUrl);
			expect(snapshot.baseUrl).not.toBe(baseUrl);
			expect(loader.getExtensions().runtime.pendingProviderRegistrations).toEqual([]);
			expect(loader.getExtensions().runtime.pendingNativeProviderRegistrations).toEqual([]);
		},
	);

	// #2241: no registration, unrelated success, and same-provider failure cannot normalize a custom model.
	it.each(["none", "unrelated", "failed"] as const)(
		"preserves a custom explicit URL with %s provider registration",
		async (kind) => {
			const harness = await createHarness({ tools: [] });
			harnesses.push(harness);
			const runtime = harness.session.modelRuntime;
			const model = { ...runtime.getModel("faux", harness.getModel().id)!, baseUrl: "http://localhost:8080/custom" };
			const oldConfig = runtime.getRegisteredProviderConfig(model.provider);
			const { loader, settingsManager } = await load(harness, (pi) => {
				if (kind === "unrelated") pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/unrelated" });
				if (kind === "failed") {
					pi.registerProvider(model.provider, {
						baseUrl: "http://localhost:8080/rejected",
						streamSimple: fauxProvider().provider.streamSimple,
					});
				}
			});
			if (kind === "failed") {
				const installedProviderIds = await bootstrapExtensionModels(runtime, loader);
				expect([...installedProviderIds]).toEqual([]);
				expect(loader.getExtensions().runtime.pendingProviderRegistrations).toHaveLength(1);
			}
			const emitted = vi.spyOn(ExtensionRunner.prototype, "emitError");
			const { session } = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				model,
				modelRuntime: runtime,
				resourceLoader: loader,
				settingsManager,
				sessionManager: SessionManager.inMemory(harness.tempDir),
				tools: [],
			});
			sessions.push(session);
			expect(session.model).toBe(model);
			let requestUrl: string | undefined;
			harness.setResponses([
				(_context, _options, _state, requestModel) => {
					requestUrl = requestModel.baseUrl;
					return fauxAssistantMessage("custom faux request");
				},
			]);
			await session.prompt("hello");
			expect(requestUrl).toBe(model.baseUrl);
			expect(session.messages.at(-1)).toMatchObject({ provider: "faux", model: model.id, stopReason: "stop" });
			expect(runtime.getRegisteredProviderConfig(model.provider)).toBe(oldConfig);
			if (kind === "failed") {
				expect(emitted).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({
						event: "register_provider",
						extensionPath: "<inline:1>",
					}),
				);
			} else expect(emitted).not.toHaveBeenCalled();
		},
	);

	// #2241 Astra8: existing physical OpenAI is initially unauthenticated, not a virtual-only provider.
	it.each(["provider", "native"] as const)(
		"restores openai/auto before the first resumed prompt with a queued %s prerequisite",
		async (kind) => {
			vi.stubEnv("PI_TEST_BOOTSTRAP_KEY", "fake-reference-value");
			vi.stubEnv("OPENAI_API_KEY", "");
			const native = fauxProvider({ provider: "openai", models: [{ id: "native-routed" }] });
			const requests: ModelRouteRequest[] = [];
			const extension: ExtensionFactory = (pi) => {
				if (kind === "provider") pi.registerProvider("openai", { apiKey: "$PI_TEST_BOOTSTRAP_KEY" });
				else pi.registerProvider(native.provider);
				pi.registerVirtualModel({
					provider: "openai",
					id: "auto",
					name: "Auto",
					contextWindow: 50_000,
					route(request, ctx) {
						requests.push(request);
						const target =
							requests.length === 1
								? ctx.modelRegistry.find("faux", "fallback")
								: kind === "native"
									? ctx.modelRegistry.find("openai", "native-routed")
									: ctx.modelRegistry.find("faux", "routed");
						if (!target) throw new Error("Missing faux route target");
						return { model: target, thinkingLevel: "off" };
					},
				});
			};
			const harness = await createHarness({
				persistSession: true,
				models: [{ id: "fallback" }, { id: "routed" }],
				extensionFactories: [extension],
				tools: [],
			});
			harnesses.push(harness);
			await harness.session.modelRuntime.refresh({ allowNetwork: false });
			harness.session.agent.streamFunction = (model, context, options) =>
				harness.session.modelRuntime.streamSimple(model, context, options);
			await harness.session.setModel(harness.session.modelRuntime.getModel("openai", "auto")!);
			harness.setResponses([fauxAssistantMessage("saved fallback response")]);
			await harness.session.prompt("first");
			expect(harness.session.messages.at(-1)).toMatchObject({ provider: "faux", model: "fallback" });
			const sessionFile = harness.session.sessionFile!;
			harness.session.dispose();

			const runtime = await freshRuntime(harness);
			const { loader, settingsManager } = await load(harness, extension);
			const queues = loader.getExtensions().runtime;
			expect(queues.pendingProviderRegistrations).toHaveLength(kind === "provider" ? 1 : 0);
			expect(queues.pendingNativeProviderRegistrations).toHaveLength(kind === "native" ? 1 : 0);
			expect(queues.pendingVirtualModelRegistrations).toHaveLength(1);
			expect(runtime.getModel("openai", "auto")).toBeUndefined();
			const result = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: runtime,
				resourceLoader: loader,
				settingsManager,
				sessionManager: SessionManager.open(sessionFile),
				tools: [],
			});
			sessions.push(result.session);
			const immediateSelection = result.session.model;
			harness.setResponses([fauxAssistantMessage("physical fallback bypass")]);
			native.setResponses([fauxAssistantMessage("native routed response")]);
			await result.session.prompt("resumed");

			// Check the actual effect first: the broken candidate sends fallback without invoking the router.
			expect(result.session.messages.at(-1)).toMatchObject({
				provider: kind === "native" ? "openai" : "faux",
				model: kind === "native" ? "native-routed" : "routed",
				stopReason: "stop",
			});
			expect(immediateSelection).toMatchObject({ provider: "openai", id: "auto" });
			expect(result.session.model).toMatchObject({ provider: "openai", id: "auto" });
			expect(result.modelFallbackMessage).toBeUndefined();
			expect(requests.map((request) => request.reason)).toEqual(["user", "user"]);
			expect(requests[1].previous?.model).toMatchObject({ provider: "faux", id: "fallback" });
			expect(runtime.hasConfiguredAuth("openai")).toBe(true);
			expect(runtime.getAvailableSnapshot()).toContainEqual(
				expect.objectContaining({ provider: "openai", id: "auto" }),
			);
			expect(queues.pendingProviderRegistrations).toEqual([]);
			expect(queues.pendingNativeProviderRegistrations).toEqual([]);
			expect(queues.pendingVirtualModelRegistrations).toEqual([]);
		},
	);

	// #2241: all three queues share one ordering, and native availability is joined before SDK return.
	it("flushes provider then native then virtual and waits for offline availability", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("PI_TEST_BOOTSTRAP_KEY", "fake-reference-value");
		const harness = await createHarness({ persistSession: true, tools: [] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("saved physical response")]);
		await harness.session.prompt("first");
		const response = harness.session.messages.at(-1);
		if (response?.role !== "assistant") throw new Error("Missing faux response");
		harness.sessionManager.appendModelChange("openai", "auto");
		harness.sessionManager.appendMessage(response);
		const runtime = await freshRuntime(harness);
		const native = fauxProvider({ provider: "openai", models: [{ id: "native-physical" }] }).provider;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gatedNative: Provider = {
			...native,
			auth: {
				apiKey: {
					...native.auth.apiKey!,
					check: async () => {
						started();
						await gate;
						return { type: "api_key", source: "offline fixture" };
					},
				},
			},
		};
		const { loader, settingsManager } = await load(harness, (pi) => {
			pi.registerProvider("openai", { apiKey: "$PI_TEST_BOOTSTRAP_KEY" });
			pi.registerProvider(gatedNative);
			pi.registerVirtualModel({
				provider: "openai",
				id: "auto",
				name: "Auto",
				route: () => ({ model: harness.getModel(), thinkingLevel: "off" }),
			});
		});
		const order: string[] = [];
		const registerProvider = runtime.registerProvider.bind(runtime);
		const registerNative = runtime.registerNativeProvider.bind(runtime);
		const registerVirtual = runtime.registerVirtualModel.bind(runtime);
		const refresh = runtime.refresh.bind(runtime);
		vi.spyOn(runtime, "registerProvider").mockImplementation((...args) => {
			order.push("provider");
			registerProvider(...args);
		});
		vi.spyOn(runtime, "registerNativeProvider").mockImplementation((...args) => {
			order.push("native");
			registerNative(...args);
		});
		vi.spyOn(runtime, "registerVirtualModel").mockImplementation((...args) => {
			order.push("virtual");
			registerVirtual(...args);
		});
		vi.spyOn(runtime, "refresh").mockImplementation((options) => {
			expect(options?.allowNetwork).toBe(false);
			order.push("offline");
			return refresh(options);
		});
		let settled = false;
		const creation = createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: runtime,
			resourceLoader: loader,
			settingsManager,
			sessionManager: SessionManager.open(harness.session.sessionFile!),
			tools: [],
		}).then((result) => {
			settled = true;
			sessions.push(result.session);
			return result;
		});
		try {
			await entered;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(order.filter((step) => step !== "offline")).toEqual(["provider", "native", "virtual"]);
			expect(order.at(-1)).toBe("offline");
			expect(settled).toBe(false);
		} finally {
			release();
			await creation;
		}
		const result = await creation;
		expect(result.session.model).toMatchObject({ provider: "openai", id: "auto" });
		expect(result.modelFallbackMessage).toBeUndefined();
		expect(runtime.hasConfiguredAuth("openai")).toBe(true);
		expect(runtime.getRegisteredProviderConfig("openai")).toBeUndefined();
		expect(runtime.getRegisteredNativeProvider("openai")).toBe(gatedNative);
	});

	// #2241: virtual registration under a physical provider must not manufacture authentication.
	it("keeps an unauthenticated physical provider ineligible even when its router is registered", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		const harness = await createHarness({ persistSession: true, tools: [] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("physical history")]);
		await harness.session.prompt("first");
		harness.sessionManager.appendModelChange("openai", "auto");
		const runtime = await freshRuntime(harness);
		const route = vi.fn(() => ({ model: harness.getModel(), thinkingLevel: "off" as const }));
		const { loader, settingsManager } = await load(harness, (pi) => {
			pi.registerVirtualModel({ provider: "openai", id: "auto", name: "Auto", route });
		});
		const result = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: runtime,
			resourceLoader: loader,
			settingsManager,
			sessionManager: SessionManager.open(harness.session.sessionFile!),
			tools: [],
		});
		sessions.push(result.session);
		harness.setResponses([fauxAssistantMessage("allowed physical fallback")]);
		await result.session.prompt("resumed");
		expect(result.session.model).toMatchObject({ provider: "faux", id: harness.getModel().id });
		expect(result.modelFallbackMessage).toBe(
			`Could not restore model openai/auto. Using faux/${harness.getModel().id}`,
		);
		expect(runtime.hasConfiguredAuth("openai")).toBe(false);
		expect(route).not.toHaveBeenCalled();
		expect(result.session.messages.at(-1)).toMatchObject({ provider: "faux", stopReason: "stop" });
	});

	// #2241: early registration must leave failed entries available to the runner's original diagnostics.
	it("preserves extension attribution for failed provider, native and virtual registrations", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		const invalidNative: Provider = { ...fauxProvider().provider, id: " " };
		const extension: ExtensionFactory = (pi) => {
			pi.registerProvider("broken", { streamSimple: invalidNative.streamSimple });
			pi.registerProvider(invalidNative);
			pi.registerVirtualModel({
				provider: "",
				id: "",
				name: "Invalid",
				route: () => ({ model: harness.getModel(), thinkingLevel: "off" }),
			});
		};
		const { loader, settingsManager } = await load(harness, extension);
		const emitted = vi.spyOn(ExtensionRunner.prototype, "emitError");
		const result = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			modelRuntime: runtime,
			resourceLoader: loader,
			settingsManager,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			tools: [],
		});
		sessions.push(result.session);
		expect(emitted.mock.calls.map(([error]) => ({ event: error.event, extensionPath: error.extensionPath }))).toEqual(
			[
				{ event: "register_provider", extensionPath: "<inline:1>" },
				{ event: "register_provider", extensionPath: "<inline:1>" },
				{ event: "register_virtual_model", extensionPath: "<inline:1>" },
			],
		);
		const services = await createAgentSessionServices({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: runtime,
			resourceLoaderOptions: { ...resourceOptions, extensionFactories: [extension] },
		});
		expect(services.diagnostics).toHaveLength(3);
		expect(
			services.diagnostics.every(
				(entry) => entry.type === "error" && entry.message.startsWith('Extension "<inline:1>" error:'),
			),
		).toBe(true);
		expect(services.resourceLoader.getExtensions().runtime.pendingProviderRegistrations).toEqual([]);
		expect(services.resourceLoader.getExtensions().runtime.pendingNativeProviderRegistrations).toEqual([]);
		expect(services.resourceLoader.getExtensions().runtime.pendingVirtualModelRegistrations).toEqual([]);
	});

	// #2241: scoped SDK branch control only; no native receiving/credential authority is fabricated.
	it("does not flush or refresh loader registrations on the ordinary-owner SDK branch", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		const { loader, settingsManager } = await load(harness, (pi) => {
			pi.registerProvider("openai", { apiKey: "$UNRESOLVED_TEST_REFERENCE" });
			pi.registerProvider(fauxProvider({ provider: "native-control" }).provider);
			pi.registerVirtualModel({
				provider: "router",
				id: "auto",
				name: "Auto",
				route: () => ({ model: harness.getModel(), thinkingLevel: "off" }),
			});
		});
		const model = harness.getModel();
		const options = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: runtime,
			resourceLoader: loader,
			settingsManager,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			model,
			tools: ["read"],
		};
		const stopped = new Error("TEST_STOP_BEFORE_OWNED_SESSION_CONSTRUCTION");
		const owner = {
			assertSdkInputs: vi.fn(),
			decision: {
				record: { provider: { provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl } },
			},
			assertActive: () => {
				throw stopped;
			},
		} as unknown as ownership.OrdinaryOwnerContext;
		const originalLookup = ownership.ordinaryOwnerOf;
		vi.spyOn(ownership, "ordinaryOwnerOf").mockImplementation((input) =>
			input === options ? owner : originalLookup(input),
		);
		vi.spyOn(ownership, "assertOrdinaryRuntime").mockImplementation(() => {});
		const provider = vi.spyOn(runtime, "registerProvider");
		const native = vi.spyOn(runtime, "registerNativeProvider");
		const virtual = vi.spyOn(runtime, "registerVirtualModel");
		const refresh = vi.spyOn(runtime, "refresh");
		await expect(createAgentSession(options)).rejects.toBe(stopped);
		expect(provider).not.toHaveBeenCalled();
		expect(native).not.toHaveBeenCalled();
		expect(virtual).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(loader.getExtensions().runtime.pendingProviderRegistrations).toHaveLength(1);
		expect(loader.getExtensions().runtime.pendingNativeProviderRegistrations).toHaveLength(1);
		expect(loader.getExtensions().runtime.pendingVirtualModelRegistrations).toHaveLength(1);
	});
});
