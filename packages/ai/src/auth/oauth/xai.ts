/**
 * xAI OAuth device-code flow.
 */

import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import {
	fetchOAuth,
	oauthDiagnosticError,
	readOAuthCredentialResponse,
	withOAuthDiagnostics,
} from "./credential-response.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
// Refresh slightly before the reported expiry to avoid using a token that dies mid-request.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

type JsonObject = Record<string, unknown>;

type OAuthHttpResponse = {
	ok: boolean;
	status: number;
	body: JsonObject;
};

type XaiDeviceCode = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	intervalSeconds?: number;
	expiresInSeconds: number;
};

function requiredString(body: JsonObject, field: string, status: number): string {
	const value = body[field];
	if (typeof value !== "string" || value.length === 0) {
		throw oauthDiagnosticError("oauth_invalid_response", status);
	}
	return value;
}

function positiveNumber(body: JsonObject, field: string, status: number): number {
	const value = body[field];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw oauthDiagnosticError("oauth_invalid_response", status);
	}
	return value;
}

// The verification URI is opened in the user's browser; force it to be an https URL
// so a malicious response cannot make `open` launch something else.
function validateVerificationUri(raw: string, status: number): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw oauthDiagnosticError("oauth_invalid_response", status);
	}
	if (url.protocol !== "https:") {
		throw oauthDiagnosticError("oauth_invalid_response", status);
	}
	return url.href;
}

async function postForm(url: string, fields: Record<string, string>, signal: AbortSignal): Promise<OAuthHttpResponse> {
	let response: Response;
	try {
		response = await fetchOAuth(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields),
			signal,
		});
	} catch (error) {
		if (signal.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	let body: JsonObject;
	try {
		const parsed = (await readOAuthCredentialResponse(response, "oauth")) as unknown;
		body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
	} catch {
		if (signal.aborted) {
			throw new Error("Login cancelled");
		}
		throw oauthDiagnosticError("oauth_invalid_response", response.status);
	}
	return {
		ok: response.ok,
		status: response.status,
		body,
	};
}

function requestFailure(_action: string, response: OAuthHttpResponse): Error {
	return oauthDiagnosticError("oauth_request_failed", response.status, response.body.error);
}

function parseDeviceCode(body: JsonObject, status: number): XaiDeviceCode {
	// RFC 8628 allows interval 0 (no minimum wait); fall back to the poller's
	// default instead of failing on non-positive or malformed values.
	const interval = body.interval;
	const intervalSeconds =
		typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : undefined;
	const verificationUriComplete =
		typeof body.verification_uri_complete === "string" && body.verification_uri_complete.length > 0
			? validateVerificationUri(body.verification_uri_complete, status)
			: undefined;
	return {
		deviceCode: requiredString(body, "device_code", status),
		userCode: requiredString(body, "user_code", status),
		verificationUri: validateVerificationUri(requiredString(body, "verification_uri", status), status),
		verificationUriComplete,
		intervalSeconds,
		expiresInSeconds: positiveNumber(body, "expires_in", status),
	};
}

function credentialsFromTokenResponse(
	body: JsonObject,
	previousRefreshToken: string | undefined,
	status: number,
): OAuthCredential {
	const access = requiredString(body, "access_token", status);
	// xAI may omit refresh_token on refresh when the token is not rotated.
	const refresh =
		body.refresh_token === undefined && previousRefreshToken
			? previousRefreshToken
			: requiredString(body, "refresh_token", status);
	const expiresInSeconds =
		body.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : positiveNumber(body, "expires_in", status);
	return {
		type: "oauth",
		access,
		refresh,
		expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
	};
}

async function requestDeviceCode(signal: AbortSignal): Promise<XaiDeviceCode> {
	const response = await postForm(
		XAI_DEVICE_CODE_URL,
		{
			client_id: XAI_CLIENT_ID,
			scope: XAI_SCOPE,
			referrer: "pi",
		},
		signal,
	);
	if (!response.ok) {
		throw requestFailure("device authorization", response);
	}
	return parseDeviceCode(response.body, response.status);
}

async function pollForTokens(device: XaiDeviceCode, signal: AbortSignal): Promise<OAuthCredential> {
	return pollOAuthDeviceCodeFlow<OAuthCredential>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const response = await postForm(
				XAI_TOKEN_URL,
				{
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					client_id: XAI_CLIENT_ID,
					device_code: device.deviceCode,
				},
				signal,
			);

			if (response.ok) {
				return {
					status: "complete",
					value: credentialsFromTokenResponse(response.body, undefined, response.status),
				};
			}

			const error = response.body.error;
			if (error === "authorization_pending") {
				return { status: "pending" };
			}
			if (error === "slow_down") {
				const interval = response.body.interval;
				return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : undefined };
			}
			if (error === "access_denied" || error === "authorization_denied") {
				return { status: "failed", error: oauthDiagnosticError("oauth_request_failed", response.status, error) };
			}
			if (error === "expired_token") {
				return { status: "failed", error: oauthDiagnosticError("oauth_request_failed", response.status, error) };
			}
			return { status: "failed", error: requestFailure("device token polling", response) };
		},
	});
}

async function loginXai(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const device = await requestDeviceCode(interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: device.userCode,
		verificationUri: device.verificationUriComplete ?? device.verificationUri,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	return pollForTokens(device, interaction.signal);
}

async function refreshXaiToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	const response = await postForm(
		XAI_TOKEN_URL,
		{
			grant_type: "refresh_token",
			client_id: XAI_CLIENT_ID,
			refresh_token: refreshToken,
		},
		signal,
	);
	if (!response.ok) {
		throw requestFailure("token refresh", response);
	}
	return credentialsFromTokenResponse(response.body, refreshToken, response.status);
}

export const xaiOAuth: OAuthAuth = withOAuthDiagnostics({
	name: "xAI (Grok/X subscription)",
	isSubscription: true,
	loginLabel: "Sign in with SuperGrok or X Premium",
	login: loginXai,
	refresh: (credential, signal) => refreshXaiToken(credential.refresh, signal),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
});
