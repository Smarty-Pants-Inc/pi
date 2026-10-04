/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import { runOAuthOperation } from "../../utils/bounded-response.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import {
	fetchOAuth,
	oauthDiagnosticError,
	oauthResponseError,
	readOAuthCredentialResponse,
	safeOAuthError,
	withOAuthDiagnostics,
} from "./credential-response.ts";
import { generatePKCE } from "./pkce.ts";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const COPY_CODE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const ANTHROPIC_BROWSER_LOGIN_METHOD = "browser";
const ANTHROPIC_COPY_CODE_LOGIN_METHOD = "copy_code";
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

async function postJson(url: string, body: Record<string, string | number>, signal: AbortSignal): Promise<string> {
	const response = await fetchOAuth(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});

	if (!response.ok) throw await oauthResponseError(response);
	const token = (await readOAuthCredentialResponse(response, "oauth")) as {
		access_token?: unknown;
		refresh_token?: unknown;
		expires_in?: unknown;
	} | null;
	if (
		typeof token?.access_token !== "string" ||
		!token.access_token ||
		typeof token.refresh_token !== "string" ||
		!token.refresh_token ||
		typeof token.expires_in !== "number" ||
		!Number.isFinite(token.expires_in) ||
		token.expires_in <= 0
	) {
		throw oauthDiagnosticError("oauth_invalid_response", response.status);
	}
	return JSON.stringify(token);
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				state,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			},
			signal,
		);
	} catch (error) {
		throw safeOAuthError(error);
	}

	let tokenData: { access_token: string; refresh_token: string; expires_in: number };
	try {
		tokenData = JSON.parse(responseBody) as { access_token: string; refresh_token: string; expires_in: number };
	} catch (error) {
		throw safeOAuthError(error);
	}

	return {
		type: "oauth",
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
	};
}

async function loginAnthropic(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const callback = await startOAuthCallbackServer({
		providerName: "Anthropic",
		host: CALLBACK_HOST,
		port: CALLBACK_PORT,
		path: CALLBACK_PATH,
		state: verifier,
		complete: async (code) => code,
		signal: interaction.signal,
	}).catch(() => undefined);

	try {
		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
		});
		interaction.notify({
			type: "auth_url",
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
			placeholder: REDIRECT_URI,
		});
		let code: string | undefined;
		let state = verifier;
		if (result.type === "callback") {
			code = result.value;
		} else {
			const parsed = parseAuthorizationInput(result.input);
			if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
			code = parsed.code;
			state = parsed.state ?? verifier;
		}

		if (!code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		return await exchangeAuthorizationCode(code, state, verifier, REDIRECT_URI, interaction.signal);
	} finally {
		callback?.close();
	}
}

async function loginAnthropicCopyCode(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: COPY_CODE_REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});
	interaction.notify({
		type: "auth_url",
		url: `${AUTHORIZE_URL}?${authParams.toString()}`,
		instructions: "Complete login in your browser, then copy the code Anthropic shows and paste it here.",
	});

	const input = await interaction.prompt({
		type: "manual_code",
		message: "Paste the code Anthropic shows after you sign in:",
		placeholder: "code#state",
		signal: interaction.signal,
	});
	const parsed = parseAuthorizationInput(input);
	if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
	if (!parsed.code) throw new Error("Missing authorization code");
	interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
	return await exchangeAuthorizationCode(
		parsed.code,
		parsed.state ?? verifier,
		verifier,
		COPY_CODE_REDIRECT_URI,
		interaction.signal,
	);
}

/**
 * Refresh Anthropic OAuth token
 */
async function refreshAnthropicToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refreshToken,
			},
			signal,
		);
	} catch (error) {
		throw safeOAuthError(error);
	}

	let data: { access_token: string; refresh_token: string; expires_in: number; scope?: string };
	try {
		data = JSON.parse(responseBody) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
			scope?: string;
		};
	} catch (error) {
		throw safeOAuthError(error);
	}

	return {
		type: "oauth",
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export const anthropicOAuth: OAuthAuth = withOAuthDiagnostics({
	name: "Anthropic (Claude Pro/Max)",
	isSubscription: true,

	login: (interaction) =>
		runOAuthOperation(interaction.signal, 5 * 60_000, async (signal) => {
			interaction = { ...interaction, signal };
			const method = await interaction.prompt({
				type: "select",
				signal: interaction.signal,
				message: "Select Anthropic login method:",
				options: [
					{ id: ANTHROPIC_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
					{ id: ANTHROPIC_COPY_CODE_LOGIN_METHOD, label: "Copy code login (headless)" },
				],
			});

			if (method === ANTHROPIC_COPY_CODE_LOGIN_METHOD) {
				return loginAnthropicCopyCode(interaction);
			}
			if (method !== ANTHROPIC_BROWSER_LOGIN_METHOD) {
				throw oauthDiagnosticError("oauth_request_failed");
			}

			return loginAnthropic(interaction);
		}),

	refresh: (credential, signal) =>
		runOAuthOperation(signal, 60_000, (ownedSignal) => refreshAnthropicToken(credential.refresh, ownedSignal)),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
});
