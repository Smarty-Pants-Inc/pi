import {
	type AnyModel,
	type ClassifierModel,
	createModels,
	createProvider,
	type ImageModel,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	type PersonalizeCatalog,
	REMOTE_CATALOG_MODEL_TYPES,
	withPersonalizedCatalog,
	withRemoteCatalog,
} from "../src/core/remote-catalog-provider.ts";

const neverAbortedSignal = new AbortController().signal;

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function builtinProvider(models: readonly AnyModel[] = [model("static")]): Provider {
	return createProvider({
		id: "test-provider",
		baseUrl: "https://example.test/v1",
		auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
		models,
		api: {
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		},
	});
}

function testProvider(localGeneratedAt?: number) {
	return withRemoteCatalog(builtinProvider(), "https://pi.dev", localGeneratedAt);
}

async function refreshProvider(
	provider: Provider,
	store: InMemoryModelsStore,
	overrides: Partial<Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal">> = {},
): Promise<void> {
	const publish = async (publication: ModelsPublication): Promise<boolean> => {
		if (publication.persist === null) await store.delete(provider.id);
		else if (publication.persist !== undefined) await store.write(provider.id, publication.persist);
		publication.update?.();
		return true;
	};
	await provider.refreshModels?.({
		credential: { type: "api_key" },
		stored: await store.read(provider.id),
		publish,
		allowNetwork: overrides.allowNetwork ?? true,
		force: overrides.force,
		signal: overrides.signal ?? neverAbortedSignal,
	});
}

beforeEach(() => vi.stubEnv("PI_REMOTE_CATALOG", "1"));
afterEach(() => vi.restoreAllMocks());

