import { afterEach, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";

const secret = "FAKE_TOKEN_127";
afterEach(() => vi.unstubAllGlobals());

// pi#127: response objects and malformed bytes can contain already-issued tokens.
it.each([
	[openaiCodexOAuth, JSON.stringify({ access_token: secret, refresh_token: secret })],
	[openaiCodexOAuth, `{"access_token":"${secret}",`],
	[anthropicOAuth, `{"access_token":"${secret}",`],
] as const)("keeps token decoder failures value-free", async (provider, body) => {
	vi.stubGlobal("fetch", async () => new Response(body, { status: 200 }));
	await expect(
		provider.refresh({ type: "oauth", access: "fake", refresh: "fake", expires: 0 }, new AbortController().signal),
	).rejects.toSatisfy((error: unknown) => error instanceof Error && !error.message.includes(secret));
});
