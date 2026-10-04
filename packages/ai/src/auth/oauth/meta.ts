/**
 * Meta Model API OAuth flow
 *
 * RFC 8628 device authorization grant against https://auth.meta.com (JSON
 * responses). Meta splits identity from API access: the resulting identity
 * token is not accepted for inference, so it is exchanged for a Model API
 * key via the Muse Code key-mint endpoint (minted keys live about a day).
 * The identity token is stored as `refresh` and the minted key as `access`,
 * so the standard OAuth scheduler re-mints the key when it expires with no
 * bespoke renewal machinery. The identity token itself is not renewable
 * (auth.meta.com answers grant_type=refresh_token with 404 and issues no
 * refresh_token), so a 401/403 from mint means the session is dead and the
 * user must sign in again.
 */

import { runOAuthOperation } from "../../utils/bounded-response.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import {
	fetchOAuth,
	oauthDiagnosticError,
	readOAuthCredentialResponse,
	withOAuthDiagnostics,
} from "./credential-response.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

// Muse Code CLI client id.
const CLIENT_ID = "1031625952748946";
const AUTH_HOST = "https://auth.meta.com";
const DEVICE_AUTHORIZATION_URL = `${AUTH_HOST}/oidc/device/authorization/`;
const DEVICE_TOKEN_URL = `${AUTH_HOST}/oidc/device/token/`;
const API_KEY_MINT_URL = "https://api.meta.ai/muse-code/key";
const API_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;

type DeviceAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
};

function requestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const json = await readOAuthCredentialResponse(response, "oauth");
		return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** The verification URI is opened in the user's browser; only http(s) URLs are trusted. */
function trustedHttpUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.href;
	} catch {
		return null;
	}
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function startDeviceAuthorization(signal: AbortSignal): Promise<DeviceAuthorization> {
	const response = await fetchOAuth(DEVICE_AUTHORIZATION_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
		signal: requestSignal(signal),
	});
	const json = await readJson(response);
	if (!response.ok) {
		throw oauthDiagnosticError("oauth_request_failed", response.status, json?.error);
	}
	const deviceCode = json?.device_code;
	const userCode = json?.user_code;
	const verificationUri = trustedHttpUrl(json?.verification_uri_complete) ?? trustedHttpUrl(json?.verification_uri);
	if (typeof deviceCode !== "string" || !deviceCode || typeof userCode !== "string" || !userCode || !verificationUri) {
		throw oauthDiagnosticError("oauth_invalid_response", response.status);
	}
	return {
		deviceCode,
		userCode,
		verificationUri,
		intervalSeconds: positiveNumber(json?.interval),
		expiresInSeconds: positiveNumber(json?.expires_in),
	};
}

async function pollForIdentityToken(device: DeviceAuthorization, signal: AbortSignal): Promise<string> {
	return pollOAuthDeviceCodeFlow<string>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const response = await fetchOAuth(DEVICE_TOKEN_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: device.deviceCode,
					client_id: CLIENT_ID,
				}).toString(),
				signal: requestSignal(signal),
			});
			const json = await readJson(response);
			if (response.ok && typeof json?.access_token === "string" && json.access_token) {
				return { status: "complete", value: json.access_token };
			}
			switch (json?.error) {
				case "authorization_pending":
					return { status: "pending" };
				case "slow_down":
					return { status: "slow_down", intervalSeconds: positiveNumber(json?.interval) };
				case "access_denied":
					return {
						status: "failed",
						error: oauthDiagnosticError("oauth_request_failed", response.status, json?.error),
					};
				case "expired_token":
					return {
						status: "failed",
						error: oauthDiagnosticError("oauth_request_failed", response.status, json?.error),
					};
				default:
					return {
						status: "failed",
						error: oauthDiagnosticError("oauth_request_failed", response.status, json?.error),
					};
			}
		},
	});
}

/** Exchange an identity token for a Model API key. Keys are valid for about a day. */
async function mintApiKey(identityToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	const response = await fetchOAuth(API_KEY_MINT_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${identityToken}`,
			"Content-Type": "application/json",
			"x-api-version": "1.0.0",
		},
		body: "{}",
		signal: requestSignal(signal),
	});
	const json = await readJson(response);
	if (response.status === 401 || response.status === 403) {
		// Identity token is not renewable (see file header); only a fresh device flow helps.
		throw oauthDiagnosticError("oauth_request_failed", response.status, json?.error);
	}
	if (!response.ok) {
		throw oauthDiagnosticError("oauth_request_failed", response.status, json?.error);
	}
	const apiKey = json?.api_key;
	if (typeof apiKey !== "string" || !apiKey) {
		throw oauthDiagnosticError("oauth_invalid_response", response.status);
	}
	return { type: "oauth", refresh: identityToken, access: apiKey, expires: Date.now() + API_KEY_LIFETIME_MS };
}

async function loginMeta(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	try {
		const device = await startDeviceAuthorization(interaction.signal);
		interaction.notify({
			type: "device_code",
			userCode: device.userCode,
			verificationUri: device.verificationUri,
			intervalSeconds: device.intervalSeconds,
			expiresInSeconds: device.expiresInSeconds,
		});
		const identityToken = await pollForIdentityToken(device, interaction.signal);
		interaction.notify({ type: "progress", message: "Enabling Meta Model API access..." });
		return await mintApiKey(identityToken, interaction.signal);
	} catch (e) {
		// An in-flight fetch rejects with a DOMException on abort; the login UI matches on this message.
		if (interaction.signal.aborted) throw new Error("Login cancelled");
		throw e;
	}
}

export const metaOAuth: OAuthAuth = withOAuthDiagnostics({
	name: "Meta (Muse subscription)",
	isSubscription: true,
	loginLabel: "Sign in with Meta",

	login: (interaction) =>
		runOAuthOperation(interaction.signal, 15 * 60_000, (signal) => loginMeta({ ...interaction, signal })),

	refresh: (credential, signal) =>
		runOAuthOperation(signal, 60_000, (ownedSignal) => mintApiKey(credential.refresh, ownedSignal)),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
});
