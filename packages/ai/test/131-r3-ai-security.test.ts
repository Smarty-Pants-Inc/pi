import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { classify as llamaClassify } from "../src/api/llama-cpp-classify.ts";
import { stream as completionsStream } from "../src/api/openai-completions.ts";
import { classify as systemClassify } from "../src/api/typesafe-system-one.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { waitForCallbackOrManualInput } from "../src/auth/oauth/callback-server.ts";
import { getOAuthDiagnosticSecrets, redactOAuthDiagnostic } from "../src/auth/oauth/credential-response.ts";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import { metaOAuth } from "../src/auth/oauth/meta.ts";
import { openRouterOAuth } from "../src/auth/oauth/openrouter.ts";
import { createRadiusOAuth } from "../src/auth/oauth/radius.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { kimiCodingProvider } from "../src/providers/kimi-coding.ts";
import { metaProvider } from "../src/providers/meta.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import type { ClassifierContext, ClassifierModel, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const secret = 'FAKE_131_R3_opaque"\\suffix';
const echo = JSON.stringify(JSON.stringify({ unrelated: secret }));
const plainSecret = "FAKE_131_R3_PLAIN";
const chat = {
	id: "fake",
	name: "fake",
	provider: "fake",
	baseUrl: "http://mock.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
} satisfies Omit<Model<"anthropic-messages">, "api">;
const context: ClassifierContext = {
	state: {},
	questions: { ok: { type: "bool", instructions: "ok?", criteria: { true: "yes", false: "no" } } },
};
const classifier = {
	type: "classifier",
	id: "fake",
	name: "fake",
	provider: "fake",
	baseUrl: "http://mock.test/v1",
	input: ["text"],
	cost: chat.cost,
	contextWindow: 8192,
} satisfies Omit<ClassifierModel<"typesafe-system-one">, "api">;
function privateDiagnostic(value: unknown, values = [secret, plainSecret]) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	for (const value of values) {
		let variant = value;
		for (let depth = 0; depth < 3; depth++) {
			expect(text).not.toContain(variant);
			variant = JSON.stringify(variant).slice(1, -1);
		}
	}
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

