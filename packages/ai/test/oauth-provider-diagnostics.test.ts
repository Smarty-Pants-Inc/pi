import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
} from "../src/api/openai-codex-responses.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { startOAuthCallbackServer } from "../src/auth/oauth/callback-server.ts";
import { createModels, type Provider } from "../src/models.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import { retryAssistantCall } from "../src/utils/retry.ts";

const nativeFetch = globalThis.fetch;
const account = "FAKE_ACCOUNT_127";
const access = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } }),
).toString("base64url")}.FAKE_SIGNATURE_127`;
const fields = {
	access_token: access,
	refresh_token: "FAKE_REFRESH_127",
	id_token: "FAKE_IDTOKEN_127",
	account_id: account,
	Authorization: `Bearer ${access}`,
};
const payload = JSON.stringify(fields);

function expectRedacted(value: unknown, secrets = Object.values(fields)): void {
	const text = JSON.stringify(value);
	for (const secret of secrets) expect(text).not.toContain(secret);
}

async function runtime(provider: Provider, token = access) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(provider.id, async () => ({
		type: "oauth",
		access: token,
		refresh: fields.refresh_token,
		expires: Date.now() + 3600000,
		clientId: "oaiapp_fake",
	}));
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	models.setProvider(provider);
	return { models, model: provider.getModels()[0] };
}

function completedSSE(): Response {
	return new Response(
		`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fake", status: "completed", output: [] } })}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
});

// pi#127 / B-F1: provider errors are public messages and ordinary session input.
describe.each([openaiCodexProvider(), openaiProvider()])("OAuth provider diagnostics: $id", (provider) => {
	it.each(["HTTP JSON", "HTTP text", "SSE error", "observer"])(
		"redacts %s while retaining error evidence",
		async (kind) => {
			const { models, model } = await runtime(provider);
			const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				expect(new Headers(init?.headers).get("authorization")).toBe(fields.Authorization);
				if (kind === "HTTP JSON")
					return Response.json({ error: { code: "server_error", ...fields } }, { status: 503 });
				if (kind === "HTTP text") return new Response(`server_error ${payload}`, { status: 503 });
				if (kind === "observer") return completedSSE();
				return new Response(
					`data: ${JSON.stringify({ type: "error", code: "server_error", message: `server_error ${payload}` })}\n\n`,
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			});
			const output = await models.complete(
				model,
				{ messages: [] },
				{
					transport: "sse",
					maxRetries: 0,
					fetch: fetchMock,
					onProviderStreamEvent:
						kind === "observer"
							? () => {
									const error = new Error(`server_error ${payload}; active=${access}; account=${account}`);
									error.name = access;
									Object.assign(error, { code: account });
									throw error;
								}
							: undefined,
				},
			);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(output.stopReason).toBe("error");
			expect(output.errorMessage).toMatch(/oauth_(request|stream)_failed/);
			if (kind.startsWith("HTTP")) expect(output.errorMessage).toContain("503");
			expectRedacted(output);
		},
	);

	it.each(["failed status", "incomplete reason"])("redacts %s in persisted stop metadata", async (kind) => {
		const { models, model } = await runtime(provider);
		const response =
			kind === "failed status"
				? { id: "resp_fake", status: access, error: { code: "server_error", message: "server_error" }, output: [] }
				: { id: "resp_fake", status: "incomplete", incomplete_details: { reason: payload }, output: [] };
		const output = await models.complete(
			model,
			{ messages: [] },
			{
				transport: "sse",
				maxRetries: 0,
				fetch: async () =>
					new Response(
						`data: ${JSON.stringify({ type: kind === "failed status" ? "response.failed" : "response.incomplete", response })}\n\n`,
						{
							headers: { "content-type": "text/event-stream" },
						},
					),
			},
		);
		expect(output.stopReason).toBe("error");
		expect(output.rawStopReason).toBeDefined();
		expectRedacted(output);
	});

	it("redacts a native bearer header validation error before network I/O", async () => {
		const invalid = `${access}\nFAKE_INVALID_127`;
		const { models, model } = await runtime(provider, invalid);
		const fetchMock = vi.fn(async () => completedSSE());
		const output = await models.complete(
			model,
			{ messages: [] },
			{ transport: "sse", fetch: fetchMock, maxRetries: 0 },
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(output.stopReason).toBe("error");
		expectRedacted(output, [access, "FAKE_INVALID_127"]);
	});
});

