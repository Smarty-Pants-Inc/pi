import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import { createModels } from "../src/models.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";

const SECRET = "credential-secret-127";
const signal = new AbortController().signal;
const stages = [
	{
		name: "Codex initialization",
		endpoint: "/deviceauth/usercode",
		operation: "OpenAI Codex device code",
		fields: "device_auth_id, user_code or interval",
		partial: { device_auth_id: SECRET, user_code: SECRET, interval: "invalid" },
	},
	{
		name: "Codex polling",
		endpoint: "/deviceauth/token",
		operation: "OpenAI Codex device auth",
		fields: "authorization_code or code_verifier",
		partial: { authorization_code: SECRET },
	},
	{
		name: "Codex exchange",
		endpoint: "/oauth/token",
		operation: "OpenAI Codex token exchange",
		fields: "access_token, refresh_token or expires_in",
		partial: { access_token: SECRET },
	},
	{
		name: "Codex refresh",
		endpoint: "/oauth/token",
		operation: "OpenAI Codex token refresh",
		fields: "access_token, refresh_token or expires_in",
		partial: { access_token: SECRET },
	},
	{
		name: "ChatGPT exchange",
		endpoint: "/api/accounts/oauth/token",
		operation: "OpenAI OAuth token",
		fields: "refresh_token",
		partial: { access_token: SECRET, id_token: SECRET },
	},
	{
		name: "ChatGPT refresh",
		endpoint: "/api/accounts/oauth/token",
		operation: "OpenAI OAuth token",
		fields: "refresh_token",
		partial: { access_token: SECRET },
	},
];

// pi#127: exercise the ordinary Models.login receiver, not a private decoder.
describe.each(stages)("value-free credential diagnostics: $name", (stage) => {
	afterEach(() => vi.unstubAllGlobals());

	it.each(["partial", "malformed JSON", "HTTP error", "body error", "request error"])("redacts %s", async (kind) => {
		const chatGPT = stage.name.startsWith("ChatGPT");
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.endsWith(stage.endpoint)) {
				if (kind === "request error") throw new Error(SECRET);
				if (kind === "body error")
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.error(new Error(SECRET));
							},
						}),
					);
				if (kind === "HTTP error") return new Response(SECRET, { status: 500, statusText: SECRET });
				if (kind === "malformed JSON") return new Response(SECRET);
				return Response.json(stage.partial);
			}
			if (url.endsWith("/deviceauth/usercode"))
				return Response.json({ device_auth_id: SECRET, user_code: SECRET, interval: 0 });
			if (url.endsWith("/deviceauth/token"))
				return Response.json({ authorization_code: SECRET, code_verifier: SECRET });
			throw new Error(`Unexpected fetch URL: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ credentials });
		models.setProvider(chatGPT ? openaiProvider() : openaiCodexProvider());
		const providerId = chatGPT ? "openai" : "openai-codex";
		let authorizationUrl: URL | undefined;
		const operation = stage.name.endsWith("refresh")
			? (chatGPT ? openaiChatGPTOAuth : openaiCodexOAuth).refresh(
					{ type: "oauth", access: SECRET, refresh: SECRET, expires: 0, clientId: "oaiapp_test" },
					signal,
				)
			: models.login(
					providerId,
					"oauth",
					{
						signal,
						notify: (event) => {
							if (event.type === "auth_url") authorizationUrl = new URL(event.url);
						},
						prompt: async (prompt) => {
							if (prompt.type === "select") return "device_code";
							if (!authorizationUrl) throw new Error("Missing authorization URL");
							const callback = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
							callback.searchParams.set("code", SECRET);
							callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
							callback.searchParams.set("client_id", "oaiapp_test");
							return callback.toString();
						},
					},
					{ getDeviceId: () => "e61bbe28-07ef-466d-8e5d-a344f94ab305" },
				);
		const error: unknown = await operation.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).not.toContain(SECRET);
		if (["partial", "malformed JSON", "body error"].includes(kind)) {
			expect(message).toBe("oauth_invalid_response (HTTP 200)");
		} else if (kind === "HTTP error") {
			expect(message).toBe("oauth_request_failed (HTTP 500)");
		} else {
			expect(message).toBe("oauth_request_failed (HTTP unknown)");
		}
		expect(fetchMock).toHaveBeenCalled();
		expect(await credentials.read(providerId)).toBeUndefined();
	});
});

// pi#127: missing intervals and verifiers without companion codes must also stay private.
it.each(["initialization", "polling"])("redacts missing fields in %s through Models.login", async (stage) => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : String(input);
			return Response.json(
				url.endsWith("/usercode")
					? { device_auth_id: SECRET, user_code: SECRET, interval: stage === "initialization" ? undefined : 0 }
					: { code_verifier: SECRET },
			);
		}),
	);
	try {
		const models = createModels();
		models.setProvider(openaiCodexProvider());
		await expect(
			models.login("openai-codex", "oauth", { signal, prompt: async () => "device_code", notify: () => {} }),
		).rejects.toThrow("oauth_invalid_response (HTTP 200)");
	} finally {
		vi.unstubAllGlobals();
	}
});