// PR #131 F02: exercise the public Models login/getAuth receiver, not only the decoder.
describe.each([kimiCodingProvider(), metaProvider()])("F02 OAuth $id", (provider) => {
	it.each(["partial", "http", "transport"])("login %s is value-free", async (branch) => {
		const models = createModels({
			credentials: new InMemoryCredentialStore(),
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(provider);
		vi.stubGlobal("fetch", async () => {
			if (branch === "transport") throw new Error(plainSecret);
			return Response.json(
				{ device_code: plainSecret, user_code: plainSecret, message: plainSecret, error_description: plainSecret },
				{ status: branch === "http" ? 400 : 200 },
			);
		});
		const failure = await models.login(provider.id, "oauth", { prompt: async () => "", notify: () => {} }).then(
			() => "unexpected success",
			(error: unknown) => String(error),
		);
		expect(failure).not.toBe("unexpected success");
		privateDiagnostic(failure);
	});
	it.each(["partial", "http", "unauthorized", "transport"])("refresh %s is value-free", async (branch) => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(provider.id, async () => ({
			type: "oauth",
			access: "fake-access",
			refresh: plainSecret,
			expires: 0,
		}));
		const models = createModels({
			credentials,
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(provider);
		vi.stubGlobal("fetch", async () => {
			if (branch === "transport") throw new Error(plainSecret);
			return Response.json(
				{
					access_token: plainSecret,
					refresh_token: plainSecret,
					message: plainSecret,
					error_description: plainSecret,
				},
				{ status: branch === "http" ? 400 : branch === "unauthorized" ? 401 : 200 },
			);
		});
		const failure = await models.getAuth(provider.id).then(
			() => "unexpected success",
			(error: unknown) => String(error),
		);
		expect(failure).not.toBe("unexpected success");
		privateDiagnostic(failure);
	});
});

// PR #131 F03: distinct Anthropic HTTP, SSE, parser, transport and native SDK log receivers.
describe("F03 Anthropic", () => {
	it.each(["http-json", "http-text", "sse", "parser", "transport"])("protects %s and SDK logging", async (branch) => {
		vi.stubEnv("ANTHROPIC_LOG", "debug");
		const logs: unknown[] = [];
		for (const level of ["debug", "info", "warn", "error"] as const)
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logs.push(args);
			});
		const fetch = async () => {
			if (branch === "transport") throw new Error(plainSecret);
			if (branch === "http-json")
				return Response.json({ error: { type: "fake_error", message: plainSecret } }, { status: 400 });
			if (branch === "http-text") return new Response(plainSecret, { status: 400 });
			return new Response(
				`event: ${branch === "parser" ? "message_start" : "error"}\ndata: ${branch === "parser" ? `invalid ${plainSecret}` : JSON.stringify({ message: plainSecret })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		const output = await anthropicStream({ ...chat, api: "anthropic-messages" }, normalizeContext({ messages: [] }), {
			apiKey: "fake-active",
			diagnosticSecrets: [plainSecret],
			fetch,
			maxRetries: 0,
		}).result();
		expect(output.stopReason).toBe("error");
		privateDiagnostic(output);
		privateDiagnostic(logs);
	});
});

// PR #131 F03: limit message and metadata are independent sinks, including the throttle waitMessage.
describe("F03 completions", () => {
	it.each(["http", "transport", "metadata", "limit", "throttle"])("protects %s and SDK logging", async (branch) => {
		vi.stubEnv("OPENAI_LOG", "debug");
		const logs: unknown[] = [];
		for (const level of ["debug", "info", "warn", "error"] as const)
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logs.push(args);
			});
		const fetch = async () => {
			if (branch === "transport") throw new Error(plainSecret);
			return Response.json(
				{
					error: {
						message: plainSecret,
						code: branch === "limit" || branch === "throttle" ? "smarty_limit" : "fake_error",
						throttled: branch === "throttle",
						metadata: { raw: plainSecret },
					},
				},
				{ status: branch === "limit" || branch === "throttle" ? 429 : 400, headers: { "retry-after": "1" } },
			);
		};
		const output = await completionsStream(
			{ ...chat, api: "openai-completions" },
			normalizeContext({ messages: [] }),
			{ apiKey: "fake-active", diagnosticSecrets: [plainSecret], fetch, maxRetries: 0 },
		).result();
		expect(output.stopReason).toBe("error");
		privateDiagnostic(output);
		privateDiagnostic(logs);
	});
});

// PR #131 F03: both classifiers receive locally resolved and supplied diagnostic secrets.
describe.each(["system", "llama"] as const)("F03 %s classifier", (kind) => {
	it.each(["http", "transport"])("protects %s", async (branch) => {
		const fetch = async () => {
			if (branch === "transport") throw new Error(plainSecret);
			return new Response(plainSecret, { status: 400 });
		};
		const options = { apiKey: "fake-active", diagnosticSecrets: [plainSecret], fetch, maxRetries: 0 };
		const output =
			kind === "system"
				? await systemClassify({ ...classifier, api: "typesafe-system-one" }, context, options)
				: await llamaClassify({ ...classifier, api: "llama-cpp-classify" }, context, options);
		expect(output.stopReason).toBe("error");
		privateDiagnostic(output);
	});
});

// PR #131 F05: bare header credential and additional JSON serialization must be masked without labels.
it("F05 collects full and bare Authorization override values", () => {
	expect(getOAuthDiagnosticSecrets("fake-active", { Authorization: `Bearer ${plainSecret}` })).toContain(plainSecret);
});
it("F05 masks opaque quoted/backslash values under an additional JSON layer", () => {
	privateDiagnostic(redactOAuthDiagnostic(echo, [secret]));
});
it.each(["override", "transform"])("F05 protects actual Responses %s errors and logs", async (branch) => {
	vi.stubEnv("OPENAI_LOG", "debug");
	const logs: unknown[] = [];
	for (const level of ["debug", "info", "warn", "error"] as const)
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			logs.push(args);
		});
	const provider = openaiProvider();
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(provider.id, async () => ({ type: "api_key", key: "fake-active" }));
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	models.setProvider(provider);
	const model = { ...provider.getModels()[0], baseUrl: "http://mock.test/v1" };
	const output = await models.complete(model, normalizeContext({ messages: [] }), {
		headers: branch === "override" ? { Authorization: `Bearer ${plainSecret}` } : undefined,
		transformHeaders: branch === "transform" ? async () => ({ Authorization: `Bearer ${plainSecret}` }) : undefined,
		diagnosticSecrets: [secret],
		maxRetries: 0,
		fetch: async () => Response.json({ error: { message: `${plainSecret} ${echo}` } }, { status: 400 }),
	});
	expect(output.stopReason).toBe("error");
	privateDiagnostic(output);
	privateDiagnostic(logs);
});

// PR #131 F10: always join a signal-aware accepted manual prompt, including no callback/bind fallback.
it("F10 owner abort cancels and joins manual-only fallback", async () => {
	const owner = new AbortController();
	let retired = false;
	let promptSignal: AbortSignal | undefined;
	let retire: (() => void) | undefined;
	const work = waitForCallbackOrManualInput(
		{
			signal: owner.signal,
			notify: () => {},
			prompt: ({ signal }) => {
				promptSignal = signal;
				return new Promise<string>((_resolve, reject) => {
					retire = () => {
						retired = true;
						reject(new Error("prompt cancelled"));
					};
					signal?.addEventListener("abort", retire, { once: true });
				});
			},
		},
		undefined,
		{ message: "fake", placeholder: "fake" },
	);
	const observed = work.then(
		() => undefined,
		() => undefined,
	);
	await Promise.resolve();
	owner.abort();
	await Promise.resolve();
	await Promise.resolve();
	const cancelled = promptSignal?.aborted;
	// Baseline cleanup is explicit: join before asserting the product failure.
	if (!cancelled) retire?.();
	await observed;
	expect(cancelled).toBe(true);
	expect(retired).toBe(true);
});

// PR #131 F11: System One must stop fast overflow and trickling success/error reads.
it.each([200, 400])("F11 System One cancels fast oversized %s body", async (status) => {
	let cancelled = false;
	let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			producer = controller;
			controller.enqueue(new Uint8Array(17 * 1024 * 1024));
		},
		cancel() {
			cancelled = true;
		},
	});
	const timeout = setTimeout(() => {
		if (!cancelled) producer?.close();
	}, 100);
	const output = await systemClassify({ ...classifier, api: "typesafe-system-one" }, context, {
		apiKey: "fake",
		fetch: async () => new Response(body, { status }),
		maxRetries: 0,
	});
	clearTimeout(timeout);
	expect(output.stopReason).toBe("error");
	expect(cancelled).toBe(true);
});

// PR #131 F02: independently cover polling and the additional Meta mint phase.
describe.each([kimiCodingProvider(), metaProvider()])("F02 polling $id", (provider) => {
	it.each(["http", "protocol"])("poll %s is value-free", async (branch) => {
		vi.useFakeTimers();
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return calls === 1
				? Response.json({
						device_code: "fake-device",
						user_code: "fake-user",
						verification_uri: "http://mock.test/verify",
						verification_uri_complete: "http://mock.test/verify",
						interval: 1,
						expires_in: 10,
					})
				: Response.json(
						{ message: plainSecret, error: plainSecret, error_description: plainSecret },
						{ status: branch === "http" ? 500 : 400 },
					);
		});
		const models = createModels({
			credentials: new InMemoryCredentialStore(),
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(provider);
		const result = models.login(provider.id, "oauth", { prompt: async () => "", notify: () => {} }).then(
			() => "unexpected success",
			(error: unknown) => String(error),
		);
		await vi.advanceTimersByTimeAsync(1100);
		const failure = await result;
		expect(calls).toBe(2);
		privateDiagnostic(failure);
	});
});
it("F02 Kimi partial polling token is value-free", async () => {
	vi.useFakeTimers();
	let calls = 0;
	const provider = kimiCodingProvider();
	vi.stubGlobal("fetch", async () =>
		++calls === 1
			? Response.json({
					device_code: "fake-device",
					user_code: "fake-user",
					verification_uri: "http://mock.test/verify",
					verification_uri_complete: "http://mock.test/verify",
					interval: 1,
					expires_in: 10,
				})
			: Response.json({ access_token: plainSecret, refresh_token: plainSecret }),
	);
	const models = createModels({
		credentials: new InMemoryCredentialStore(),
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	models.setProvider(provider);
	const result = models.login(provider.id, "oauth", { prompt: async () => "", notify: () => {} }).then(
		() => "unexpected success",
		(error: unknown) => String(error),
	);
	await vi.advanceTimersByTimeAsync(1100);
	privateDiagnostic(await result);
	expect(calls).toBe(2);
});
it.each(["http", "unauthorized", "action-url"])("F02 Meta mint %s is value-free", async (branch) => {
	vi.useFakeTimers();
	let calls = 0;
	const provider = metaProvider();
	vi.stubGlobal("fetch", async () => {
		calls++;
		if (calls === 1)
			return Response.json({
				device_code: "fake-device",
				user_code: "fake-user",
				verification_uri: "http://mock.test/verify",
				interval: 1,
				expires_in: 10,
			});
		if (calls === 2) return Response.json({ access_token: "fake-identity" });
		return Response.json(
			{ action_url: `http://mock.test/${plainSecret}`, message: plainSecret, error_description: plainSecret },
			{ status: branch === "http" ? 400 : branch === "unauthorized" ? 401 : 200 },
		);
	});
	const models = createModels({
		credentials: new InMemoryCredentialStore(),
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	models.setProvider(provider);
	const result = models.login(provider.id, "oauth", { prompt: async () => "", notify: () => {} }).then(
		() => "unexpected success",
		(error: unknown) => String(error),
	);
	await vi.advanceTimersByTimeAsync(1100);
	privateDiagnostic(await result);
	expect(calls).toBe(3);
});

// PR #131 F10: a real bind refusal must not detach the manual SDK prompt on owner abort.
it("F10 public Anthropic bind failure composes owner cancellation into accepted prompt", async () => {
	const occupied = createServer();
	await new Promise<void>((resolve, reject) => {
		occupied.once("error", reject);
		occupied.listen(53692, "127.0.0.1", resolve);
	});
	const owner = new AbortController();
	let promptSignal: AbortSignal | undefined;
	let retire: (() => void) | undefined;
	let accepted: (() => void) | undefined;
	let retired = false;
	let finishRetired: (() => void) | undefined;
	const retirement = new Promise<void>((resolve) => {
		finishRetired = resolve;
	});
	const started = new Promise<void>((resolve) => {
		accepted = resolve;
	});
	const models = createModels({
		credentials: new InMemoryCredentialStore(),
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	models.setProvider(anthropicProvider());
	const result = models
		.login("anthropic", "oauth", {
			signal: owner.signal,
			notify: () => {},
			prompt: (prompt) => {
				if (prompt.type === "select") return Promise.resolve("browser");
				promptSignal = prompt.signal;
				return new Promise<string>((_resolve, reject) => {
					let retiring = false;
					retire = () => {
						if (retiring) return;
						retiring = true;
						setTimeout(() => {
							retired = true;
							reject(new Error("fake prompt cancelled"));
							finishRetired?.();
						}, 10);
					};
					prompt.signal?.addEventListener("abort", retire, { once: true });
					accepted?.();
				});
			},
		})
		.then(
			() => undefined,
			() => undefined,
		);
	try {
		await started;
		owner.abort();
		await result;
		const cancelled = promptSignal?.aborted;
		const joinedAtSettlement = retired;
		if (!cancelled) retire?.();
		await retirement;
		expect(cancelled).toBe(true);
		expect(joinedAtSettlement).toBe(true);
	} finally {
		retire?.();
		await result;
		await retirement;
		await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())));
	}
});

// PR #131 F11: OAuth readers must cancel overflow BEFORE parsing, on success and error bodies.
const oauthReaders = [
	{ name: "anthropic-exchange", auth: anthropicOAuth, phase: "login", selection: "copy_code" },
	{ name: "anthropic-refresh", auth: anthropicOAuth, phase: "refresh", selection: "" },
	{ name: "kimi-device", auth: kimiCodingOAuth, phase: "login", selection: "" },
	{ name: "kimi-poll", auth: kimiCodingOAuth, phase: "poll", selection: "" },
	{ name: "kimi-refresh", auth: kimiCodingOAuth, phase: "refresh", selection: "" },
	{ name: "meta-device", auth: metaOAuth, phase: "login", selection: "" },
	{ name: "meta-poll", auth: metaOAuth, phase: "poll", selection: "" },
	{ name: "meta-mint", auth: metaOAuth, phase: "refresh", selection: "" },
	{
		name: "radius-discovery",
		auth: createRadiusOAuth({ name: "fake", gateway: "http://mock.test" }),
		phase: "login",
		selection: "browser",
	},
	{
		name: "radius-device",
		auth: createRadiusOAuth({ name: "fake", gateway: "http://mock.test" }),
		phase: "login",
		selection: "device-code",
	},
	{
		name: "radius-token",
		auth: createRadiusOAuth({ name: "fake", gateway: "http://mock.test" }),
		phase: "refresh",
		selection: "",
	},
	{ name: "openrouter-exchange", auth: openRouterOAuth, phase: "login", selection: "fake-code" },
] as const;
describe.each(oauthReaders)("F11 $name", (entry) => {
	it.each([200, 400])("cancels fast oversized %s body", async (status) => {
		let cancelled = false;
		let calls = 0;
		let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				producer = controller;
				controller.enqueue(new Uint8Array(2 * 1024 * 1024));
			},
			cancel() {
				cancelled = true;
			},
		});
		const closeTimer = setTimeout(
			() => {
				if (!cancelled) producer?.close();
			},
			entry.phase === "poll" ? 1500 : 100,
		);
		vi.stubGlobal("fetch", async () => {
			calls++;
			if (entry.phase === "poll" && calls === 1)
				return Response.json({
					device_code: "fake-device",
					user_code: "fake-user",
					verification_uri: "http://mock.test/verify",
					verification_uri_complete: "http://mock.test/verify",
					interval: 1,
					expires_in: 10,
				});
			return new Response(body, { status });
		});
		const signal = new AbortController().signal;
		try {
			const operation =
				entry.phase === "refresh"
					? entry.auth.refresh({ type: "oauth", access: "fake", refresh: "fake", expires: 0 }, signal)
					: entry.auth.login({
							signal,
							notify: () => {},
							prompt: async (prompt) => (prompt.type === "select" ? entry.selection : "fake-code"),
						});
			await operation.catch(() => undefined);
			expect(calls).toBe(entry.phase === "poll" ? 2 : 1);
			expect(cancelled).toBe(true);
		} finally {
			clearTimeout(closeTimer);
			if (!cancelled) {
				try {
					producer?.close();
				} catch {}
			}
		}
	});
	it.each([200, 400])("deadline retires trickling %s body", async (status) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
		let cancelled = false;
		let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
		let calls = 0;
		let acceptBody: (() => void) | undefined;
		const bodyAccepted = new Promise<void>((resolve) => {
			acceptBody = resolve;
		});
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				producer = controller;
			},
			cancel() {
				cancelled = true;
			},
		});
		const trickle = setInterval(() => {
			if (!cancelled) producer?.enqueue(new Uint8Array([32]));
		}, 1000);
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			calls++;
			if (entry.phase === "poll" && calls === 1)
				return Response.json({
					device_code: "fake-device",
					user_code: "fake-user",
					verification_uri: "http://mock.test/verify",
					verification_uri_complete: "http://mock.test/verify",
					interval: 1,
					expires_in: 10,
				});
			init?.signal?.addEventListener(
				"abort",
				() => {
					if (!cancelled) {
						cancelled = true;
						producer?.error(new Error("fake native body aborted"));
					}
				},
				{ once: true },
			);
			acceptBody?.();
			return new Response(body, { status });
		});
		// Native fetch aborts its accepted body too. Emulate that contract rather than
		// manufacturing a deadline defect in providers whose phase timeout already works.
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new Error("fake native phase timeout")), ms);
			return controller.signal;
		});
		const owner = new AbortController();
		let settled = false;
		const operation = (
			entry.phase === "refresh"
				? entry.auth.refresh({ type: "oauth", access: "fake", refresh: "fake", expires: 0 }, owner.signal)
				: entry.auth.login({
						signal: owner.signal,
						notify: () => {},
						prompt: async (prompt) => (prompt.type === "select" ? entry.selection : "fake-code"),
					})
		).then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		// smarty-dev#4703: PKCE native crypto and loopback admission are not
		// synchronized by one setImmediate. Start deadline measurement only once
		// fetch has accepted the target body and installed its abort listener.
		if (entry.phase === "poll") await vi.advanceTimersByTimeAsync(1100);
		await bodyAccepted;
		await vi.advanceTimersByTimeAsync(31_100);
		const retiredByDeadline = cancelled;
		// Baseline response.json/text ignores a mocked fetch signal: close and join explicitly.
		clearInterval(trickle);
		owner.abort();
		if (!cancelled) producer?.close();
		await vi.advanceTimersByTimeAsync(10_000);
		await operation;
		expect(settled).toBe(true);
		expect(retiredByDeadline).toBe(true);
	});
});

