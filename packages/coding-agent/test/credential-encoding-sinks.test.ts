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

const account = "FAKE_ENCODING_ACCOUNT_127";
const access = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } }),
).toString("base64url")}.FAKE_SIGNATURE_127`;
const refresh = 'FAKE_ENCODING_REFRESH_127_"Q\\S/+=?%';
const idToken = 'FAKE_ENCODING_ID_127_"Q\\S/+=?%';
const original = "FAKE_ENCODING_ORIGINAL_127";
const transformed = "FAKE_ENCODING_TRANSFORMED_127";

function escaped(value: string, depth: number): string {
	for (let i = 0; i < depth; i++) value = JSON.stringify(value).slice(1, -1);
	return value;
}

const variants = [
	// smarty-dev#4703 / pi#136: this is NOT a credential or a redactor input.
	{
		name: "noncredential-provider-body-canary",
		body: "UNIQUE_PROVIDER_BODY_CANARY_4703_NOT_A_CREDENTIAL",
		secrets: ["UNIQUE_PROVIDER_BODY_CANARY_4703_NOT_A_CREDENTIAL"],
	},
	{ name: "bare-headers", body: `receipt=${original} ${transformed}`, secrets: [original, transformed] },
	{
		name: "url",
		body: `receipt=${encodeURIComponent(refresh)} ${encodeURIComponent(idToken)}`,
		secrets: [refresh, idToken],
	},
	{ name: "json-depth2", body: `receipt=${escaped(refresh, 2)} ${escaped(idToken, 2)}`, secrets: [refresh, idToken] },
	{ name: "json-depth8", body: `receipt=${escaped(refresh, 8)} ${escaped(idToken, 8)}`, secrets: [refresh, idToken] },
	{ name: "json-depth9", body: `receipt=${escaped(refresh, 9)} ${escaped(idToken, 9)}`, secrets: [refresh, idToken] },
	{
		name: "base64-in-json",
		body: JSON.stringify({
			unrelated: [Buffer.from(refresh).toString("base64"), Buffer.from(idToken).toString("base64")],
		}),
		secrets: [refresh, idToken],
	},
	{
		name: "substring",
		body: `receipt=XWORD${original}YWORD XWORD${transformed}YWORD`,
		secrets: [original, transformed],
	},
	{
		name: "case-varied-bearer",
		body: `receipt=bEaReR ${original} BeArEr ${transformed}`,
		secrets: [original, transformed],
	},
	{ name: "split-body-chunks", body: `receipt=${refresh} ${idToken}`, secrets: [refresh, idToken] },
];

function expectPrivate(sinks: Record<string, unknown>, secrets: readonly string[]): void {
	const strings = (value: unknown): string[] => {
		if (typeof value === "string") return [value];
		if (Array.isArray(value)) return value.flatMap(strings);
		if (value && typeof value === "object")
			return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
		return [];
	};
	for (const [sink, value] of Object.entries(sinks)) {
		for (const secret of secrets) {
			const representations = [
				...Array.from({ length: 14 }, (_, depth) => escaped(secret, depth)),
				encodeURIComponent(secret),
				Buffer.from(secret).toString("base64"),
				Buffer.from(secret).toString("base64url"),
			];
			for (const text of strings(value))
				for (const representation of representations) expect(text, sink).not.toContain(representation);
		}
	}
}

function persist(output: AssistantMessage): string {
	const root = mkdtempSync(join(tmpdir(), "credential-encoding-127-"));
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

function responseBody(text: string, status: number, type: string, chunked: boolean): Response {
	if (!chunked) return new Response(text, { status, headers: { "content-type": type } });
	const bytes = new TextEncoder().encode(text);
	let i = 0;
	return new Response(
		new ReadableStream({
			pull(controller) {
				if (i >= bytes.length) {
					controller.close();
					return;
				}
				const next = Math.min(bytes.length, i + 7);
				controller.enqueue(bytes.slice(i, next));
				i = next;
			},
		}),
		{ status, headers: { "content-type": type } },
	);
}

function sse(type: string, reason?: string): string {
	return `data: ${JSON.stringify({ type, response: { id: "fake-encoding", status: reason ? "incomplete" : "completed", output: [], incomplete_details: reason ? { reason } : undefined } })}\n\n`;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
});

// pi#127 / round-4: durable version of the auditor's 151 qualified fresh-sinks cases.
const cases = [openaiProvider(), openaiCodexProvider()].flatMap((provider) =>
	["stream", "complete"].flatMap((method) =>
		variants.flatMap((variant) =>
			["HTTP", "JSON HTTP", "observer", "stop"].map((kind) => ({ provider, method, variant, kind })),
		),
	),
);

describe("live credential encoding sinks", () => {
	it.each(cases)("$provider.id $method $variant.name $kind", async ({ provider, method, variant, kind }) => {
		vi.stubEnv("OPENAI_LOG", "debug");
		const records: unknown[] = [];
		for (const level of ["debug", "info", "warn", "error"] as const)
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				records.push(args);
			});
		const { models, model } = await runtime(provider);
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe(
				provider.id === "openai" ? `BeArEr ${transformed}` : `Bearer ${access}`,
			);
			const chunked = variant.name === "split-body-chunks";
			if (kind === "HTTP") return responseBody(`503 server_error ${variant.body}`, 503, "text/plain", chunked);
			if (kind === "JSON HTTP")
				return responseBody(
					JSON.stringify({ error: { code: "server_error", message: `server_error ${variant.body}` } }),
					503,
					"application/json",
					chunked,
				);
			return responseBody(sse("response.incomplete", variant.body), 200, "text/event-stream", chunked);
		});
		const options = {
			transport: "sse" as const,
			maxRetries: 0,
			env: {},
			headers: { Authorization: `bEaReR ${original}` },
			transformHeaders: (headers: Record<string, string | null>) => ({
				...headers,
				Authorization: `BeArEr ${transformed}`,
			}),
			fetch: fetchMock,
			onProviderStreamEvent:
				kind === "observer"
					? () => {
							const error = new Error(variant.body);
							error.name = variant.body;
							Object.assign(error, { code: variant.body });
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
		if (provider.id === "openai") expect(records.length).toBeGreaterThan(0);
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
		expectPrivate(
			{
				errorMessage: output.errorMessage,
				sdkLogger: records,
				retryObservers,
				streamObserver: output.diagnostics,
				rawStopReason: output.rawStopReason,
				output,
				events,
				sessionJSONL: persist(output),
			},
			variant.secrets,
		);
	});

	// The two supplied-header controls never send those headers via WebSocket; exclude them as in the audit.
	it.each(variants.filter((variant) => !["bare-headers", "substring"].includes(variant.name)))(
		"WebSocket $name diagnostics, stats and successful fallback JSONL",
		async (variant) => {
			const websocket = vi.fn();
			vi.stubGlobal(
				"WebSocket",
				class {
					constructor(_url: string, options: { headers: Record<string, string> }) {
						websocket();
						expect(options.headers.authorization).toBe(`Bearer ${access}`);
						throw new Error(variant.body);
					}
				},
			);
			const { models, model } = await runtime(openaiCodexProvider());
			const fetchMock = vi.fn(async () => responseBody(sse("response.completed"), 200, "text/event-stream", false));
			const sessionId = `fake-encoding-${variant.name}`;
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
			expectPrivate(
				{ websocketDiagnostics: output.diagnostics, websocketStats: stats, sessionJSONL: persist(output) },
				variant.secrets,
			);
		},
	);
});