// pi#127 / B-F1: invalid account header values are echoed by native Headers.set, not a provider response.
it("redacts a native Codex account header validation error before network I/O", async () => {
	const invalidAccount = `${account}\nFAKE_INVALID_ACCOUNT_127`;
	const token = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: invalidAccount },
		}),
	).toString("base64url")}.FAKE_SIGNATURE_127`;
	const { models, model } = await runtime(openaiCodexProvider(), token);
	const fetchMock = vi.fn(async () => completedSSE());
	const output = await models.complete(model, { messages: [] }, { transport: "sse", fetch: fetchMock, maxRetries: 0 });
	expect(fetchMock).not.toHaveBeenCalled();
	expect(output.stopReason).toBe("error");
	expectRedacted(output, [token, account, "FAKE_INVALID_ACCOUNT_127"]);
});

// pi#127 / B-F1: successful fallback retains diagnostics and public WebSocket statistics.
it("redacts WebSocket fallback message, stack, code and stats before a successful SSE start", async () => {
	vi.stubGlobal(
		"WebSocket",
		class {
			constructor() {
				const error = new Error(`connection failed: ${access}; ${account}; ${payload}`);
				error.name = access;
				Object.assign(error, { code: account });
				throw error;
			}
		},
	);
	const { models, model } = await runtime(openaiCodexProvider());
	const stream = models.stream(
		model,
		{ messages: [] },
		{
			transport: "auto",
			sessionId: "fake-session-127",
			env: {},
			fetch: async () => completedSSE(),
		},
	);
	const events = [];
	for await (const event of stream) {
		expectRedacted(event);
		events.push(event.type);
	}
	const output = await stream.result();
	expect(output.stopReason).toBe("stop");
	expect(events).toContain("start");
	expect(output.diagnostics?.[0].error?.message).toContain("oauth_request_failed");
	expectRedacted(getOpenAICodexWebSocketDebugStats("fake-session-127"));
});

// pi#127 / B-F1: generic retry observers must not forward structured credentials.
it("redacts generic retry text and the final response", async () => {
	const { models, model } = await runtime(openaiCodexProvider());
	const failed = await models.complete(
		model,
		{ messages: [] },
		{
			transport: "sse",
			maxRetries: 0,
			fetch: async () => new Response("server_error", { status: 503 }),
		},
	);
	const events: string[] = [];
	const output = await retryAssistantCall(
		async () => ({ ...failed, errorMessage: `server_error ${payload}` }),
		{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
		undefined,
		{
			onRetryScheduled: (_attempt, _max, _delay, message) => {
				events.push(message);
			},
			onRetryFinished: (_success, _attempt, message) => {
				events.push(message ?? "");
			},
		},
	);
	expect(events).toHaveLength(2);
	expectRedacted({ events, output });
});

// pi#127 / B-F2: catch-only protection cannot sanitize the SDK's debug console sink.
it.each(["HTTP", "transport", "retry cap", "custom endpoint"])("redacts OAuth SDK %s debug records", async (kind) => {
	vi.stubEnv("OPENAI_LOG", "debug");
	const records: unknown[] = [];
	for (const level of ["debug", "info", "warn", "error"] as const) {
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			records.push(args);
		});
	}
	const { models, model } = await runtime(openaiProvider());
	const requestModel = kind === "custom endpoint" ? { ...model, baseUrl: "https://fake.invalid/v1" } : model;
	const output = await models.complete(
		requestModel,
		{ messages: [] },
		{
			maxRetries: kind === "retry cap" ? 1 : 0,
			maxRetryDelayMs: 1000,
			fetch: async () => {
				if (kind === "transport") throw new Error(`connection failed ${payload}; ${access}`);
				return new Response(`server_error ${payload}`, { status: 503, headers: { "retry-after": "2" } });
			},
		},
	);
	expect(output.stopReason).toBe("error");
	expect(records.length).toBeGreaterThan(0);
	expectRedacted({ records, output });
	if (kind === "retry cap") expect(output.errorMessage).toContain("oauth_request_failed");
});

// pi#127 / B-F3: callback errors/descriptions are untrusted diagnostic input.
it("redacts manual ChatGPT callback errors through Models.login", async () => {
	const { models } = await runtime(openaiProvider());
	let authorize: URL | undefined;
	const fetchMock = vi.fn(async () => {
		throw new Error("Unexpected token request");
	});
	vi.stubGlobal("fetch", fetchMock);
	const error: unknown = await models
		.login(
			"openai",
			"oauth",
			{
				signal: new AbortController().signal,
				notify: (event) => {
					if (event.type === "auth_url") authorize = new URL(event.url);
				},
				prompt: async () => {
					if (!authorize) throw new Error("Missing authorization URL");
					const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
					callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
					callback.searchParams.set("error", payload);
					callback.searchParams.set("error_description", payload);
					return callback.toString();
				},
			},
			{ getDeviceId: () => "e61bbe28-07ef-466d-8e5d-a344f94ab305" },
		)
		.catch((error: unknown) => error);
	expect(error).toBeInstanceOf(Error);
	expectRedacted({ message: (error as Error).message, stack: (error as Error).stack });
	expect(fetchMock).not.toHaveBeenCalled();
});

it.each(["access_denied", payload])(
	"redacts shared browser callback error %s and ignores descriptions",
	async (code) => {
		const callback = await startOAuthCallbackServer({
			providerName: "OpenAI",
			host: "127.0.0.1",
			port: 0,
			path: "/callback",
			state: "fake-state",
			complete: async () => {
				throw new Error("Unexpected token exchange");
			},
		});
		try {
			const url = new URL(callback.redirectUri);
			url.searchParams.set("state", "fake-state");
			url.searchParams.set("error", code);
			url.searchParams.set("error_description", payload);
			const response = await nativeFetch(url);
			const body = await response.text();
			const error: unknown = await callback.wait().catch((error: unknown) => error);
			expect(response.status).toBe(400);
			expect(error).toBeInstanceOf(Error);
			expectRedacted({ body, message: (error as Error).message, stack: (error as Error).stack });
			if (code === "access_denied") expect((error as Error).message).toContain("access_denied");
		} finally {
			callback.close();
		}
	},
);
