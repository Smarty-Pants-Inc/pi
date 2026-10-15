// smarty-dev#4703: the credential diagnostic boundary must withhold provider text, not enumerate encodings.
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import {
	createRedactingSdkLogger,
	oauthAuthorizationError,
	readOAuthCredentialResponse,
} from "../src/auth/oauth/credential-response.ts";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import { metaOAuth } from "../src/auth/oauth/meta.ts";
import { createRadiusOAuth } from "../src/auth/oauth/radius.ts";
import { xaiOAuth } from "../src/auth/oauth/xai.ts";
import type { OAuthAuth } from "../src/auth/types.ts";
import { formatProviderError, normalizeProviderError } from "../src/utils/error-body.ts";

const secret = 'Q7:/+Z9"';
const encode = (value: string) => Buffer.from(value).toString("base64");
const forms = [
	["Base64(JSON)", encode(JSON.stringify(secret))],
	["Base64(percent)", encode(encodeURIComponent(secret))],
	...[0, 1, 2].map((offset) => [`Base64(payload offset ${offset})`, encode(`${"x".repeat(offset)}${secret}suffix`)]),
	["triple Base64", encode(encode(encode(secret)))],
];
const levels = ["error", "warn", "info", "debug"] as const;
const signal = new AbortController().signal;
const radius = createRadiusOAuth({ name: "Radius", gateway: "https://radius.invalid" });
const providers: [string, OAuthAuth][] = [
	["Anthropic", anthropicOAuth],
	["GitHub Copilot", githubCopilotOAuth],
	["Kimi Code", kimiCodingOAuth],
	["Meta", metaOAuth],
	["Radius", radius],
	["xAI", xaiOAuth],
];
const serialized = (error: unknown) => inspect(error, { showHidden: true, depth: 10 });

