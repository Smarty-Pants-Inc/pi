// Regression for Smarty-Pants-Inc/smarty-dev#2751: admission happens before physical requests.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as anthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as azure } from "../src/api/azure-openai-responses.ts";
import { streamSimple as bedrock } from "../src/api/bedrock-converse-stream.ts";
import { streamSimple as google } from "../src/api/google-generative-ai.ts";
import { streamSimple as vertex } from "../src/api/google-vertex.ts";
import { streamSimple as mistral } from "../src/api/mistral-conversations.ts";
import { streamSimple as codex } from "../src/api/openai-codex-responses.ts";
import { streamSimple as completions } from "../src/api/openai-completions.ts";
import { streamSimple as responses } from "../src/api/openai-responses.ts";
import { streamSimple as piMessages } from "../src/api/pi-messages.ts";
import type { Api, AssistantMessageEventStream, Model, SimpleStreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function model<T extends Api>(api: T): Model<T> {
	return {
		id: "test-model",
		name: "test-model",
		api,
		provider: "synthetic",
		baseUrl: "https://provider.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 100,
	};
}
const context = normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 0 }] });
const token = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.bbb`;
const adapters: Array<[Api, (options: SimpleStreamOptions) => AssistantMessageEventStream]> = [
	["anthropic-messages", (options) => anthropic(model("anthropic-messages"), context, options)],
	["openai-completions", (options) => completions(model("openai-completions"), context, options)],
	["openai-responses", (options) => responses(model("openai-responses"), context, options)],
	["azure-openai-responses", (options) => azure(model("azure-openai-responses"), context, options)],
	["openai-codex-responses", (options) => codex(model("openai-codex-responses"), context, options)],
	["google-generative-ai", (options) => google(model("google-generative-ai"), context, options)],
	["google-vertex", (options) => vertex(model("google-vertex"), context, options)],
	["mistral-conversations", (options) => mistral(model("mistral-conversations"), context, options)],
	["pi-messages", (options) => piMessages(model("pi-messages"), context, options)],
];
let server: Server | undefined;
afterEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	if (server) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
		server = undefined;
	}
});

describe("physical provider admission", () => {
	it.each([1, 2, undefined])("shares Codex WebSocket and SSE fallback admission (limit %s)", async (limit) => {
		let frames = 0;
		class FailingWebSocket extends EventTarget {
			constructor() {
				super();
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			send(): void {
				frames++;
				throw new Error("synthetic transport failure");
			}
			close(): void {}
		}
		vi.stubGlobal("WebSocket", FailingWebSocket);
		const fetch = vi.fn(async () => new Response("synthetic fallback", { status: 400 }));
		let admitted = 0;
		const result = await codex(model("openai-codex-responses"), context, {
			apiKey: token,
			fetch,
			maxRetries: 0,
			beforeProviderRequest:
				limit === undefined
					? undefined
					: () => {
							if (admitted === limit) throw new Error(`Provider request limit reached (${limit}/${limit})`);
							admitted++;
						},
		}).result();
		expect(frames).toBe(1);
		expect(fetch).toHaveBeenCalledTimes(limit === 1 ? 0 : 1);
		if (limit !== undefined) expect(admitted).toBe(limit);
		expect(result.errorMessage).toContain(
			limit === 1 ? "Provider request limit reached (1/1)" : "synthetic fallback",
		);
	});

	it.each(["websocket_connection_limit_reached", "previous_response_not_found"])(
		"bounds Codex protocol retries for %s",
		async (code) => {
			let frames = 0;
			class RetryWebSocket extends EventTarget {
				constructor() {
					super();
					queueMicrotask(() => this.dispatchEvent(new Event("open")));
				}
				send(): void {
					frames++;
					queueMicrotask(() =>
						this.dispatchEvent(
							Object.assign(new Event("message"), {
								data: JSON.stringify({ type: "error", error: { code } }),
							}),
						),
					);
				}
				close(): void {}
			}
			vi.stubGlobal("WebSocket", RetryWebSocket);
			const fetch = vi.fn(async () => new Response("unexpected HTTP", { status: 400 }));
			let admitted = 0;
			const result = await codex(model("openai-codex-responses"), context, {
				apiKey: token,
				fetch,
				maxRetries: 0,
				beforeProviderRequest: () => {
					if (admitted === 1) throw new Error("Provider request limit reached (1/1)");
					admitted++;
				},
			}).result();
			expect(frames).toBe(1);
			expect(fetch).not.toHaveBeenCalled();
			expect(admitted).toBe(1);
			expect(result.errorMessage).toContain("Provider request limit reached (1/1)");
		},
	);
	it.each(adapters)("counts and bounds %s, including streamSimple option mapping", async (_api, stream) => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { message: "synthetic failure" } }), {
					status: 503,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetch);
		let admitted = 0;
		const options: SimpleStreamOptions = {
			apiKey: token,
			transport: "sse",
			maxRetries: 0,
			beforeProviderRequest: () => {
				if (admitted === 1) throw new Error("Provider request limit reached (1/1)");
				admitted++;
			},
		};
		await stream(options).result();
		expect(admitted).toBe(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		const denied = await stream(options).result();
		expect(denied.errorMessage).toContain("Provider request limit reached (1/1)");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(admitted).toBe(1);
	});

	it("counts Bedrock SDK retries at the physical boundary", async () => {
		let physical = 0;
		server = createServer((_request, response) => {
			physical++;
			response.writeHead(503, {
				"content-type": "application/json",
				"x-amzn-errortype": "ServiceUnavailableException",
			});
			response.end(JSON.stringify({ message: "synthetic failure" }));
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected a test server");
		let admitted = 0;
		const result = await bedrock(
			{ ...model("bedrock-converse-stream"), baseUrl: `http://127.0.0.1:${address.port}` },
			context,
			{
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", HTTP_PROXY: "", HTTPS_PROXY: "" },
				beforeProviderRequest: () => {
					if (admitted === 2) throw new Error("Provider request limit reached (2/2)");
					admitted++;
				},
			},
		).result();
		expect(admitted).toBe(2);
		expect(physical).toBe(2);
		expect(result.errorMessage).toContain("Provider request limit reached (2/2)");
	}, 10000);

	it("bounds the separate Codex SSE retry loop", async () => {
		const fetch = vi.fn(async () => new Response("retry", { status: 429, headers: { "retry-after": "0" } }));
		let admitted = 0;
		const result = await codex(model("openai-codex-responses"), context, {
			apiKey: token,
			fetch,
			transport: "sse",
			maxRetries: 5,
			beforeProviderRequest: () => {
				if (admitted === 2) throw new Error("Provider request limit reached (2/2)");
				admitted++;
			},
		}).result();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(admitted).toBe(2);
		expect(result.errorMessage).toContain("Provider request limit reached (2/2)");
	});
});
