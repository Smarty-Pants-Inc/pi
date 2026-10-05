import { expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import { safeOAuthError } from "../src/auth/oauth/credential-response.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const access = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-r141-account" } })).toString("base64url")}.synthetic`;
const model: Model<"openai-codex-responses"> = {
	id: "synthetic",
	name: "Synthetic",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://mock.invalid",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};
const completed = () =>
	new Response(
		`data: ${JSON.stringify({ type: "response.completed", response: { id: "synthetic", status: "completed", output: [] } })}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);

// pi#141 / security F10: every retry layer obeys owned account/subscription refusal decisions.
it.each([
	["insufficient_quota", "quota exceeded"],
	["usage_limit_reached", "Monthly usage limit reached"],
	["subscription_sharing_usage_limit_exceeded", "reset later"],
	["usage_not_included", "account is not eligible"],
])("never replays terminal %s responses", async (code, message) => {
	const fetch = vi.fn(async () =>
		Response.json(
			{ error: { code, message: `${message}; UNTRUSTED_R141_LIMIT_BODY` } },
			{ status: 429, headers: { "retry-after-ms": "0" } },
		),
	);
	const eventStream = stream(model, normalizeContext({ messages: [] }), {
		apiKey: access,
		transport: "sse",
		maxRetries: 1,
		fetch,
	});
	const events: unknown[] = [];
	for await (const event of eventStream) events.push(event);
	const output = await eventStream.result();
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(output.stopReason).toBe("error");
	expect(output.oauthRecovery?.retryable).toBe(false);
	expect(JSON.stringify({ output, events })).not.toContain("UNTRUSTED_R141_LIMIT_BODY");
	expect(safeOAuthError({ status: 429, error: { code } }, true).retryable).toBe(false);
});

it("retains inner retry for a real transport failure, without using diagnostic presentation text", async () => {
	let attempts = 0;
	const fetch = vi.fn(async () => {
		if (++attempts === 1) throw new Error("fetch failed");
		return completed();
	});
	const output = await stream(model, normalizeContext({ messages: [] }), {
		apiKey: access,
		transport: "sse",
		maxRetries: 1,
		fetch,
	}).result();
	expect(output.stopReason).toBe("stop");
	expect(fetch).toHaveBeenCalledTimes(2);
});