async function failure(promise: Promise<unknown>): Promise<Error> {
	const error = await promise.catch((error: unknown) => error);
	expect(error).toBeInstanceOf(Error);
	return error as Error;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("owned credential sink messages", () => {
	it.each(forms)("withholds %s from every SDK log level without inspecting arguments", (_name, alias) => {
		const text = `provider-receipt=${alias}`;
		const logger = createRedactingSdkLogger([secret]);
		let inspected = false;
		const hostile = {
			get receipt() {
				inspected = true;
				throw new Error(text);
			},
		};
		for (const level of levels) {
			const sink = vi.spyOn(console, level).mockImplementation(() => {});
			logger[level](text, { receipt: text }, new Error(text, { cause: text }), hostile);
			expect(sink.mock.calls).toEqual([[`openai sdk ${level}: message withheld`]]);
			expect(JSON.stringify(sink.mock.calls)).not.toContain(text);
			expect(JSON.stringify(sink.mock.calls)).not.toContain(alias);
			sink.mockRestore();
		}
		expect(inspected).toBe(false);
	});

	it.each(["openai", "azure-openai", "openrouter"] as const)("logs only the owned %s SDK label", (provider) => {
		const sink = vi.spyOn(console, "error").mockImplementation(() => {});
		createRedactingSdkLogger([secret], provider).error("provider body", { url: `https://echo.invalid/?q=${secret}` });
		expect(sink.mock.calls).toEqual([[`${provider} sdk error: message withheld`]]);
	});

	it("retains live-value masking as defense in depth for owned SDK lines", () => {
		const sink = vi.spyOn(console, "error").mockImplementation(() => {});
		createRedactingSdkLogger(["openai"]).error("provider text");
		expect(sink.mock.calls).toEqual([["*** sdk error: message withheld"]]);
	});

	it.each(forms)("withholds %s from parser and body-reader failures", async (_name, alias) => {
		const text = `provider-receipt=${alias}`;
		for (const response of [
			new Response(text),
			new Response(new ReadableStream({ start: (controller) => controller.error(new Error(text)) })),
		]) {
			const error = await failure(readOAuthCredentialResponse(response, "OpenAI OAuth token"));
			expect(error.message).toBe("OpenAI OAuth token response is invalid JSON");
			expect(serialized(error)).not.toContain(text);
			expect(serialized(error)).not.toContain(alias);
		}
	});

	describe.each(providers)("%s refresh", (_provider, oauth) => {
		it.each(forms)("withholds the entire %s provider diagnostic", async (_name, alias) => {
			const text = `provider-receipt=${alias}`;
			const fetch = vi.fn(async () =>
				Response.json({ error: text, error_description: text, message: text }, { status: 401 }),
			);
			vi.stubGlobal("fetch", fetch);
			const error = await failure(
				oauth.refresh({ type: "oauth", access: secret, refresh: secret, expires: 0 }, signal),
			);
			expect(fetch).toHaveBeenCalled();
			expect(serialized(error)).not.toContain(text);
			expect(serialized(error)).not.toContain(alias);
			expect(serialized(error)).not.toContain(secret);
		});

		it.each(forms)("withholds the entire %s native request diagnostic", async (_name, alias) => {
			const text = `provider-receipt=${alias}`;
			let calls = 0;
			const fetch = vi.fn(async () => {
				if (++calls === 1) throw new Error(text, { cause: new Error(text) });
				return Response.json({ error: text }, { status: 401 });
			});
			vi.stubGlobal("fetch", fetch);
			const error = await failure(
				oauth.refresh({ type: "oauth", access: secret, refresh: secret, expires: 0 }, signal),
			);
			expect(fetch).toHaveBeenCalled();
			expect(serialized(error)).not.toContain(text);
			expect(serialized(error)).not.toContain(alias);
		});
	});

	it.each(forms)("withholds %s in Radius discovery and Meta setup diagnostics", async (_name, alias) => {
		const text = `provider-receipt=${alias}`;
		const fetch = vi.fn(async () => new Response(text, { status: 401 }));
		vi.stubGlobal("fetch", fetch);
		const error = await failure(radius.login({ signal, prompt: async () => "browser", notify: () => {} }));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(error.message).toBe("Could not load Radius OAuth config (HTTP 401)");
		expect(serialized(error)).not.toContain(alias);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ action_url: `https://echo.invalid/${alias}?receipt=${alias}` })),
		);
		const setup = await failure(
			metaOAuth.refresh({ type: "oauth", access: secret, refresh: secret, expires: 0 }, signal),
		);
		expect(setup.message).toBe("Meta did not issue an API key. Complete setup at https://dev.meta.ai/billing");
		expect(serialized(setup)).not.toContain(alias);
	});

	it.each(forms)("withholds %s in Anthropic native request errors", async (_name, alias) => {
		const text = `provider-receipt=${alias}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error(text, { cause: new Error(text) });
			}),
		);
		const error = await failure(
			anthropicOAuth.refresh({ type: "oauth", access: secret, refresh: secret, expires: 0 }, signal),
		);
		expect(error.message).toBe("Anthropic token refresh request failed.");
		expect(serialized(error)).not.toContain(alias);
	});

	it("keeps Radius polling decisions private when a short device credential overlaps a protocol class", async () => {
		vi.useFakeTimers();
		let polls = 0;
		const fetch = vi.fn(async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.endsWith("/v1/oauth/device")) {
				return Response.json({
					device_code: "pending",
					user_code: "CODE",
					verification_uri: "https://radius.invalid/device",
					expires_in: 60,
					interval: 1,
				});
			}
			return ++polls === 1
				? Response.json({ error: "authorization_pending" }, { status: 400 })
				: Response.json({ access_token: "issued", refresh_token: "refreshed", expires_in: 60 });
		});
		vi.stubGlobal("fetch", fetch);
		const result = radius
			.login({ signal, prompt: async () => "device-code", notify: () => {} })
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(2000);
		expect(await result).toMatchObject({ type: "oauth", access: "issued", refresh: "refreshed" });
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(polls).toBe(2);
	});

	it("allows only closed protocol classes that do not contain a known credential", () => {
		expect(oauthAuthorizationError("invalid_grant")).toBe("invalid_grant");
		expect(oauthAuthorizationError("invalid_grant", ["invalid_grant"])).toBe("authorization_error");
		expect(oauthAuthorizationError("invalid_grant", ["grant"])).toBe("authorization_error");
		for (const code of ["provider receipt", "X".repeat(65), "invalid_grant\n", encode(secret)])
			expect(oauthAuthorizationError(code, [secret])).toBe("authorization_error");
	});

	it.each([401, 429, 500])("leaves the existing owned HTTP %i model error unchanged", (status) => {
		const error = Object.assign(new Error("provider rate limit or 500 body"), {
			status,
			error: { message: "provider rate limit or 500 body" },
		});
		expect(formatProviderError(normalizeProviderError(error))).toBe(`Provider request failed (${status})`);
	});
});
