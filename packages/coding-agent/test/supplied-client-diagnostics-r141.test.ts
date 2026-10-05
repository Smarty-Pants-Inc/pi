import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { type Model, normalizeContext } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

afterEach(() => vi.unstubAllEnvs());

const model: Model<"anthropic-messages"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "anthropic-messages",
	provider: "audit",
	baseUrl: "https://mock.invalid",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};
// pi#141 / P1-AUDIT-CLIENT: supplied SDK authentication must be masked before real JSONL persistence.
it.each(
	(
		[
			"apiKey",
			"authToken",
			"defaultHeaders",
			"defaultAuthorization",
			"headersAuthorization",
			"tupleAuthorization",
			"dynamic",
		] as const
	).flatMap((kind) => [undefined, false, true].map((oauthDiagnostics) => ({ kind, oauthDiagnostics }))),
)("protects supplied $kind authentication with OAuth option $oauthDiagnostics", async ({ kind, oauthDiagnostics }) => {
	const key =
		kind === "authToken"
			? "[REDACTED:api-key]"
			: kind === "defaultAuthorization"
				? "sk-ant-" + "oat-synthetic-header"
				: `SYNTHETIC_CLIENT_${kind}`;
	let wire: Headers | undefined;
	const headerAuth =
		kind === "defaultAuthorization" || kind === "headersAuthorization" || kind === "tupleAuthorization";
	const bearerAuth = kind === "authToken" || kind === "dynamic" || headerAuth;
	const client = new Anthropic({
		apiKey:
			kind === "apiKey" ? `${key}\t` : kind === "defaultHeaders" || headerAuth ? "SYNTHETIC_OVERRIDDEN_KEY" : null,
		authToken: kind === "authToken" ? key : null,
		credentials: kind === "dynamic" ? async () => ({ token: key, expiresAt: null }) : null,
		webhookKey: null,
		defaultHeaders:
			kind === "defaultHeaders"
				? { "x-api-key": `${key}\t` }
				: kind === "defaultAuthorization"
					? { Authorization: `Bearer ${key}\t` }
					: kind === "headersAuthorization"
						? new Headers({ Authorization: `Bearer ${key}\t` })
						: kind === "tupleAuthorization"
							? [["Authorization", `Bearer ${key}\t`]]
							: undefined,
		baseURL: "https://mock.invalid",
		maxRetries: 0,
		fetch: async (_input, init) => {
			wire = new Headers(init?.headers);
			return Response.json({ error: { message: `receipt=${key} UNTRUSTED_CLIENT_DIAGNOSTIC` } }, { status: 403 });
		},
	});
	const events = stream(model, normalizeContext({ messages: [] }), { client, oauthDiagnostics, maxRetries: 0 });
	const published: unknown[] = [];
	for await (const event of events) published.push(event);
	const output = await events.result();
	expect(output.stopReason).toBe("error");
	expect(wire?.get(bearerAuth ? "authorization" : "x-api-key")).toBe(bearerAuth ? `Bearer ${key}` : key);
	const directory = mkdtempSync(join(tmpdir(), "pi-r141-client-journal-"));
	const session = SessionManager.create(directory, directory);
	session.appendMessage({ role: "user", content: "synthetic request", timestamp: 0 });
	session.appendMessage(output);
	const file = session.getSessionFile();
	if (!file) throw new Error("Missing actual journal");
	const jsonl = readFileSync(file, "utf8");
	expect(jsonl).toContain('"role":"assistant"');
	expect(jsonl).not.toContain(key);
	expect(JSON.stringify({ output, published })).not.toContain(key);
	if (kind === "authToken" || kind === "dynamic" || kind === "defaultAuthorization" || oauthDiagnostics) {
		expect(jsonl).not.toContain("UNTRUSTED_CLIENT_DIAGNOSTIC");
		expect(JSON.stringify(published)).not.toContain("UNTRUSTED_CLIENT_DIAGNOSTIC");
	}
});