describe("remote catalog opt-in", () => {
	// pi#244: disabled catalogs must not activate hostile metadata from network or saved overlays.
	it.each([undefined, "0", "true"])("keeps only the local baseline when PI_REMOTE_CATALOG=%s", async (value) => {
		vi.stubEnv("PI_REMOTE_CATALOG", value);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected catalog request"));
		const personalize = vi.fn<PersonalizeCatalog>();
		for (const provider of [testProvider(), withPersonalizedCatalog(builtinProvider(), personalize)]) {
			const store = new InMemoryModelsStore();
			await store.write(provider.id, {
				models: [{ ...model("static"), contextWindow: 1, maxTokens: 999999999 }],
				lastModified: Date.now() + 1000,
			});
			await refreshProvider(provider, store, { allowNetwork: true, force: true });
			expect(provider.getModels()).toEqual([model("static")]);
			expect(await store.read(provider.id)).toBeUndefined();
		}
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(personalize).not.toHaveBeenCalled();
	});

	// pi#244: disabling the opt-in discards an already active remote or personalized overlay too.
	it("drops active overlays when the remote catalog opt-in is removed", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response(JSON.stringify({ dynamic: model("dynamic") })));
		const personalize: PersonalizeCatalog = async (catalog) => catalog;
		for (const provider of [testProvider(), withPersonalizedCatalog(builtinProvider(), personalize)]) {
			vi.stubEnv("PI_REMOTE_CATALOG", "1");
			const store = new InMemoryModelsStore();
			await refreshProvider(provider, store);
			expect(provider.getModels().some((entry) => entry.id === "dynamic")).toBe(true);
			vi.stubEnv("PI_REMOTE_CATALOG", undefined);
			await refreshProvider(provider, store, { force: true });
			expect(provider.getModels()).toEqual([model("static")]);
		}
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	// smarty-dev#3155 TOOLS-CR2: a disabled refresh must prevent saved overlays reviving before expiry.
	it.each(["remote", "personalized"] as const)("clears the saved %s overlay before re-enabling", async (kind) => {
		const now = Date.parse("2026-10-16T06:00:00.000Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const responses = ["old", "fresh"].map(
			(id) =>
				new Response(JSON.stringify({ [id]: model(id) }), {
					headers: { "last-modified": new Date(now).toUTCString(), etag: `"${id}"` },
				}),
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const personalize = vi.fn<PersonalizeCatalog>(async (catalog) => catalog);
		const provider = kind === "remote" ? testProvider() : withPersonalizedCatalog(builtinProvider(), personalize);
		const store = new InMemoryModelsStore();
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);

		const enabled = await models.refresh({ providers: [provider.id] });
		expect([...enabled.errors]).toEqual([]);
		expect(models.getModels(provider.id).some((entry) => entry.id === "old")).toBe(true);
		expect((await store.read(provider.id))?.models.some((entry) => entry.id === "old")).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const personalizationCalls = personalize.mock.calls.length;

		vi.stubEnv("PI_REMOTE_CATALOG", undefined);
		const disabled = await models.refresh({ providers: [provider.id], allowNetwork: false });
		expect([...disabled.errors]).toEqual([]);
		expect(models.getAllModels(provider.id)).toEqual([model("static")]);
		expect(await store.read(provider.id)).toBeUndefined();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(personalize).toHaveBeenCalledTimes(personalizationCalls);

		vi.stubEnv("PI_REMOTE_CATALOG", "1");
		const restored = await models.refresh({ providers: [provider.id], allowNetwork: false });
		expect([...restored.errors]).toEqual([]);
		expect(models.getAllModels(provider.id)).toEqual([model("static")]);
		expect(await store.read(provider.id)).toBeUndefined();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(personalize).toHaveBeenCalledTimes(personalizationCalls);

		// No force and no clock advance: a retained remote cache would skip this fresh request.
		const refreshed = await models.refresh({ providers: [provider.id] });
		expect([...refreshed.errors]).toEqual([]);
		expect(models.getModels(provider.id).map((entry) => entry.id)).toEqual(["static", "fresh"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(
			kind === "remote" ? ["fresh"] : ["static", "fresh"],
		);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[1]?.[1]?.headers).not.toHaveProperty("if-none-match");
	});

	// pi#244: the catalog policy must not silently turn off native provider discovery or other networking.
	it("keeps default runtime refresh networking available to native providers", async () => {
		vi.stubEnv("PI_REMOTE_CATALOG", undefined);
		vi.stubEnv("PI_OFFLINE", undefined);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected catalog request"));
		const refreshModels = vi.fn<NonNullable<Provider["refreshModels"]>>();
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
		runtime.registerNativeProvider({ ...builtinProvider(), refreshModels });
		await runtime.setRuntimeApiKey("test-provider", "local-test-key");
		await runtime.setRuntimeApiKey("anthropic", "local-test-key");
		refreshModels.mockClear();
		const result = await runtime.refresh();
		expect([...result.errors]).toEqual([]);
		expect(refreshModels).toHaveBeenCalledWith(expect.objectContaining({ allowNetwork: true }));
		expect(runtime.getModel("anthropic", "claude-sonnet-4-5")?.baseUrl).toBe("https://api.anthropic.com");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(process.env.PI_OFFLINE).toBeUndefined();
	});
});

describe("remote catalog provider", () => {
	it("parses keyed catalogs, sends version headers, observes the refresh TTL, and supports forced refreshes", async () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-16T06:00:00.000Z"));
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ dynamic: model("dynamic") }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		const saved = await store.read(provider.id);
		await refreshProvider(provider, store);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(await store.read(provider.id)).toEqual(saved);

		// smarty-dev#3155 TOOLS-CR2 positive control: enabled cache-only restoration retains the saved overlay.
		const restoredProvider = testProvider();
		await refreshProvider(restoredProvider, store, { allowNetwork: false });
		expect(restoredProvider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect(await store.read(provider.id)).toEqual(saved);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		await refreshProvider(provider, store, { force: true });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"User-Agent": expect.stringContaining(`pi/${VERSION}`),
		});
		const requested = new URL(String(fetchSpy.mock.calls[0]?.[0]));
		expect(requested.pathname).toBe("/api/models/providers/test-provider");
		expect(requested.searchParams.get("types")).toBe(REMOTE_CATALOG_MODEL_TYPES.join(","));
	});

	// pi#244: untrusted catalog metadata must not redirect prompts or credential-bearing requests.
	it("keeps local routing while applying descriptive remote metadata", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					static: {
						...model("static"),
						api: "attacker-api",
						baseUrl: "https://attacker.example/v1",
						headers: { authorization: "attacker-secret" },
						compat: { openRouterRouting: { only: ["attacker"] } },
						samplingParams: { headers: { authorization: "attacker-secret" } },
						endpoint: "https://attacker.example",
						env: { ATTACKER_URL: "https://attacker.example" },
						cost: { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 },
						contextWindow: 2000,
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const requestModels: Model<string>[] = [];
		const local = builtinProvider();
		const provider = withRemoteCatalog({
			...local,
			streamSimple: (model) => {
				requestModels.push(model);
				throw new Error("Provider request captured");
			},
		});
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerNativeProvider(provider);
		await runtime.setRuntimeApiKey(provider.id, "local-test-key");
		await runtime.refresh({ providers: [provider.id], allowNetwork: true, force: true });
		const selected = runtime.getModel(provider.id, "static");
		if (!selected) throw new Error("Missing remote model");
		await runtime.completeSimple(selected, { messages: [{ role: "user", content: "Hello", timestamp: 0 }] });
		expect(requestModels).toContainEqual({
			...model("static"),
			cost: { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 },
			contextWindow: 2000,
		});

		expect(provider.getModels()).toContainEqual({
			...model("static"),
			cost: { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 },
			contextWindow: 2000,
		});
	});

	// pi#244: new remote ids need local routing data; a remote endpoint is not a baseline.
	it("uses a local routing baseline for new models and drops models without one", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						dynamic: { ...model("dynamic"), api: "attacker-api", baseUrl: "https://attacker.example" },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		);
		const provider = testProvider();
		const emptyProvider = withRemoteCatalog(builtinProvider([]), "https://pi.dev");
		const store = new InMemoryModelsStore();
		const emptyStore = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await refreshProvider(emptyProvider, emptyStore);

		expect(provider.getModels().find((entry) => entry.id === "dynamic")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://example.test/v1",
		});
		expect(emptyProvider.getModels()).toEqual([]);
	});

	// pi#244: previously saved remote routing fields must not survive cache-only startup.
	it("does not let a stored remote model overwrite local routing", async () => {
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await store.write(provider.id, {
			models: [{ ...model("static"), baseUrl: "https://attacker.example/v1", headers: { authorization: "secret" } }],
			lastModified: Date.now() + 1000,
		});

		await refreshProvider(provider, store, { allowNetwork: false });

		expect(provider.getModels()).toContainEqual(model("static"));
	});

	it("overlays image and classifier models and drops unknown model types", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						chat: { ...model("chat"), type: "chat" },
						flux: {
							type: "image",
							id: "flux",
							name: "FLUX",
							api: "openrouter-images",
							provider: "test-provider",
							baseUrl: "https://example.test/v1",
							input: ["text"],
							output: ["image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
						jev: {
							type: "classifier",
							id: "jev",
							name: "Jev",
							api: "typesafe-system-one",
							provider: "test-provider",
							baseUrl: "https://example.test/v1",
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 64000,
						},
						clip: { ...model("clip"), type: "video" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const provider = withRemoteCatalog(
			builtinProvider([
				model("static"),
				{
					type: "image",
					id: "flux",
					name: "FLUX",
					api: "openrouter-images",
					provider: "test-provider",
					baseUrl: "https://example.test/v1",
					input: ["text"],
					output: ["image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				} satisfies ImageModel<"openrouter-images">,
				{
					type: "classifier",
					id: "jev",
					name: "Jev",
					api: "typesafe-system-one",
					provider: "test-provider",
					baseUrl: "https://example.test/v1",
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 64000,
				} satisfies ClassifierModel<"typesafe-system-one">,
			]),
			"https://pi.dev",
		);
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);

		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		expect(models.getAllModels("test-provider").map((entry) => entry.id)).toEqual(["static", "flux", "jev", "chat"]);
		expect(models.getModelOfType("image", "test-provider", "flux")?.type).toBe("image");
		expect(models.getModelOfType("classifier", "test-provider", "jev")?.type).toBe("classifier");
		expect(models.getModel("test-provider", "flux")).toBeUndefined();
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["chat", "flux", "jev"]);
	});

	it("prefers the newer of the generated and remote catalogs", async () => {
		const localGeneratedAt = Date.parse("2026-07-23T10:00:00.000Z");
		const newerHeader = new Date(localGeneratedAt + 60_000).toUTCString();
		const responses = [
			new Response(JSON.stringify({ old: model("old") }), {
				headers: { "last-modified": new Date(localGeneratedAt - 60_000).toUTCString() },
			}),
			new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "last-modified": newerHeader },
			}),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider(localGeneratedAt);
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);

		await refreshProvider(provider, store, { force: true });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect(await store.read(provider.id)).toMatchObject({ lastModified: Date.parse(newerHeader) });
	});

	it("revalidates a stored catalog with its etag and keeps the overlay on 304", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
		expect(await store.read(provider.id)).toMatchObject({ etag: '"catalog-1"' });

		const checkedAt = (await store.read(provider.id))?.checkedAt;
		await refreshProvider(provider, store, { force: true });

		expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.checkedAt).toBeGreaterThanOrEqual(checkedAt ?? 0);
	});

	it("drops a stale etag when the overlay becomes unavailable", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("not implemented", { status: 501 }),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect((await store.read(provider.id))?.etag).toBeUndefined();
	});

	it("keeps the etag and overlay after a transient failure", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await expect(refreshProvider(provider, store, { force: true })).rejects.toThrow(/429/);

		const stored = await store.read(provider.id);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);

		await refreshProvider(provider, store, { force: true });
		expect(fetchSpy.mock.calls[4]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
	});

	it("lets a newer catalog request bypass a stalled older request without stale publication", async () => {
		let calls = 0;
		let markFirstStarted: (() => void) | undefined;
		let finishFirst: ((response: Response) => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstResponse = new Promise<Response>((resolve) => {
			finishFirst = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				markFirstStarted?.();
				return firstResponse;
			}
			return new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "content-type": "application/json" },
			});
		});
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);

		const first = models.refresh({ providers: [provider.id], force: true });
		await firstStarted;
		const second = models.refresh({ providers: [provider.id], force: true });
		await second;
		await first;
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);

		finishFirst?.(
			new Response(JSON.stringify({ older: model("older") }), {
				headers: { "content-type": "application/json" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["newer"]);
	});

	it("treats unimplemented pi.dev catalog routes as an unavailable overlay", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not implemented", { status: 501 }));
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await expect(refreshProvider(provider, store)).resolves.toBeUndefined();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(await store.read(provider.id)).toMatchObject({ models: [], checkedAt: expect.any(Number) });
	});
});

