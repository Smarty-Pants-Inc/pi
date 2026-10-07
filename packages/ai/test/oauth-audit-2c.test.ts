import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazyStream, requestSetupError, SafeSetupError } from "../src/api/lazy.ts";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
} from "../src/api/openai-codex-responses.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { redactOAuthDiagnostic, redactOAuthDiagnosticValue } from "../src/auth/oauth/credential-response.ts";
import { createModels } from "../src/models.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import { retryAssistantCall } from "../src/utils/retry.ts";

const account = "AUDIT_2C_ACCOUNT_SYNTHETIC";
const access = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.SYNTHETIC_SIGNATURE`;
const refresh = 'AUDIT_2C_LIVE_REFRESH"SUFFIX';
const idToken = "AUDIT_2C_LIVE_ID_TOKEN";
const unknown = 'AUDIT_2C_PREFIX"AUDIT_2C_QUOTED_SECRET_SUFFIX';
const fragments = {
	"escaped-unicode-field": JSON.stringify(
		'{"refresh\\u005ftoken":"AUDIT_2C_UNKNOWN_REFRESH_ONLY_SYNTHETIC","code":"server_error"}',
	).slice(1, -1),
	"escaped-quoted-value": JSON.stringify(JSON.stringify({ refresh_token: unknown, code: "server_error" })).slice(
		1,
		-1,
	),
};
const secrets = [
	access,
	refresh,
	idToken,
	account,
	"AUDIT_2C_UNKNOWN_REFRESH_ONLY_SYNTHETIC",
	"AUDIT_2C_QUOTED_SECRET_SUFFIX",
];
function expectPrivate(value: unknown) {
	const text = JSON.stringify(value);
	for (const secret of secrets) {
		expect(text).not.toContain(secret);
		expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
		expect(text).not.toContain(encodeURIComponent(secret));
	}
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// pi#127 / audit-2c: probe counterexamples, not additional regex schedules.
describe("audit-2c causes", () => {
	it("masks overlapping values and keys before interpreting field shapes", () => {
		expect(redactOAuthDiagnostic("Bearer token", ["token", "Bearer token"])).toBe("***");
		expect(redactOAuthDiagnosticValue({ Authorization: "token" }, ["Authorization", "token"])).toEqual({
			"***": "***",
		});
	});
	it.each(Object.entries(fragments))("redacts %s with no known values", (_name, fragment) => {
		const text = redactOAuthDiagnostic(`503 server_error ${fragment}`);
		expectPrivate(text);
		expect(text).toContain("server_error");
	});
	it("finishes a 64 KiB adversarial slash run in less than 50 ms", () => {
		for (const suffix of ["X", '"refresh_tokenX']) {
			const input = "\\".repeat(65536) + suffix;
			const start = performance.now();
			expect(redactOAuthDiagnostic(input)).toBe(input);
			expect(performance.now() - start).toBeLessThan(50);
		}
	}, 30000);
	it.each(["constructor", "mutated-message", "prototype-trap", "property-trap"])(
		"makes %s value-free",
		async (kind) => {
			const model = openaiProvider().getModels()[0];
			const forged = Reflect.construct(SafeSetupError, ["stream", refresh]) as SafeSetupError;
			const error =
				kind === "prototype-trap"
					? new Proxy(
							{},
							{
								getPrototypeOf() {
									throw forged;
								},
							},
						)
					: kind === "property-trap"
						? new Proxy(forged, {
								get() {
									throw forged;
								},
							})
						: kind === "mutated-message"
							? Object.assign(requestSetupError(new Error()), { message: refresh })
							: forged;
			const stream = lazyStream(model, async () => {
				throw error;
			});
			expectPrivate(await stream.result());
		},
	);
	// pi#127: no credential-shaped keys are present in any of these diagnostics.
	it.each([openaiProvider(), openaiCodexProvider()])(
		"masks live values in observer, stop and retry sinks: $id",
		async (provider) => {
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
			const model = provider.getModels()[0];
			const diagnostic = JSON.stringify({ unrelated: [refresh, idToken, account, `Bearer ${access}`] });
			for (const observer of [false, true]) {
				const output = await models.completeSimple(
					model,
					{ messages: [] },
					{
						transport: "sse",
						maxRetries: 0,
						fetch: async () =>
							new Response(
								`data: ${JSON.stringify({ type: "response.incomplete", response: { id: "fake", status: "incomplete", output: [], incomplete_details: { reason: diagnostic } } })}\n\n`,
								{ headers: { "content-type": "text/event-stream" } },
							),
						onProviderStreamEvent: observer
							? () => {
									throw new Error(diagnostic);
								}
							: undefined,
					},
				);
				expect(output.stopReason).toBe("error");
				if (!observer) expect(output.rawStopReason).toBeDefined();
				expectPrivate(output);
				const records: unknown[] = [];
				await retryAssistantCall(
					async () => ({ ...output, errorMessage: `overloaded ${output.errorMessage}` }),
					{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
					undefined,
					{
						onRetryScheduled: (...args) => {
							records.push(args);
						},
						onRetryFinished: (...args) => {
							records.push(args);
						},
					},
				);
				expect(records).toHaveLength(observer ? 0 : 2);
				expectPrivate(records);
			}
		},
	);

	it("masks live values in WebSocket failures and stats", async () => {
		const diagnostic = JSON.stringify({ unrelated: [refresh, idToken, account, `Bearer ${access}`] });
		vi.stubGlobal(
			"WebSocket",
			class {
				constructor() {
					throw new Error(diagnostic);
				}
			},
		);
		const provider = openaiCodexProvider();
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
		try {
			const output = await models.complete(
				provider.getModels()[0],
				{ messages: [] },
				{
					transport: "auto",
					sessionId: "audit-2c-fake",
					env: {},
					fetch: async () =>
						new Response(
							`data: ${JSON.stringify({ type: "response.completed", response: { id: "fake", status: "completed", output: [] } })}\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						),
				},
			);
			expect(output.stopReason).toBe("stop");
			expect(output.diagnostics).toHaveLength(1);
			expectPrivate({ output, stats: getOpenAICodexWebSocketDebugStats("audit-2c-fake") });
		} finally {
			vi.unstubAllGlobals();
			closeOpenAICodexWebSocketSessions();
			resetOpenAICodexWebSocketDebugStats();
		}
	});
});

