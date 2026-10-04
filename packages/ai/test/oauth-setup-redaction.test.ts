import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { ModelsApiStreamOptions } from "../src/models.ts";
import { createModels, ModelsError } from "../src/models.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import type { AssistantMessageEvent, ProviderHeaders } from "../src/types.ts";

const account = "FAKE_SETUP_ACCOUNT_127";
const access = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } }),
).toString("base64url")}.FAKE_SETUP_SIGNATURE_127`;
const fields = {
	refresh_token: "FAKE_ESCAPED_REFRESH_127",
	access_token: "FAKE_ESCAPED_ACCESS_127",
	id_token: "FAKE_ESCAPED_ID_127",
	account_id: "FAKE_ESCAPED_ACCOUNT_127",
	chatgpt_account_id: "FAKE_ESCAPED_CHATGPT_ACCOUNT_127",
};

function expectPrivate(value: unknown): void {
	const text = JSON.stringify(value);
	for (const secret of [access, account, ...Object.values(fields)]) expect(text).not.toContain(secret);
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// pi#127 / audit-2b P1-1 and P1-2: real provider dispatch through both public receivers.
describe.each([openaiProvider(), openaiCodexProvider()])("setup and escaped diagnostics: $id", (provider) => {
	describe.each(["stream", "complete"] as const)("Models.%s", (method) => {
		async function runtime() {
			const credentials = new InMemoryCredentialStore();
			await credentials.modify(provider.id, async () => ({
				type: "oauth",
				access,
				refresh: fields.refresh_token,
				expires: Date.now() + 3600000,
				clientId: "oaiapp_fake",
			}));
			const models = createModels({
				credentials,
				authContext: { env: async () => undefined, fileExists: async () => false },
			});
			models.setProvider(provider);
			const model = provider.getModels()[0];
			async function request(options: ModelsApiStreamOptions<typeof model.api>) {
				const events: AssistantMessageEvent[] = [];
				if (method === "complete")
					return { output: await models.complete(model, { messages: [] }, options), events };
				const stream = models.stream(model, { messages: [] }, options);
				for await (const event of stream) events.push(event);
				return { output: await stream.result(), events };
			}
			return { models, request };
		}

		it.each(["escaped fragment", "unterminated value", "missing separator"])(
			"redacts %s and SDK logging",
			async (kind) => {
				vi.stubEnv("OPENAI_LOG", "debug");
				const records: unknown[] = [];
				for (const level of ["debug", "info", "warn", "error"] as const) {
					vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
						records.push(args);
					});
				}
				const { request } = await runtime();
				const fragment =
					kind === "escaped fragment"
						? JSON.stringify(JSON.stringify(fields)).slice(1, -1)
						: kind === "unterminated value"
							? `refresh_token:\\"${fields.refresh_token} trailing fragment`
							: `refresh_token ${fields.refresh_token} trailing fragment`;
				const fetch = vi.fn(async () => new Response(`503 server_error ${fragment}`, { status: 503 }));
				const result = await request({ transport: "sse", maxRetries: 0, fetch });
				expect(fetch).toHaveBeenCalledTimes(1);
				expect(result.output.stopReason).toBe("error");
				expect(result.output.errorMessage).toContain("503");
				expect(result.output.errorMessage).toContain("oauth_request_failed");
				if (provider.id === "openai") expect(records.length).toBeGreaterThan(0);
				expectPrivate({ result, records });
			},
		);

		it.each(["Error", "TypeError", "thrown string", "typed error"])(
			"makes transformHeaders %s value-free before dispatch",
			async (kind) => {
				const { request } = await runtime();
				const fetch = vi.fn(async () => {
					throw new Error("Unexpected transport request");
				});
				const transformHeaders = vi.fn((headers: ProviderHeaders) => {
					expect(headers.Authorization).toBe(`Bearer ${access}`);
					const message = `Headers: ${JSON.stringify(headers)}; account=${account}`;
					if (kind === "thrown string") throw message;
					if (kind === "typed error") throw new ModelsError("auth", message);
					const error = kind === "TypeError" ? new TypeError(message) : new Error(message);
					error.name = access;
					throw error;
				});
				const result = await request({
					transport: "sse",
					maxRetries: 0,
					headers: { Authorization: `Bearer ${access}` },
					transformHeaders,
					fetch,
				});
				expect(transformHeaders).toHaveBeenCalledTimes(1);
				expect(fetch).not.toHaveBeenCalled();
				expect(result.output.stopReason).toBe("error");
				expect(result.output.errorMessage).toMatch(
					/^request setup failed: (?:Error|TypeError|ModelsError|ThrownValue)$/,
				);
				expectPrivate(result);
				if (method === "stream") expect(result.events.map((event) => event.type)).toEqual(["error"]);
			},
		);

		it("makes applyAuth derivation errors value-free, including typed causes", async () => {
			const { models, request } = await runtime();
			if (!provider.auth.oauth) throw new Error("Missing fixture OAuth method");
			models.setProvider({
				...provider,
				auth: {
					...provider.auth,
					oauth: {
						...provider.auth.oauth,
						toAuth: () => {
							throw new Error(`Derivation: ${access}; ${account}`);
						},
					},
				},
			});
			const fetch = vi.fn(async () => {
				throw new Error("Unexpected transport request");
			});
			const result = await request({ transport: "sse", maxRetries: 0, fetch });
			expect(fetch).not.toHaveBeenCalled();
			expect(result.output.stopReason).toBe("error");
			expect(result.output.errorMessage).toBe("request setup failed: ModelsError");
			expectPrivate(result);
		});
	});
});
