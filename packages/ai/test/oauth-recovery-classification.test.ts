import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { oauthDiagnosticError, oauthRecoveryDecision, safeOAuthError } from "../src/auth/oauth/credential-response.ts";
import { createModels } from "../src/models.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";

const marker = "UNKNOWN_RECOVERY_4703_PROVIDER_TEXT";

// smarty-dev#4703: discarded prose must not erase negative quota/overflow decisions either.
it("retains quota precedence over HTTP retry status and an allowlisted transient code", () => {
	const error = safeOAuthError(
		{ status: 503, error: { code: "server_error", message: `billing exhausted ${marker}` } },
		true,
	);
	expect(error.retryable).toBe(false);
	const message = {
		...fauxAssistantMessage([], { stopReason: "error", errorMessage: error.message }),
		oauthRecovery: oauthRecoveryDecision(error),
	};
	expect(isRetryableAssistantError(message)).toBe(false);
});

it("retains the overflow exclusion for rate limits even with an overflow code", () => {
	const error = safeOAuthError(
		{ status: 429, error: { code: "context_length_exceeded", message: `rate limit: too many tokens ${marker}` } },
		true,
	);
	expect(error.recovery).toBe("retryable");
	const message = {
		...fauxAssistantMessage([], { stopReason: "error", errorMessage: error.message }),
		oauthRecovery: oauthRecoveryDecision(error),
	};
	expect(isContextOverflow(message)).toBe(false);
	expect(isRetryableAssistantError(message)).toBe(true);
});

// smarty-dev#4703 F1/F2: recovery is a validated enum, not retained provider prose.
it.each([
	["fetch failed", "retryable"],
	["stream ended before a terminal response event", "premature_stream"],
	["prompt is too long: 123 tokens > 100 maximum", "context_length_exceeded"],
	["insufficient_quota", undefined],
	["subscription_sharing_usage_limit_exceeded", undefined],
	["billing: stream ended without completion", undefined],
])("classifies %s before dropping text", (text, expected) => {
	const error = safeOAuthError(new Error(`${text} ${marker}`), true);
	expect(error.recovery).toBe(expected);
	expect(error.message).not.toContain(marker);
	expect(error.stack).not.toContain(marker);
	expect(safeOAuthError(error).recovery).toBe(expected);
});

it.each([marker, "retryable\n", "context_length_exceeded ", {}, ["retryable"]])(
	"rejects unowned recovery %j",
	(recovery) => {
		const error = oauthDiagnosticError("oauth_request_failed", 400, undefined, recovery);
		expect(error.recovery).toBeUndefined();
		expect(error.message).toBe("oauth_request_failed (HTTP 400)");
		Object.assign(error, { recovery: marker });
		expect(safeOAuthError(error).recovery).toBeUndefined();
		expect(safeOAuthError(error).message).not.toContain(marker);
	},
);

const access = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "owned-account" } })).toString("base64url")}.synthetic`;
const eventResponse = (event: unknown) =>
	new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });

// smarty-dev#4703 F1: stream error code and message-only retry guidance both survive suppression.
describe.each([openaiProvider(), openaiCodexProvider()])("OAuth midstream recovery: $id", (provider) => {
	it.each(["subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable", "message-only"])(
		"retries %s",
		async (code) => {
			const credentials = new InMemoryCredentialStore();
			await credentials.modify(provider.id, async () => ({
				type: "oauth",
				access,
				refresh: "synthetic-refresh",
				expires: Date.now() + 3_600_000,
			}));
			const models = createModels({
				credentials,
				authContext: { env: async () => undefined, fileExists: async () => false },
			});
			models.setProvider(provider);
			let calls = 0;
			const output = await retryAssistantCall(
				() =>
					models.complete(
						provider.getModels()[0],
						{ messages: [] },
						{
							transport: "sse",
							maxRetries: 0,
							fetch: async () =>
								++calls > 1
									? eventResponse({
											type: "response.completed",
											response: { id: "owned", status: "completed", output: [] },
										})
									: eventResponse({
											type: "error",
											code: code === "message-only" ? undefined : code,
											message: `You can retry your request ${marker}`,
										}),
						},
					),
				{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
			);
			expect(calls).toBe(2);
			expect(output.stopReason).toBe("stop");
			expect(JSON.stringify(output)).not.toContain(marker);
		},
	);
});
