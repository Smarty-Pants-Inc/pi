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

// pi#141 / P1-AUDIT-CLIENT-REGRESSION: cloning must not lower the original diagnostic policy.
it.each([
	"rotatedBearerClone",
	"opaqueProxyMutableHeader",
	"opaqueProxyDecoratedClone",
	"recordBearerMutable",
	"tuplesProxyMutable",
] as const)("retains supplied-client withholding across cloning (%s)", async (kind) => {
	vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
	const key = `SYNTHETIC_DISPOSITION_${kind}`;
	const headers: Record<string, string> | [string, string][] =
		kind === "tuplesProxyMutable"
			? [["X-Api-Key", "SYNTHETIC_INITIAL_DISPOSITION"]]
			: { "X-Api-Key": "SYNTHETIC_INITIAL_DISPOSITION" };
	const mutate = kind.includes("Mutable");
	let sent = 0;
	let actual: string | null | undefined;
	const underlying = new Anthropic({
		apiKey: "SYNTHETIC_STATIC_DISPOSITION",
		authToken: kind === "rotatedBearerClone" || kind === "recordBearerMutable" ? "SYNTHETIC_INITIAL_BEARER" : null,
		credentials: null,
		webhookKey: null,
		defaultHeaders: headers,
		baseURL: "https://mock.invalid",
		maxRetries: 0,
		fetch: async (_input, init) => {
			sent++;
			actual = new Headers(init?.headers).get("x-api-key");
			return Response.json(
				{ error: { message: `receipt=${key} DISPOSITION_DIAGNOSTIC`, nested: { receipt: key } } },
				{ status: 403 },
			);
		},
	});
	const originalClone = underlying.withOptions.bind(underlying);
	if (kind === "rotatedBearerClone" || kind === "recordBearerMutable" || kind === "opaqueProxyDecoratedClone") {
		underlying.withOptions = (opts) => {
			const copy = originalClone({ ...opts, ...(kind === "opaqueProxyDecoratedClone" ? {} : { authToken: null }) });
			if (!mutate) {
				const preparer = copy as unknown as { prepareRequest: Anthropic["prepareRequest"] };
				const prepare = preparer.prepareRequest.bind(copy);
				preparer.prepareRequest = async (request, ctx) => {
					await prepare(request, ctx);
					(request.headers as Headers).set("x-api-key", key);
				};
			}
			return copy;
		};
	}
	const client =
		kind.startsWith("opaqueProxy") || kind === "tuplesProxyMutable"
			? new Proxy(underlying, {
					get(target, prop) {
						if (prop === "_options") return undefined;
						const value: unknown = Reflect.get(target, prop, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				})
			: underlying;
	const events = stream(model, normalizeContext({ messages: [] }), {
		client,
		oauthDiagnostics: false,
		maxRetries: 0,
		onPayload: mutate
			? () => {
					if (Array.isArray(headers)) headers[0][1] = key;
					else headers["X-Api-Key"] = key;
				}
			: undefined,
	});
	const published: unknown[] = [];
	for await (const event of events) published.push(event);
	const output = await events.result();
	const directory = mkdtempSync(join(tmpdir(), "pi-r141-disposition-"));
	const session = SessionManager.create(directory, directory);
	session.appendMessage({ role: "user", content: "synthetic", timestamp: 0 });
	session.appendMessage(output);
	const file = session.getSessionFile();
	if (!file) throw new Error("Missing actual journal");
	const jsonl = readFileSync(file, "utf8");
	// Wire observations must be asserted outside the provider catch.
	expect(sent).toBe(1);
	expect(actual).toBe(key);
	expect(output.stopReason).toBe("error");
	expect(jsonl).toContain('"role":"assistant"');
	for (const surface of [JSON.stringify(published), JSON.stringify(output), jsonl]) {
		expect(surface.split(key).length - 1).toBe(0);
		expect(surface).not.toContain("DISPOSITION_DIAGNOSTIC");
	}
});

// pi#141: paired diagnostic controls retain base policy without changing request formatting.
it.each(["opaqueProxyExplicitWithholding", "transparentProxyMutableHeader", "opaqueProxyStaticHeader"] as const)(
	"preserves supplied-client disposition control (%s)",
	async (kind) => {
		vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
		const key = `SYNTHETIC_CONTROL_${kind}`;
		const mutates = kind !== "opaqueProxyStaticHeader";
		const headers = { "X-Api-Key": mutates ? "SYNTHETIC_CONTROL_INITIAL" : key };
		let sent = 0;
		let actual: string | null | undefined;
		const underlying = new Anthropic({
			apiKey: "SYNTHETIC_CONTROL_BASE",
			authToken: null,
			credentials: null,
			webhookKey: null,
			defaultHeaders: headers,
			baseURL: "https://mock.invalid",
			maxRetries: 0,
			fetch: async (_input, init) => {
				sent++;
				actual = new Headers(init?.headers).get("x-api-key");
				return Response.json({ error: { message: `receipt=${key}` } }, { status: 403 });
			},
		});
		const client = new Proxy(underlying, {
			get(target, prop) {
				if (prop === "_options" && kind !== "transparentProxyMutableHeader") return undefined;
				const value: unknown = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const events = stream(model, normalizeContext({ messages: [] }), {
			client,
			oauthDiagnostics: kind === "opaqueProxyExplicitWithholding",
			maxRetries: 0,
			onPayload: mutates
				? () => {
						headers["X-Api-Key"] = key;
					}
				: undefined,
		});
		const published: unknown[] = [];
		for await (const event of events) published.push(event);
		const output = await events.result();
		const directory = mkdtempSync(join(tmpdir(), "pi-r141-disposition-control-"));
		const session = SessionManager.create(directory, directory);
		session.appendMessage({ role: "user", content: "synthetic", timestamp: 0 });
		session.appendMessage(output);
		const file = session.getSessionFile();
		if (!file) throw new Error("Missing actual journal");
		const jsonl = readFileSync(file, "utf8");
		expect(sent).toBe(1);
		expect(actual).toBe(key);
		expect(output.stopReason).toBe("error");
		for (const surface of [JSON.stringify(published), JSON.stringify(output), jsonl]) {
			// smarty-dev#5822 / T-R2-03: mutable headers cannot select a rich publication policy.
			expect(surface).not.toContain(key);
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
