import { describe, expect, it } from "vitest";
import { stream } from "../src/api/openai-completions.ts";
import { getOAuthDiagnosticSecrets, redactOAuthDiagnostic } from "../src/auth/oauth/credential-response.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	id: "privacy-r141",
	name: "Privacy regression",
	api: "openai-completions",
	provider: "audit",
	baseUrl: "https://mock.invalid/v1",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};

// pi#141 / smarty-dev#4703: generated credentials and native URL aliases are diagnostic data.
describe("generated credential and canonical aliases", () => {
	const cases = [
		{ key: "Q7Z9V2B4 ", alias: "Q7Z9V2B4" },
		{ key: "Q7 Z9", alias: new URLSearchParams({ v: "Q7 Z9" }).toString().slice(2) },
		{ key: "Q7 Z9", alias: "Q7+%5a9" },
		{ key: "Q7.EXAMPLE.", alias: new URL("https://Q7.EXAMPLE./").hostname },
		{ key: "Q7.EXAMPLE.", alias: "q7.example" },
		{ key: "éQ7.example", alias: new URL("https://éQ7.example/").hostname },
		{ key: "[2001:0DB8:0:0:0:0:0:1]", alias: new URL("https://[2001:0DB8:0:0:0:0:0:1]/").hostname },
	];
	it.each(cases)("masks $key at the shared collector", ({ key, alias }) => {
		const result = redactOAuthDiagnostic(`receipt=https://${alias}/?v=${alias}`, getOAuthDiagnosticSecrets(key));
		expect(result).not.toContain(alias);
	});
	it.each(cases.filter(({ key }) => /^[\x20-\x7e]+$/.test(key)))(
		"masks $key through provider errors, public events and the session serialization payload",
		async ({ key, alias }) => {
			let wire: Headers | undefined;
			const events: unknown[] = [];
			const eventStream = stream(model, normalizeContext({ messages: [] }), {
				apiKey: key,
				env: {},
				maxRetries: 0,
				fetch: async (_input, init) => {
					wire = new Headers(init?.headers);
					return Response.json(
						{ error: { message: `receipt=https://echo.invalid/?v=${alias}` } },
						{ status: 400 },
					);
				},
			});
			for await (const event of eventStream) events.push(event);
			const output = await eventStream.result();
			expect(wire?.get("authorization")).toBe(new Headers({ authorization: `Bearer ${key}` }).get("authorization"));
			expect(output.stopReason).toBe("error");
			const sessionRow = JSON.stringify({ type: "message", message: output });
			expect(JSON.stringify({ events, sessionRow })).not.toContain(alias);
		},
	);
	it("retains unrelated native URL and form data unchanged", () => {
		const text = "receipt=https://other.invalid/?v=ordinary+text%20data";
		expect(redactOAuthDiagnostic(text, ["Q7 Z9"])).toBe(text);
	});
});
