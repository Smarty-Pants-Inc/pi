import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import {
	OAuthDiagnosticError,
	oauthDiagnosticError,
	oauthProviderErrorCode,
	safeOAuthError,
} from "../src/auth/oauth/credential-response.ts";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import { metaOAuth } from "../src/auth/oauth/meta.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import { createRadiusOAuth } from "../src/auth/oauth/radius.ts";
import { xaiOAuth } from "../src/auth/oauth/xai.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";
import { kimiCodingProvider } from "../src/providers/kimi-coding.ts";
import { metaProvider } from "../src/providers/meta.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { openrouterProvider } from "../src/providers/openrouter.ts";
import { radiusProvider } from "../src/providers/radius.ts";
import { xaiProvider } from "../src/providers/xai.ts";

const canary = "UNIQUE_PROVIDER_BODY_CANARY_4703_NOT_A_CREDENTIAL";
const credential = {
	type: "oauth" as const,
	access: "synthetic-access",
	refresh: "synthetic-refresh",
	expires: 0,
	clientId: "oaiapp_test",
};
const signal = new AbortController().signal;
const flows = [
	anthropicOAuth,
	githubCopilotOAuth,
	kimiCodingOAuth,
	metaOAuth,
	openaiChatGPTOAuth,
	openaiCodexOAuth,
	createRadiusOAuth({ name: "Radius", gateway: "https://radius.invalid" }),
	xaiOAuth,
];
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// smarty-dev#4703 / pi#136: the provider body is not a secret and is never registered with the redactor.
describe.each(flows)("fixed OAuth refresh diagnostics: $name", (oauth) => {
	it.each(["HTTP", "SDK", "body reader", "partial success"])(
		"discards noncredential text from %s failures",
		async (kind) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					if (kind === "SDK") throw new Error(canary);
					if (kind === "partial success") return Response.json({ unrelated: canary });
					if (kind === "body reader")
						return new Response(
							new ReadableStream({
								start(controller) {
									controller.error(new Error(canary));
								},
							}),
							{ status: 403 },
						);
					return Response.json(
						{ error: "invalid_grant", error_description: canary, message: canary, unrelated: canary },
						{ status: 403, statusText: canary },
					);
				}),
			);
			const error: unknown = await oauth.refresh(credential, signal).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(OAuthDiagnosticError);
			expect(JSON.stringify(error)).not.toContain(canary);
			expect((error as Error).stack).not.toContain(canary);
			expect((error as Error).message).toContain(
				kind === "SDK" ? "HTTP unknown" : kind === "partial success" ? "HTTP 200" : "HTTP 403",
			);
		},
	);
});

// smarty-dev#4703 / pi#136: prove the ordinary login entry point still gives code + status.
it("shows an actionable fixed error through Models.login", async () => {
	const models = createModels();
	models.setProvider(openaiProvider());
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ error: "invalid_grant", error_description: canary }, { status: 403 })),
	);
	let authorize: URL | undefined;
	const error: unknown = await models
		.login(
			"openai",
			"oauth",
			{
				signal,
				notify(event) {
					if (event.type === "auth_url") authorize = new URL(event.url);
				},
				async prompt() {
					if (!authorize) throw new Error("Missing authorization URL");
					const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
					callback.searchParams.set("code", "synthetic-code");
					callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
					callback.searchParams.set("client_id", "oaiapp_test");
					return callback.href;
				},
			},
			{ getDeviceId: () => "e61bbe28-07ef-466d-8e5d-a344f94ab305" },
		)
		.catch((error: unknown) => error);
	expect((error as Error).message).toBe("oauth_request_failed (HTTP 403) provider_error=invalid_grant");
	expect(JSON.stringify(error)).not.toContain(canary);
});

// smarty-dev#4703 / pi#136: cover every additional OAuth-authenticated adapter, not just Codex/ChatGPT.
const inferenceProviders = [
	anthropicProvider(),
	githubCopilotProvider(),
	kimiCodingProvider(),
	metaProvider(),
	xaiProvider(),
	openrouterProvider(),
	radiusProvider(),
];
it.each(inferenceProviders)("discards provider body and SDK log text for $id inference", async (provider) => {
	vi.stubEnv("OPENAI_LOG", "debug");
	vi.stubEnv("ANTHROPIC_LOG", "debug");
	const records: unknown[] = [];
	for (const level of ["debug", "info", "warn", "error"] as const)
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			records.push(args);
		});
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(provider.id, async () => ({
		...credential,
		access: "sk-ant-oat-synthetic-access",
		expires: Date.now() + 3600000,
	}));
	const models = createModels({ credentials });
	models.setProvider(provider);
	const seen = new Set<string>();
	const catalog = provider.getModels();
	// Kimi has no bundled models in this candidate; use a synthetic model, not a network catalog fetch.
	const requestModels = catalog.length
		? catalog
		: [
				{
					...anthropicProvider().getModels()[0],
					id: "synthetic-kimi",
					provider: provider.id,
					baseUrl: provider.baseUrl ?? "https://api.kimi.com/coding",
				},
			];
	for (const model of requestModels) {
		if (seen.has(model.api)) continue;
		seen.add(model.api);
		const output = await models.complete(
			model,
			{ messages: [] },
			{
				transport: "sse",
				maxRetries: 0,
				fetch: async () =>
					Response.json(
						{ error: { code: "invalid_request", message: canary }, unrelated: canary },
						{ status: 403 },
					),
			},
		);
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("oauth_request_failed");
		expect(output.errorMessage).toContain("403");
		expect(JSON.stringify({ output, records })).not.toContain(canary);
	}
	expect(seen.size).toBeGreaterThan(0);
});

// smarty-dev#4703 / pi#136: syntax alone is not an allowlist, and branded errors must be rebuilt.
it("allowlists exact protocol codes and rebuilds mutated errors", () => {
	expect(oauthProviderErrorCode("invalid_grant")).toBe("invalid_grant");
	for (const code of [canary, "canary", "invalid_grant canary", "invalid_grant\n", "a".repeat(65)])
		expect(oauthProviderErrorCode(code)).toBeUndefined();
	const forged = Object.assign(oauthDiagnosticError("oauth_request_failed", 401), {
		message: canary,
		name: canary,
		stack: canary,
		cause: canary,
	});
	expect(safeOAuthError(forged).message).toBe("oauth_request_failed (HTTP 401)");
	expect(JSON.stringify(safeOAuthError(forged))).not.toContain(canary);
	expect(
		safeOAuthError(
			new Proxy(
				{},
				{
					get() {
						throw new Error(canary);
					},
				},
			),
		).message,
	).toBe("oauth_request_failed (HTTP unknown)");
});
