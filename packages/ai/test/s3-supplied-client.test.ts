import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/anthropic-messages.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const canary = "SYNTHETIC_MUTABLE_SUPPLIED_5822";
const model: Model<"anthropic-messages"> = {
	id: "synthetic",
	name: "Synthetic",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://mock.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 128,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({ messages: [] });
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// smarty-dev#5822 / T-R2-03: diagnostic introspection itself must not throw raw client values synchronously.
it("contains a supplied client clone failure without inspecting private options", async () => {
	const client = new Anthropic({
		apiKey: "synthetic-key",
		authToken: null,
		credentials: null,
		webhookKey: null,
		fetch: async () => {
			throw new Error("Unexpected synthetic dispatch");
		},
	});
	Object.defineProperty(client, "_options", {
		get: () => {
			throw new Error(canary);
		},
	});
	const output = await stream(model, context, { client }).result();
	expect(output.stopReason).toBe("error");
	expect(output.errorMessage).toContain("provider_request_failed");
	expect(JSON.stringify(output)).not.toContain(canary);
});

// smarty-dev#5822 / T-R2-03: static constructor headers do not authorize later diagnostic publication.
describe.each([undefined, false, true])("mutable supplied client diagnostic option=%s", (oauthDiagnostics) => {
	it.each(["record", "transparent proxy", "opaque proxy"] as const)(
		"keeps %s errors owned after header mutation",
		async (kind) => {
			vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
			const headers = { "X-Gateway-Token": "synthetic-old" };
			let sent: Headers | undefined;
			const original = new Anthropic({
				apiKey: "synthetic-key",
				authToken: null,
				credentials: null,
				webhookKey: null,
				defaultHeaders: headers,
				baseURL: "https://mock.invalid",
				maxRetries: 0,
				fetch: async (_input, init) => {
					sent = new Headers(init?.headers);
					return Response.json({ error: { message: canary } }, { status: 401 });
				},
			});
			const client =
				kind === "record"
					? original
					: new Proxy(original, {
							get(target, property) {
								if (kind === "opaque proxy" && property === "_options") return undefined;
								const value: unknown = Reflect.get(target, property, target);
								return typeof value === "function" ? value.bind(target) : value;
							},
						});
			const eventStream = stream(model, context, {
				client,
				oauthDiagnostics,
				maxRetries: 0,
				onPayload: () => {
					headers["X-Gateway-Token"] = canary;
				},
			});
			const events: unknown[] = [];
			for await (const event of eventStream) events.push(event);
			const output = await eventStream.result();
			expect(sent?.get("X-Gateway-Token")).toBe(canary);
			expect(output.stopReason).toBe("error");
			expect(JSON.stringify({ events, output })).not.toContain(canary);
		},
	);
});

// smarty-dev#5822 / T-R2-03: confidentiality has no mutable-auth or prototype heuristic.
it("has no supplied-client withholding heuristic or secret collector", () => {
	const source = readFileSync(new URL("../src/api/anthropic-messages.ts", import.meta.url), "utf8");
	expect(source.includes("bindClientDiagnostics")).toBe(false);
	expect(source.includes("unboundAuth")).toBe(false);
	expect(source.includes("cloneDiagnostics")).toBe(false);
});