// PR #131 F11: default finite whole-operation deadline includes all classifier retry/backoff phases.
it("F11 System One deadline includes retry backoff, not a fresh timeout per attempt", async () => {
	vi.useFakeTimers();
	let calls = 0;
	let completed = false;
	const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
		calls++;
		if (calls === 1) return new Response("fake retry", { status: 503, headers: { "retry-after-ms": "80" } });
		return new Promise<Response>((resolve, reject) => {
			const timer = setTimeout(() => resolve(Response.json({ answers: { ok: { type: "noul", noul: 1 } } })), 80);
			init?.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(new Error("fake aborted"));
				},
				{ once: true },
			);
		});
	};
	const work = systemClassify({ ...classifier, api: "typesafe-system-one" }, context, {
		apiKey: "fake",
		fetch,
		timeoutMs: 100,
		maxRetries: 1,
	}).then((result) => {
		completed = true;
		return result;
	});
	await vi.advanceTimersByTimeAsync(110);
	const metDeadline = completed;
	await vi.advanceTimersByTimeAsync(100);
	const result = await work;
	expect(calls).toBe(2);
	expect(metDeadline).toBe(true);
	expect(result.stopReason).toBe("error");
});
it("F11 System One omitted timeout still supplies a finite native deadline", async () => {
	vi.useFakeTimers();
	let cancelled = false;
	let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			producer = controller;
		},
		cancel() {
			cancelled = true;
		},
	});
	const work = systemClassify({ ...classifier, api: "typesafe-system-one" }, context, {
		apiKey: "fake",
		fetch: async () => new Response(body),
		maxRetries: 0,
	});
	await vi.advanceTimersByTimeAsync(61_000);
	const metDeadline = cancelled;
	if (!cancelled) producer?.close();
	await work;
	expect(metDeadline).toBe(true);
});