// pi#141 / P1-AUDIT-CLIENT: bind the dispatched clone, not stale constructor options.
it.each(["cloneEnvironment", "subclass", "currentMiddleware"] as const)(
	"withholds effective supplied-client credentials in actual JSONL (%s)",
	async (kind) => {
		vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
		const key = `SYNTHETIC_EFFECTIVE_${kind}`;
		let sent = 0;
		class CustomClient extends Anthropic {
			protected override async prepareRequest(...args: Parameters<Anthropic["prepareRequest"]>): Promise<void> {
				await super.prepareRequest(...args);
				(args[0].headers as Headers).set("x-api-key", key);
			}
		}
		const Client = kind === "subclass" ? CustomClient : Anthropic;
		const client = new Client({
			apiKey: "SYNTHETIC_BASE_KEY",
			authToken: null,
			credentials: null,
			webhookKey: null,
			baseURL: "https://mock.invalid",
			maxRetries: 0,
			fetch: async (_input, init) => {
				sent++;
				expect(new Headers(init?.headers).get("x-api-key")).toBe(key);
				return Response.json(
					{ error: { message: `receipt=${key} UNBOUND_EFFECTIVE_DIAGNOSTIC`, nested: { values: [key] } } },
					{ status: 403 },
				);
			},
		});
		const clone = vi.spyOn(client, "withOptions");
		const originalLogLevel = client.logLevel;
		if (kind === "cloneEnvironment") vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", `X-Api-Key: ${key}`);
		if (kind === "currentMiddleware")
			client.middleware = [
				async (request, next) => {
					request.headers.set("x-api-key", key);
					return next(request);
				},
			];
		const events = stream(model, normalizeContext({ messages: [] }), {
			client,
			oauthDiagnostics: false,
			maxRetries: 0,
		});
		const published: unknown[] = [];
		for await (const event of events) published.push(event);
		const output = await events.result();
		expect(sent).toBe(1);
		expect(clone).toHaveBeenCalledTimes(1);
		expect(client.logLevel).toBe(originalLogLevel);
		expect(output.stopReason).toBe("error");
		const directory = mkdtempSync(join(tmpdir(), "pi-r141-effective-client-"));
		const session = SessionManager.create(directory, directory);
		session.appendMessage({ role: "user", content: "synthetic", timestamp: 0 });
		session.appendMessage(output);
		const file = session.getSessionFile();
		if (!file) throw new Error("Missing actual journal");
		const jsonl = readFileSync(file, "utf8");
		expect(jsonl).toContain('"role":"assistant"');
		expect(jsonl).not.toContain(key);
		expect(JSON.stringify({ published, output })).not.toContain(key);
		if (kind !== "cloneEnvironment") {
			expect(jsonl).not.toContain("UNBOUND_EFFECTIVE_DIAGNOSTIC");
			expect(JSON.stringify({ published, output })).not.toContain("UNBOUND_EFFECTIVE_DIAGNOSTIC");
		}
	},
);

// pi#141 / P2-AUDIT-BEARER-SEMANTICS: diagnostic withholding is not an OAuth protocol switch.
it.each(["audit", "github-copilot"])("preserves generic bearer request formatting (%s)", async (provider) => {
	vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
	let captured: unknown;
	let sent = 0;
	const client = new Anthropic({
		apiKey: null,
		authToken: "SYNTHETIC_GENERIC_BEARER",
		credentials: null,
		webhookKey: null,
		baseURL: "https://mock.invalid",
		maxRetries: 0,
		fetch: async () => {
			sent++;
			throw new Error("Unexpected send");
		},
	});
	const events = stream(
		{ ...model, provider },
		normalizeContext({
			systemPrompt: "Synthetic user identity",
			messages: [{ role: "user", content: "synthetic", timestamp: 0 }],
			tools: [{ name: "bash", description: "Synthetic", parameters: Type.Object({}) }],
		}),
		{
			client,
			onPayload: (params) => {
				captured = structuredClone(params);
				throw new Error("Synthetic pre-send refusal");
			},
		},
	);
	await events.result();
	expect(sent).toBe(0);
	expect(captured).toMatchObject({ tools: [{ name: "bash" }] });
	expect(JSON.stringify(captured)).not.toContain("Anthropic's official CLI");
	expect(JSON.stringify(captured)).not.toContain("oauth-2025-04-20");
});
