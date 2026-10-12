// pi#150 redaction port: OAuth refresh/mint errors on v1.0.4 flows must not echo credential endpoint bodies.
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import { metaOAuth } from "../src/auth/oauth/meta.ts";
import { createRadiusOAuth } from "../src/auth/oauth/radius.ts";
import { xaiOAuth } from "../src/auth/oauth/xai.ts";
import type { OAuthAuth } from "../src/auth/types.ts";

const REFRESH = "PI150-REFRESH-TOKEN-SECRET-0123456789";
const ISSUED = "PI150-ISSUED-ACCESS-SECRET-0123456789";

afterEach(() => vi.unstubAllGlobals());

const providers: Array<[string, OAuthAuth]> = [
	["Anthropic", anthropicOAuth],
	["GitHub Copilot", githubCopilotOAuth],
	["Kimi Code", kimiCodingOAuth],
	["Meta", metaOAuth],
	["Radius", createRadiusOAuth({ name: "Radius", gateway: "https://radius.invalid" })],
	["xAI", xaiOAuth],
];

describe.each(providers)("%s refresh failure", (_name, oauth) => {
	it.each([400, 401, 500])("does not echo the endpoint body (HTTP %i)", async (status) => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				calls++;
				const body = {
					error: "invalid_grant",
					error_description: `refresh_token ${REFRESH} rejected; issued ${ISSUED}`,
					message: `refresh_token ${REFRESH}`,
					detail: ISSUED,
				};
				return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
			}),
		);
		const error = await oauth
			.refresh?.({ type: "oauth", access: "old", refresh: REFRESH, expires: 0 }, new AbortController().signal)
			.catch((e: unknown) => e);
		expect(calls).toBeGreaterThan(0);
		expect(error).toBeInstanceOf(Error);
		const text = JSON.stringify({ message: (error as Error).message, stack: (error as Error).stack });
		expect(text).not.toContain(REFRESH);
		expect(text).not.toContain(ISSUED);
	});
});