describe.each([openaiProvider(), openaiCodexProvider()])("audit-2c sinks: $id", (provider) => {
	it.each(["stream", "complete"] as const)("protects %s output, debug and serialized bytes", async (method) => {
		vi.stubEnv("OPENAI_LOG", "debug");
		const records: unknown[] = [];
		for (const level of ["debug", "info", "warn", "error"] as const)
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				records.push(args);
			});
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
		const model = provider.getModels()[0];
		for (const body of [
			...Object.values(fragments),
			JSON.stringify({ unrelated: [access, refresh, idToken, account, `Bearer ${access}`] }),
			encodeURIComponent(refresh),
		]) {
			const fetch = vi.fn(async () => new Response(`503 server_error ${body}`, { status: 503 }));
			const options = { transport: "sse" as const, maxRetries: 0, fetch };
			const output =
				method === "complete"
					? await models.complete(model, { messages: [] }, options)
					: await models.stream(model, { messages: [] }, options).result();
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(output.stopReason).toBe("error");
			expectPrivate({ output, records });
			expectPrivate(JSON.stringify({ type: "message", message: output }));
		}
		const fetch = vi.fn(async () => {
			throw new Error("Unexpected dispatch");
		});
		const output = await models.complete(
			model,
			{ messages: [] },
			{
				fetch,
				transformHeaders(headers) {
					throw new Proxy(
						{},
						{
							getPrototypeOf() {
								throw Reflect.construct(SafeSetupError, ["auth", JSON.stringify(headers)]);
							},
						},
					);
				},
			},
		);
		expect(fetch).not.toHaveBeenCalled();
		expectPrivate(output);
	});
});