// PR #131 F03: check log emission independently; a safe returned error does not establish safe SDK logs.
it.each(["anthropic", "completions"] as const)("F03 %s SDK log sink is independently safe", async (kind) => {
	vi.stubEnv(kind === "anthropic" ? "ANTHROPIC_LOG" : "OPENAI_LOG", "debug");
	const logs: unknown[] = [];
	for (const level of ["debug", "info", "warn", "error"] as const)
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			logs.push(args);
		});
	const fetch = async () => Response.json({ error: { message: plainSecret } }, { status: 400 });
	const options = { apiKey: "fake-active", diagnosticSecrets: [plainSecret], fetch, maxRetries: 0 };
	if (kind === "anthropic")
		await anthropicStream(
			{ ...chat, api: "anthropic-messages" },
			normalizeContext({ messages: [] }),
			options,
		).result();
	else
		await completionsStream(
			{ ...chat, api: "openai-completions" },
			normalizeContext({ messages: [] }),
			options,
		).result();
	privateDiagnostic(logs);
});
it.each(["system", "llama"] as const)("F03 %s classifier parser error is safe", async (kind) => {
	const fetch = async () => new Response(`invalid-json-${plainSecret}`);
	const options = { apiKey: "fake-active", diagnosticSecrets: [plainSecret], fetch, maxRetries: 0 };
	const output =
		kind === "system"
			? await systemClassify({ ...classifier, api: "typesafe-system-one" }, context, options)
			: await llamaClassify({ ...classifier, api: "llama-cpp-classify" }, context, options);
	expect(output.stopReason).toBe("error");
	privateDiagnostic(output);
});
it.each(["anthropic", "completions", "system", "llama"] as const)(
	"F03 direct %s locally resolves active credential for HTTP diagnostics",
	async (kind) => {
		const fetch = async () => new Response(plainSecret, { status: 400 });
		const options = { apiKey: plainSecret, fetch, maxRetries: 0 };
		const output =
			kind === "anthropic"
				? await anthropicStream(
						{ ...chat, api: "anthropic-messages" },
						normalizeContext({ messages: [] }),
						options,
					).result()
				: kind === "completions"
					? await completionsStream(
							{ ...chat, api: "openai-completions" },
							normalizeContext({ messages: [] }),
							options,
						).result()
					: kind === "system"
						? await systemClassify({ ...classifier, api: "typesafe-system-one" }, context, options)
						: await llamaClassify({ ...classifier, api: "llama-cpp-classify" }, context, options);
		expect(output.stopReason).toBe("error");
		privateDiagnostic(output);
	},
);

