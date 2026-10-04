import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
} from "../../ai/src/api/openai-codex-responses.ts";
import { InMemoryCredentialStore } from "../../ai/src/auth/credential-store.ts";
import { createModels, type Provider } from "../../ai/src/models.ts";
import { openaiProvider } from "../../ai/src/providers/openai.ts";
import { openaiCodexProvider } from "../../ai/src/providers/openai-codex.ts";
import type { AssistantMessage } from "../../ai/src/types.ts";
import { retryAssistantCall } from "../../ai/src/utils/retry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const account = "FAKE_ACCOUNT_127_ROUND3";
const access = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } }),
).toString("base64url")}.FAKE_SIGNATURE_127`;
const refresh = 'FAKE_REFRESH_127_"QUOTE\\BACK/+=?%';
const idToken = 'FAKE_ID_127_"QUOTE\\BACK/+=?%';
const original = 'FAKE_ORIGINAL_127_"QUOTE\\BACK/+=?%';
const transformed = 'FAKE_TRANSFORMED_127_"QUOTE\\BACK/+=?%';
const secrets = [account, access, refresh, idToken, original, transformed];

function escaped(value: string, depth: number): string {
	for (let i = 0; i < depth; i++) value = JSON.stringify(value).slice(1, -1);
	return value;
}

function expectPrivate(sinks: Record<string, unknown>): void {
	for (const [sink, value] of Object.entries(sinks)) {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		for (const secret of secrets) {
			for (let depth = 0; depth <= 8; depth++)
				expect(text, `${sink}, JSON depth ${depth}`).not.toContain(escaped(secret, depth));
			expect(text, `${sink}, URL encoded`).not.toContain(encodeURIComponent(secret));
		}
	}
}

function persist(output: AssistantMessage): string {
	const root = mkdtempSync(join(tmpdir(), "credential-session-127-"));
	const session = SessionManager.create(root, root);
	session.appendMessage(output);
	const path = session.getSessionFile();
	expect(path).toBeDefined();
	return readFileSync(path!, "utf8");
}

async function runtime(provider: Provider) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(provider.id, async () => ({
		type: "oauth",
		access,
		refresh,
		idToken,
		expires: Date.now() + 3600000,
	}));
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	models.setProvider(provider);
	return { models, model: provider.getModels()[0] };
}

function sse(type: string, reason?: string): Response {
	return new Response(
		`data: ${JSON.stringify({ type, response: { id: "synthetic", status: reason ? "incomplete" : "completed", output: [], incomplete_details: reason ? { reason } : undefined } })}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
});

// pi#127 / round-3 P1-1 and P1-2: auditor value-sinks probe, including real JSONL persistence.
describe.each([openaiProvider(), openaiCodexProvider()])("credential diagnostic sessions: $id", (provider) => {
	it.each(["stream", "complete"])(
		"keeps live values private through %s error, SDK, retry, observer and stop sinks",
		async (method) => {
			vi.stubEnv("OPENAI_LOG", "debug");
			const records: unknown[] = [];
			for (const level of ["debug", "info", "warn", "error"] as const)
				vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
					records.push(args);
				});
			const bodies = [
				`receipt=${original} ${transformed}`,
				`receipt=${encodeURIComponent(original)} ${encodeURIComponent(transformed)}`,
				escaped(JSON.stringify({ unrelated: [refresh, idToken] }), 1),
				escaped(JSON.stringify({ unrelated: [refresh, idToken] }), 2),
			];
			for (const body of bodies)
				for (const kind of ["HTTP", "JSON HTTP", "observer", "stop"]) {
					const { models, model } = await runtime(provider);
					records.length = 0;
					const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
						expect(new Headers(init?.headers).get("authorization")).toBe(
							`Bearer ${provider.id === "openai" ? transformed : access}`,
						);
						if (kind === "HTTP") return new Response(`503 server_error ${body}`, { status: 503 });
						if (kind === "JSON HTTP")
							return Response.json(
								{ error: { code: "server_error", message: `server_error ${body}` } },
								{ status: 503 },
							);
						return sse("response.incomplete", body);
					});
					const options = {
						transport: "sse" as const,
						maxRetries: 0,
						headers: { Authorization: `Bearer ${original}` },
						transformHeaders: (headers: Record<string, string | null>) => ({
							...headers,
							Authorization: `Bearer ${transformed}`,
						}),
						fetch: fetchMock,
						onProviderStreamEvent:
							kind === "observer"
								? () => {
										const error = new Error(body);
										error.name = body;
										Object.assign(error, { code: body });
										throw error;
									}
								: undefined,
					};
					const events: unknown[] = [];
					let output: AssistantMessage;
					if (method === "complete") output = await models.complete(model, { messages: [] }, options);
					else {
						const stream = models.stream(model, { messages: [] }, options);
						for await (const event of stream) events.push(event);
						output = await stream.result();
					}
					expect(fetchMock).toHaveBeenCalledTimes(1);
					expect(output.stopReason).toBe("error");
					if (kind === "observer") expect(output.diagnostics?.[0].type).toBe("provider_stream_observer_error");
					if (kind === "stop") expect(output.rawStopReason).toBeDefined();
					if (kind.includes("HTTP")) {
						expect(output.errorMessage).toContain("oauth_request_failed");
						expect(output.errorMessage).toContain("503");
					}
					const retryObservers: unknown[] = [];
					if (kind === "HTTP") {
						await retryAssistantCall(
							async () => ({ ...output, errorMessage: `overloaded ${output.errorMessage}` }),
							{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
							undefined,
							{
								onRetryScheduled: (...args) => {
									retryObservers.push(args);
								},
								onRetryFinished: (...args) => {
									retryObservers.push(args);
								},
							},
						);
						expect(retryObservers).toHaveLength(2);
					}
					if (provider.id === "openai") expect(records.length).toBeGreaterThan(0);
					expectPrivate({
						errorMessage: output.errorMessage,
						rawStopReason: output.rawStopReason ?? "",
						output,
						events,
						sdkLogger: records,
						retryObservers,
						sessionJSONL: persist(output),
					});
				}
		},
	);
});

// pi#127 / round-3 P1-2: constructor failures reach stats and persisted successful fallback diagnostics.
it.each([2, 3, 4, 5, 6])(
	"masks JSON layer %s live refresh/ID values in Codex WebSocket fallback and session",
	async (depth) => {
		const body = `server_error ${escaped(JSON.stringify({ unrelated: [refresh, idToken] }), depth - 1)}`;
		const websocket = vi.fn();
		vi.stubGlobal(
			"WebSocket",
			class {
				constructor(_url: string, options: { headers: Record<string, string> }) {
					websocket();
					expect(options.headers.authorization).toBe(`Bearer ${access}`);
					throw new Error(body);
				}
			},
		);
		const { models, model } = await runtime(openaiCodexProvider());
		const fetchMock = vi.fn(async () => sse("response.completed"));
		const sessionId = `fake-round3-${depth}`;
		const output = await models.complete(
			model,
			{ messages: [] },
			{ transport: "auto", sessionId, env: {}, maxRetries: 0, fetch: fetchMock },
		);
		expect(websocket).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(output.stopReason).toBe("stop");
		expect(output.diagnostics?.[0].type).toBe("provider_transport_failure");
		const stats = getOpenAICodexWebSocketDebugStats(sessionId);
		expect(stats?.websocketFailures).toBe(1);
		expectPrivate({ diagnostics: output.diagnostics, stats, sessionJSONL: persist(output) });
	},
);
