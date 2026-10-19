import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getModelCatalogProviderKey,
	MODEL_CATALOG_INDEX_KEY,
	type ModelCatalogIndex,
	parseModelCatalogIndex,
	parseModelCatalogRequest,
	selectModelCatalog,
} from "../../../scripts/model-catalog-protocol.ts";
import { VERSION } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { allowNetwork } from "./test-network-env.ts";

// Runs the current client against the catalog selection pi.dev performs, using
// the shared protocol in scripts/model-catalog-protocol.ts. Regression test for #9099.

const legacyRevision = `sha256-${"a".repeat(64)}`;
const mixedApiRevision = `sha256-${"b".repeat(64)}`;
// pi#280: use an existing pinned-catalog row, not an obsolete model restored for this fixture.
const modelId = "openai/gpt-4o";
// Newer than the bundled catalog, so the client applies the remote overlay.
const lastModified = new Date("2099-01-01T00:00:00Z").toUTCString();
const commonModel = {
	id: modelId,
	name: "Protocol fixture GPT-4o",
	provider: "openrouter",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};
const legacyModel = {
	...commonModel,
	name: "Legacy catalog GPT-4o",
	api: "openai-completions",
	baseUrl: "https://openrouter.ai/api/v1",
};
// The selected revision may supply metadata, but cannot change this model's local routing.
const mixedApiModel = {
	...commonModel,
	name: "Typed catalog GPT-4o",
	api: "anthropic-messages",
	baseUrl: "https://openrouter.ai/api",
};

const index: ModelCatalogIndex = {
	schemaVersion: 1,
	defaultRevision: mixedApiRevision,
	catalogs: [
		{ minimumPiVersion: "0.80.7", revision: legacyRevision },
		{ minimumPiVersion: "0.85.0", revision: mixedApiRevision },
	],
};

// The legacy revision predates typed shards, so typed requests fall back to the chat-only shard.
const objects = new Map<string, unknown>([
	[MODEL_CATALOG_INDEX_KEY, index],
	[getModelCatalogProviderKey(legacyRevision, "openrouter", "legacy"), { [modelId]: legacyModel }],
	[getModelCatalogProviderKey(mixedApiRevision, "openrouter", "legacy"), { [modelId]: mixedApiModel }],
	[getModelCatalogProviderKey(mixedApiRevision, "openrouter", "typed"), [{ type: "chat", ...mixedApiModel }]],
]);

/** Minimal stand-in for pi.dev's /api/models/providers/:provider route. */
function startCatalogServer(requests: string[]): Promise<Server> {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
		requests.push(`${url.pathname}${url.search}`);
		const provider = /^\/api\/models\/providers\/([^/]+)$/.exec(url.pathname)?.[1];
		const catalogRequest = parseModelCatalogRequest(url, request.headers["user-agent"]);
		if (!provider) {
			response.writeHead(404).end();
		} else if (catalogRequest.kind === "redirect") {
			response.writeHead(307, { location: catalogRequest.location, "cache-control": "no-store" }).end();
		} else if (catalogRequest.kind === "invalid") {
			response.writeHead(400).end(catalogRequest.error);
		} else {
			const catalog = selectModelCatalog(
				parseModelCatalogIndex(objects.get(MODEL_CATALOG_INDEX_KEY)),
				catalogRequest.piVersion,
			);
			const body = catalog
				? (objects.get(getModelCatalogProviderKey(catalog.revision, provider, catalogRequest.representation)) ??
					objects.get(getModelCatalogProviderKey(catalog.revision, provider, "legacy")))
				: undefined;
			if (!catalog || body === undefined) {
				response.writeHead(404).end();
			} else {
				response
					.writeHead(200, {
						"content-type": "application/json",
						"last-modified": lastModified,
						"x-pi-model-catalog-revision": catalog.revision,
					})
					.end(JSON.stringify(body));
			}
		}
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

describe("model catalog protocol with the current client", () => {
	const requests: string[] = [];
	let server: Server;
	let catalogBaseUrl: string;

	beforeAll(async () => {
		server = await startCatalogServer(requests);
		catalogBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});

	beforeEach(() => {
		requests.length = 0;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	// pi#280, #9099: default pinning and explicit negotiation are paired on the real runtime path.
	it.each([undefined, "1"] as const)(
		"negotiates only with PI_REMOTE_CATALOG=%s and reaches the locally routed OpenRouter API",
		async (remoteCatalog) => {
			allowNetwork();
			vi.stubEnv("PI_REMOTE_CATALOG", remoteCatalog);
			const providerRequests: string[] = [];
			const nativeFetch = globalThis.fetch;
			// Install before refresh: opt-in also calls /models/user. Never contact a live provider.
			vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = new Request(input, init);
				const url = new URL(request.url);
				if (url.origin === catalogBaseUrl) return nativeFetch(request);
				providerRequests.push(`${url.origin}${url.pathname}`);
				expect(url.origin).toBe("https://openrouter.ai");
				expect(request.headers.get("authorization")).toBe("Bearer test-key");
				if (url.pathname === "/api/v1/models/user") {
					return new Response(JSON.stringify({ data: [{ id: modelId }] }), {
						headers: { "content-type": "application/json" },
					});
				}
				expect(url.pathname).toBe("/api/v1/chat/completions");
				const body: unknown = await request.json();
				expect(body).toMatchObject({ model: modelId, stream: true });
				return new Response(
					`${[
						{ id: "fixture", choices: [{ index: 0, delta: { content: "Fixture response" } }] },
						{ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					]
						.map((event) => `data: ${JSON.stringify(event)}\n\n`)
						.join("")}data: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			});
			const runtime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: null,
				catalogBaseUrl,
				refreshOnCreate: false,
			});
			const baseline = runtime.getModel("openrouter", modelId);
			expect(baseline).toMatchObject({
				api: "openai-completions",
				baseUrl: "https://openrouter.ai/api/v1",
			});
			await runtime.setRuntimeApiKey("openrouter", "test-key");
			expect(requests).toEqual([]);
			expect(providerRequests).toEqual([]);
			const refresh = await runtime.refresh({ allowNetwork: true, force: true, providers: ["openrouter"] });
			expect(refresh.aborted).toBe(false);
			expect([...refresh.errors]).toEqual([]);

			const catalogUrl = "/api/models/providers/openrouter?types=chat%2Cimage%2Cclassifier";
			expect(requests).toEqual(remoteCatalog ? [catalogUrl, `${catalogUrl}&pi-version=${VERSION}`] : []);
			const model = runtime.getModel("openrouter", modelId);
			if (!model || !baseline) throw new Error(`Missing pinned model: openrouter/${modelId}`);
			if (remoteCatalog) {
				const expectedModel =
					selectModelCatalog(index, VERSION)?.revision === legacyRevision ? legacyModel : mixedApiModel;
				// Prove the selected overlay was applied, not merely that its requests succeeded.
				expect(model).toMatchObject({ name: expectedModel.name, contextWindow: expectedModel.contextWindow });
			} else {
				expect(model).toEqual(baseline);
			}
			// Remote API/base URL fields cannot override the trusted local provider's request route.
			expect(model).toMatchObject({ api: baseline.api, baseUrl: baseline.baseUrl });
			const result = await runtime.completeSimple(
				model,
				{ messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
				{ apiKey: "test-key", maxRetries: 0 },
			);
			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([{ type: "text", text: "Fixture response" }]);
			expect(providerRequests).toEqual([
				...(remoteCatalog ? ["https://openrouter.ai/api/v1/models/user"] : []),
				"https://openrouter.ai/api/v1/chat/completions",
			]);
		},
	);
});
