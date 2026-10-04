import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { radiusProvider } from "../src/providers/radius.ts";
import { loadRadiusGatewayConfig } from "../src/providers/radius-config.ts";

const marker = "UNTRUSTED_RADIUS_4703_PROVIDER_TEXT";
const encoded = Buffer.from(marker).toString("base64");
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function runtime() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("radius", async () => ({
		type: "oauth",
		access: "synthetic-access",
		refresh: "synthetic-refresh",
		expires: Date.now() + 3_600_000,
	}));
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	const provider = radiusProvider();
	models.setProvider(provider);
	return { models, model: provider.getModels()[0] };
}

afterEach(() => vi.unstubAllGlobals());

// smarty-dev#4703 F3: authenticated catalog refresh is also an OAuth diagnostic boundary.
describe("Radius OAuth catalog errors", () => {
	it.each(["plain", "nested", "fetch", "parser", "body stream", "invalid config"])(
		"suppresses %s provider data",
		async (kind) => {
			const { models } = await runtime();
			vi.stubGlobal("fetch", async () => {
				if (kind === "fetch") throw new TypeError(marker);
				if (kind === "parser") return new Response(marker, { status: 200 });
				if (kind === "invalid config") return Response.json({ unrelated: marker });
				if (kind === "body stream")
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.error(new Error(marker));
							},
						}),
						{ status: 403 },
					);
				return new Response(
					kind === "plain"
						? marker
						: JSON.stringify({
								error: { code: marker, message: marker, nested: { encoded, url: encodeURIComponent(marker) } },
							}),
					{ status: 403 },
				);
			});
			const result = await models.refresh({ providers: ["radius"], allowNetwork: true });
			expect(result.errors).toHaveLength(1);
			const error = result.errors.get("radius")!;
			expect(error.message).toMatch(/^oauth_(request_failed|invalid_response) \(HTTP (403|200|unknown)\)$/);
			for (const text of [error.message, error.stack, JSON.stringify(error)]) {
				expect(text).not.toContain(marker);
				expect(text).not.toContain(encoded);
			}
		},
	);

	it("preserves ordinary API-key catalog errors", async () => {
		vi.stubGlobal("fetch", async () => new Response(marker, { status: 403 }));
		await expect(loadRadiusGatewayConfig("https://radius.example", "sk-test")).rejects.toThrow(marker);
	});
});

// smarty-dev#4703 F4: JSON casts do not validate protocol enums before persistence.
it.each([marker, encoded, {}, [marker], null, "stop", "error", "aborted"])(
	"allowlists terminal error reason %j",
	async (reason) => {
		const { models, model } = await runtime();
		const stream = models.stream(
			model,
			{ messages: [] },
			{
				fetch: async () =>
					new Response(`data: ${JSON.stringify({ type: "error", reason, usage, errorMessage: marker })}\n\n`, {
						headers: { "content-type": "text/event-stream" },
					}),
			},
		);
		const events = [];
		for await (const event of stream) events.push(event);
		const output = await stream.result();
		const expected = reason === "aborted" ? "aborted" : "error";
		expect(output.stopReason).toBe(expected);
		expect(events.at(-1)).toMatchObject({ type: "error", reason: expected });
		expect(JSON.stringify({ output, events })).not.toContain(marker);
		expect(JSON.stringify({ output, events })).not.toContain(encoded);
	},
);