// PR #131 F10: abort notification is not prompt retirement; join the exact accepted asynchronous prompt.
it("F10 callback win joins asynchronous manual prompt retirement", async () => {
	let retired = false;
	let retire: (() => void) | undefined;
	const work = waitForCallbackOrManualInput(
		{
			signal: new AbortController().signal,
			notify: () => {},
			prompt: ({ signal }) =>
				new Promise<string>((_resolve, reject) => {
					retire = () => {
						setTimeout(() => {
							retired = true;
							reject(new Error("fake prompt retired"));
						}, 10);
					};
					signal?.addEventListener("abort", retire, { once: true });
				}),
		},
		{ redirectUri: "http://mock.test", wait: async () => "fake-callback", close: () => {}, cancel: () => {} },
		{ message: "fake", placeholder: "fake" },
	);
	const result = await work;
	const joinedAtSettlement = retired;
	if (!retired) await new Promise<void>((resolve) => setTimeout(resolve, 15));
	expect(result).toEqual({ type: "callback", value: "fake-callback" });
	expect(joinedAtSettlement).toBe(true);
	expect(retired).toBe(true);
});

// PR #131 F11: server-controlled expiry/interval must not extend the one finite OAuth operation budget.
it.each([kimiCodingOAuth, metaOAuth])(
	"F11 $name bounds whole polling operation with owner-composed deadline",
	async (auth) => {
		vi.useFakeTimers();
		let calls = 0;
		let settled = false;
		vi.stubGlobal("fetch", async () =>
			++calls === 1
				? Response.json({
						device_code: "fake-device",
						user_code: "fake-user",
						verification_uri: "http://mock.test/verify",
						verification_uri_complete: "http://mock.test/verify",
						interval: 5,
						expires_in: 7200,
					})
				: Response.json({ error: "authorization_pending" }, { status: 400 }),
		);
		const owner = new AbortController();
		const operation = auth.login({ signal: owner.signal, prompt: async () => "", notify: () => {} }).then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await vi.advanceTimersByTimeAsync(15 * 60_000 + 100);
		const metDeadline = settled;
		owner.abort();
		await operation;
		expect(calls).toBeGreaterThan(1);
		expect(metDeadline).toBe(true);
	},
);
it.each([anthropicOAuth, createRadiusOAuth({ name: "fake", gateway: "http://mock.test" })])(
	"F11 $name selection prompt receives the operation signal",
	async (auth) => {
		vi.useFakeTimers();
		const owner = new AbortController();
		let signal: AbortSignal | undefined;
		let rejectPrompt: (() => void) | undefined;
		const work = auth
			.login({
				signal: owner.signal,
				notify: () => {},
				prompt: (prompt) => {
					signal = prompt.signal;
					return new Promise<string>((_resolve, reject) => {
						rejectPrompt = () => reject(new Error("fake select cancelled"));
						prompt.signal?.addEventListener("abort", rejectPrompt, { once: true });
					});
				},
			})
			.then(
				() => undefined,
				() => undefined,
			);
		await vi.advanceTimersByTimeAsync(15 * 60_000 + 100);
		const metDeadline = signal?.aborted;
		owner.abort();
		rejectPrompt?.();
		await work;
		expect(metDeadline).toBe(true);
	},
);

