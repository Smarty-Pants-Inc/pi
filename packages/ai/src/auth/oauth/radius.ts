/**
 * Radius gateway OAuth flow.
 *
 * Radius is a pi-messages gateway. OAuth client APIs live on the configured
 * gateway; only the interactive browser authorization endpoint is discovered.
 * Model catalog loading is owned by the Radius provider.
 *
 * NOTE: This module uses node:http (via callback-server.ts) for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import { normalizeRadiusGatewayUrl } from "../../providers/radius-config.ts";
import { fetchOAuthResponse, runOAuthOperation } from "../../utils/bounded-response.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer } from "./callback-server.ts";
import { readOAuthCredentialResponse } from "./credential-response.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { generatePKCE } from "./pkce.ts";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 1456;
const CALLBACK_PATH = "/oauth/callback";
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const LOGIN_METHOD_BROWSER = "browser";
const LOGIN_METHOD_DEVICE_CODE = "device-code";
const OAUTH_CLIENT_ID = "pi-gateway";
const OAUTH_SCOPE = "gateway offline_access";
const OAUTH_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type RadiusOAuthDiscovery = {
	authorizationEndpoint: string;
};

type DeviceAuthorizationResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval?: number;
};

async function loadRadiusOAuthDiscovery(gateway: string, signal: AbortSignal): Promise<RadiusOAuthDiscovery> {
	const response = await fetchOAuthResponse(new URL("/v1/oauth", gateway), {
		headers: { accept: "application/json" },
		signal,
	});

	if (!response.ok) {
		throw new Error(`Radius OAuth config request failed (HTTP ${response.status})`);
	}

	const discovery = (await readOAuthCredentialResponse(response, "Radius OAuth")) as Partial<RadiusOAuthDiscovery>;
	if (typeof discovery.authorizationEndpoint !== "string") {
		throw new Error("Invalid Radius OAuth config fields");
	}
	return { authorizationEndpoint: discovery.authorizationEndpoint };
}

class OAuthResponseError extends Error {
	readonly status: number;
	readonly oauthError?: string;

	constructor(status: number, oauthError: string | undefined, message: string) {
		super(`${message} (HTTP ${status})`);
		this.status = status;
		this.oauthError = oauthError;
	}
}

async function readOAuthResponseError(response: Response, message: string): Promise<OAuthResponseError> {
	const text = await response.text().catch(() => "");
	let oauthError: string | undefined;

	if (text) {
		try {
			const data = JSON.parse(text) as { error?: unknown; error_description?: unknown };
			oauthError = [
				"authorization_pending",
				"slow_down",
				"expired_token",
				"access_denied",
				"invalid_grant",
			].includes(String(data.error))
				? String(data.error)
				: undefined;
		} catch {
			// An invalid OAuth error body has no safe protocol code.
		}
	}

	return new OAuthResponseError(response.status, oauthError, message);
}

async function requestOAuthToken(
	gateway: string,
	body: URLSearchParams,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	let response: Response;
	try {
		response = await fetchOAuthResponse(new URL("/v1/oauth/token", gateway), {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body,
			signal,
		});
	} catch (error) {
		if (signal.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	if (!response.ok) {
		throw await readOAuthResponseError(response, "Radius OAuth token request failed");
	}

	const data = (await readOAuthCredentialResponse(response, "Radius OAuth")) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		scope?: string;
	};

	return {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token,
		expires: Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_SKEW_MS,
		scope: data.scope,
	};
}

async function loginWithBrowser(
	gateway: string,
	authorizationEndpoint: string,
	interaction: ProviderAuthInteraction,
): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	let authorizeUrl: URL;
	try {
		authorizeUrl = new URL(authorizationEndpoint);
	} catch {
		throw new Error("Invalid Radius OAuth authorization endpoint");
	}
	authorizeUrl.search = new URLSearchParams({
		response_type: "code",
		client_id: OAUTH_CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		scope: OAUTH_SCOPE,
		code_challenge: challenge,
		code_challenge_method: "S256",
		handoff: "url",
		state,
	}).toString();

	const callback = await startOAuthCallbackServer({
		providerName: "Radius",
		host: CALLBACK_HOST,
		port: CALLBACK_PORT,
		path: CALLBACK_PATH,
		state,
		complete: (code, signal) =>
			requestOAuthToken(
				gateway,
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: OAUTH_CLIENT_ID,
					redirect_uri: REDIRECT_URI,
					code,
					code_verifier: verifier,
				}),
				signal,
			),
		signal: interaction.signal,
	});
	interaction.notify({ type: "progress", message: `Listening for OAuth callback on ${REDIRECT_URI}` });
	interaction.notify({
		type: "auth_url",
		url: authorizeUrl.toString(),
		instructions: "Continue in your browser.",
	});

	try {
		const credential = await callback.wait();
		if (!credential) throw new Error("OAuth callback did not complete.");
		return credential;
	} finally {
		callback.close();
	}
}

async function requestDeviceAuthorization(gateway: string, signal: AbortSignal): Promise<DeviceAuthorizationResponse> {
	let response: Response;
	try {
		response = await fetchOAuthResponse(new URL("/v1/oauth/device", gateway), {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE }),
			signal,
		});
	} catch (error) {
		if (signal.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	if (!response.ok) {
		throw await readOAuthResponseError(response, "Radius OAuth device authorization failed");
	}

	const data = (await readOAuthCredentialResponse(response, "Radius OAuth")) as Partial<DeviceAuthorizationResponse>;
	if (!data.device_code || !data.user_code || !data.verification_uri || !data.expires_in) {
		throw new Error("Radius OAuth device authorization response is missing required fields");
	}

	return {
		device_code: data.device_code,
		user_code: data.user_code,
		verification_uri: data.verification_uri,
		expires_in: data.expires_in,
		interval: data.interval,
	};
}

async function loginWithDeviceCode(gateway: string, interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const device = await requestDeviceAuthorization(gateway, interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: device.user_code,
		verificationUri: device.verification_uri,
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
	});

	return pollOAuthDeviceCodeFlow<OAuthCredential>({
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
		signal: interaction.signal,
		poll: async () => {
			try {
				const credentials = await requestOAuthToken(
					gateway,
					new URLSearchParams({
						grant_type: OAUTH_DEVICE_CODE_GRANT_TYPE,
						client_id: OAUTH_CLIENT_ID,
						device_code: device.device_code,
					}),
					interaction.signal,
				);
				return { status: "complete", value: credentials };
			} catch (error) {
				if (!(error instanceof OAuthResponseError)) {
					throw error;
				}
				switch (error.oauthError) {
					case "authorization_pending":
						return { status: "pending" };
					case "slow_down":
						return { status: "slow_down" };
					case "expired_token":
						return { status: "failed", message: "Device authorization expired." };
					case "access_denied":
						return { status: "failed", message: "Device authorization was denied." };
					default:
						throw error;
				}
			}
		},
	});
}

export interface RadiusOAuthOptions {
	name: string;
	gateway: string;
}

export function createRadiusOAuth(options: RadiusOAuthOptions): OAuthAuth {
	const gateway = normalizeRadiusGatewayUrl(options.gateway);

	return {
		name: options.name,

		login: (interaction) =>
			runOAuthOperation(interaction.signal, 15 * 60_000, async (signal): Promise<OAuthCredential> => {
				interaction = { ...interaction, signal };
				const loginMethod = await interaction.prompt({
					type: "select",
					signal: interaction.signal,
					message: `Sign in to ${options.name}:`,
					options: [
						{ id: LOGIN_METHOD_BROWSER, label: "Sign in with browser (recommended)" },
						{
							id: LOGIN_METHOD_DEVICE_CODE,
							label: "Sign in with device code (when signing in from another device)",
						},
					],
				});

				if (loginMethod === LOGIN_METHOD_DEVICE_CODE) {
					return loginWithDeviceCode(gateway, interaction);
				}
				if (loginMethod === LOGIN_METHOD_BROWSER) {
					const discovery = await loadRadiusOAuthDiscovery(gateway, interaction.signal);
					return loginWithBrowser(gateway, discovery.authorizationEndpoint, interaction);
				}
				throw new Error("Unknown Radius sign-in method");
			}),

		async refresh(credential, signal): Promise<OAuthCredential> {
			const refreshed = await runOAuthOperation(signal, 60_000, (ownedSignal) =>
				requestOAuthToken(
					gateway,
					new URLSearchParams({
						grant_type: "refresh_token",
						client_id: OAUTH_CLIENT_ID,
						refresh_token: credential.refresh,
					}),
					ownedSignal,
				),
			);
			return refreshed;
		},

		async toAuth(credential) {
			return { apiKey: credential.access };
		},
	};
}