describe("personalized catalog provider", () => {
	const imageModel: ImageModel<"openrouter-images"> = {
		type: "image",
		id: "image",
		name: "image",
		api: "openrouter-images",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	it("keeps the saved list and saves nothing when personalization fails", async () => {
		// Saving the catalog without personalization would replace the key's list with every model.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
		const store = new InMemoryModelsStore();
		const saved = { models: [model("allowed")], checkedAt: 1 };
		await store.write("test-provider", saved);
		const personalize: PersonalizeCatalog = async () => {
			throw new Error("user models request failed");
		};
		const provider = withPersonalizedCatalog(builtinProvider([model("static"), imageModel]), personalize);

		await expect(refreshProvider(provider, store)).rejects.toThrow("user models request failed");
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["allowed"]);
		expect(await store.read(provider.id)).toEqual(saved);
	});

	it("restores a saved list as is, and falls back to the built-in models only when it is empty", async () => {
		const personalize: PersonalizeCatalog = async () => {
			throw new Error("not used offline");
		};
		const store = new InMemoryModelsStore();
		const provider = withPersonalizedCatalog(builtinProvider([model("static"), imageModel]), personalize);

		// pi versions before per-key lists stored the plain pi.dev catalog here, and saved an empty list
		// after a missing pi.dev catalog or a failed first request. Only such an entry can be empty.
		await store.write(provider.id, { models: [], checkedAt: 1 });
		await refreshProvider(provider, store, { allowNetwork: false });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);

		// A key that may use no chat models keeps its image models and shows no chat models.
		await store.write(provider.id, { models: [imageModel], checkedAt: 1 });
		await refreshProvider(provider, store, { allowNetwork: false });
		expect(provider.getModels()).toEqual([]);
		expect(provider.getAllModels?.().map((entry) => entry.id)).toEqual(["image"]);
	});
});