// PR #131 F03: an accepted pre-built real SDK client is also a logging receiver.
it("F03 injected Anthropic SDK client logging is safe without mutating caller client", async () => {
	const logs: unknown[] = [];
	for (const level of ["debug", "info", "warn", "error"] as const)
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			logs.push(args);
		});
	const client = new Anthropic({
		apiKey: "fake",
		baseURL: "http://mock.test/v1",
		logLevel: "debug",
		fetch: async () => Response.json({ error: { message: plainSecret } }, { status: 400 }),
	});
	const result = await anthropicStream({ ...chat, api: "anthropic-messages" }, normalizeContext({ messages: [] }), {
		client,
		diagnosticSecrets: [plainSecret],
		maxRetries: 0,
	}).result();
	expect(client.logLevel).toBe("debug");
	expect(result.stopReason).toBe("error");
	privateDiagnostic(logs);
});
// PR #131 F11: the Radius device poll admission shares one finite budget across token attempts and sleeps.
it("F11 Radius bounds whole polling operation", async () => {
	vi.useFakeTimers();
	let calls = 0;
	let settled = false;
	vi.stubGlobal("fetch", async () =>
		++calls === 1
			? Response.json({
					device_code: "fake-device",
					user_code: "fake-user",
					verification_uri: "http://mock.test/verify",
					interval: 5,
					expires_in: 7200,
				})
			: Response.json({ error: "authorization_pending" }, { status: 400 }),
	);
	const owner = new AbortController();
	const auth = createRadiusOAuth({ name: "fake", gateway: "http://mock.test" });
	const operation = auth.login({ signal: owner.signal, prompt: async () => "device-code", notify: () => {} }).then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await vi.advanceTimersByTimeAsync(15 * 60_000 + 100);
	const metDeadline = settled;
	owner.abort();
	await operation;
	expect(calls).toBeGreaterThan(1);
	expect(metDeadline).toBe(true);
});

