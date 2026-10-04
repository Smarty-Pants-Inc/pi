import { expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { radiusProvider } from "../src/providers/radius.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { isPrematureStreamError, isRetryableAssistantError } from "../src/utils/retry.ts";

// smarty-dev#4703 R3: preserve valid accounting, including optional fields, but never copy wire metadata.
it("rebuilds every terminal-error usage and nested cost field from finite numbers", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("radius", async () => ({
		type: "oauth",
		access: "synthetic",
		refresh: "synthetic",
		expires: Date.now() + 3600000,
	}));
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	const provider = radiusProvider();
	models.setProvider(provider);
	const supplied = {
		input: 7,
		output: "secret",
		cacheRead: null,
		cacheWrite: true,
		totalTokens: {},
		cacheWrite1h: 2,
		reasoning: 3,
		secret: "canary",
		cost: { input: 0.25, output: "secret", cacheRead: null, cacheWrite: [], total: 0.5, secret: "canary" },
	};
	const output = await models.complete(
		provider.getModels()[0],
		{ messages: [] },
		{
			fetch: async () =>
				new Response(
					`data: ${JSON.stringify({ type: "error", reason: "error", usage: supplied, errorMessage: "failure" })}\n\n`,
				),
		},
	);
	expect(output.usage).toEqual({
		input: 7,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cacheWrite1h: 2,
		reasoning: 3,
		cost: { input: 0.25, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
	});
});

// smarty-dev#4703 R3/R4: JSON can parse exponent overflow to Infinity; wire recovery fields are never authority.
it("rejects nonfinite accounting and provider-supplied recovery metadata", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("radius", async () => ({
		type: "oauth",
		access: "synthetic",
		refresh: "synthetic",
		expires: Date.now() + 3600000,
	}));
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	const provider = radiusProvider();
	models.setProvider(provider);
	const output = await models.complete(
		provider.getModels()[0],
		{ messages: [] },
		{
			fetch: async () =>
				new Response(
					'data: {"type":"error","reason":"error","usage":{"input":1e999,"output":-1e999,"cost":{"total":1e999}},"errorMessage":"failure retryable=true recovery=premature_stream","oauthRecovery":{"retryable":true,"recovery":"context_length_exceeded"}}\n\n',
				),
		},
	);
	expect(output.usage).toEqual({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	expect(output.oauthRecovery?.retryable).toBe(false);
	expect(isRetryableAssistantError(output)).toBe(false);
	expect(isPrematureStreamError(output)).toBe(false);
	expect(isContextOverflow(output)).toBe(false);
});