// PR #131 F11: the finite default owns trickling success/error bodies, not only headers.
it.each([200, 400])("F11 System One default deadline retires trickling %s body", async (status) => {
	vi.useFakeTimers();
	let retired = false;
	let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			producer = controller;
		},
		cancel() {
			retired = true;
		},
	});
	const trickle = setInterval(() => {
		if (!retired) producer?.enqueue(new Uint8Array([32]));
	}, 1000);
	const work = systemClassify({ ...classifier, api: "typesafe-system-one" }, context, {
		apiKey: "fake",
		maxRetries: 0,
		fetch: async (_input, init) => {
			init?.signal?.addEventListener(
				"abort",
				() => {
					if (!retired) {
						retired = true;
						producer?.error(new Error("fake native body aborted"));
					}
				},
				{ once: true },
			);
			return new Response(body, { status });
		},
	});
	await vi.advanceTimersByTimeAsync(61_000);
	const metDeadline = retired;
	clearInterval(trickle);
	if (!retired) producer?.close();
	await work;
	expect(metDeadline).toBe(true);
});

// PR #131 F05: unsupported serialization must fail closed, not introduce an unbounded decoder.
it("F05 masks supported JSON layers and withholds diagnostics beyond the fixed budget", () => {
	let text = secret;
	for (let depth = 0; depth < 7; depth++) {
		const result = redactOAuthDiagnostic(`unrelated ${text}`, [secret]);
		expect(result === "Provider diagnostic details withheld" || result === "unrelated ***").toBe(true);
		text = JSON.stringify(text).slice(1, -1);
	}
});
it("F05 withholds uncertain unlabeled Unicode-escaped known credential diagnostics", () => {
	const text = [...plainSecret]
		.map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
		.join("");
	expect(redactOAuthDiagnostic(text, [plainSecret])).toBe("Provider diagnostic details withheld");
});

// PR #131 F11: native URL parser errors from a retained OAuth bootstrap must not expose response values.
it("F11 Radius bootstrap native parser failure is value-free", async () => {
	const auth = createRadiusOAuth({ name: "fake", gateway: "http://mock.test" });
	vi.stubGlobal("fetch", async () => Response.json({ authorizationEndpoint: plainSecret }));
	const failure = await auth
		.login({ signal: new AbortController().signal, prompt: async () => "browser", notify: () => {} })
		.then(
			() => "unexpected success",
			(error: unknown) =>
				error instanceof Error ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : String(error),
		);
	expect(failure).not.toBe("unexpected success");
	privateDiagnostic(failure);
});
