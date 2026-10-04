import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const refresh = "FAKE_131_R3_STORED_REFRESH";
const idToken = "FAKE_131_R3_STORED_ID";
const override = "FAKE_131_R3_HEADER_OVERRIDE";
const transformed = "FAKE_131_R3_HEADER_TRANSFORM";
const opaque = 'FAKE_131_R3_OPAQUE"\\suffix';
async function runtime() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai", async () => ({
		type: "oauth",
		access: "fake-access",
		refresh,
		idToken,
		accountId: opaque,
		expires: Date.now() + 3600000,
	}));
	return ModelRuntime.create({ credentials, modelsPath: null });
}
function expectPrivate(value: unknown, secret: string) {
	const text = JSON.stringify(value);
	let variant = secret;
	for (let depth = 0; depth < 3; depth++) {
		expect(text).not.toContain(variant);
		variant = JSON.stringify(variant).slice(1, -1);
	}
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

// PR #131 F04: stored refresh/ID values cross the direct ModelRuntime preparation, not Models.applyAuth.
describe.each([refresh, idToken])("F04 direct %s", (secret) => {
	it("masks actual returned provider error and SDK logs", async () => {
		const models = await runtime();
		const model = {
			...models.getProvider("openai")!.getModels()[0],
			baseUrl: "http://mock.test/v1",
		} as Model<"openai-responses">;
		vi.stubEnv("OPENAI_LOG", "debug");
		const logs: unknown[] = [];
		for (const level of ["debug", "info", "warn", "error"] as const)
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logs.push(args);
			});
		const output = await models.completeSimple(
			model,
			{ messages: [] },
			{
				maxRetries: 0,
				fetch: async () => Response.json({ error: { message: `unrelated ${secret}` } }, { status: 400 }),
			},
		);
		expect(output.stopReason).toBe("error");
		expectPrivate(output, secret);
		expectPrivate(logs, secret);
	});
});

// PR #131 F04/F05: preserve stored, full/bare override, and transformed values before/after transform.
it("F04 forwards the full stored/pre/post-transform secret set", async () => {
	const models = await runtime();
	const provider = models.getProvider("openai")!;
	const model = provider.getModels()[0];
	let received: readonly string[] | undefined;
	vi.spyOn(provider, "streamSimple").mockImplementation((_model, _context, options) => {
		received = options?.diagnosticSecrets;
		throw new Error("captured safely");
	});
	await models.completeSimple(
		model,
		{ messages: [] },
		{
			headers: { Authorization: `Bearer ${override}` },
			diagnosticSecrets: [opaque],
			transformHeaders: async () => ({ Authorization: `Bearer ${transformed}` }),
		},
	);
	expect(received).toEqual(
		expect.arrayContaining([
			refresh,
			idToken,
			opaque,
			override,
			`Bearer ${override}`,
			transformed,
			`Bearer ${transformed}`,
		]),
	);
});

// PR #131 F04: the SDK really routes agent dispatch through ModelRuntime, with no deleting suite cleanup.
describe.each([refresh, idToken])("F04 actual SDK/session %s", (secret) => {
	it.each(["events", "logs"])("masks %s through actual SDK dispatch", async (receiver) => {
		const models = await runtime();
		const model = { ...models.getProvider("openai")!.getModels()[0], baseUrl: "http://mock.test/v1" };
		const scratch = mkdtempSync(join(tmpdir(), "131-r3-sdk-"));
		vi.stubEnv("OPENAI_LOG", "debug");
		const logs: unknown[] = [];
		for (const level of ["debug", "info", "warn", "error"] as const)
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logs.push(args);
			});
		let requests = 0;
		vi.stubGlobal("fetch", async () => {
			requests++;
			return Response.json({ error: { message: `unrelated ${secret}` } }, { status: 400 });
		});
		const { session } = await createAgentSession({
			cwd: scratch,
			agentDir: scratch,
			modelRuntime: models,
			model,
			sessionManager: SessionManager.inMemory(scratch),
			settingsManager: SettingsManager.inMemory({
				retry: { enabled: false, provider: { maxRetries: 0 } },
				cacheWarming: "off",
				compaction: { enabled: false },
			}),
			resourceLoader: createTestResourceLoader(),
			tools: [],
		});
		const events: unknown[] = [];
		const unsubscribe = session.subscribe((event) => {
			events.push(event);
		});
		try {
			await session.prompt("fake offline request");
			expect(requests).toBe(1);
			expect(
				session.agent.state.messages.some(
					(message) => message.role === "assistant" && message.stopReason === "error",
				),
			).toBe(true);
			if (receiver === "logs") expectPrivate(logs, secret);
			else {
				expectPrivate(events, secret);
				expectPrivate(session.agent.state.messages, secret);
			}
		} finally {
			unsubscribe();
			session.dispose();
		}
	});
});

// PR #131 F04/F05: actual SDK before_provider_headers transforms must retain stored and pre/post credentials.
it("F04 actual SDK/session protects transformed header, stored credentials and nested JSON in errors/logs", async () => {
	const models = await runtime();
	const model = {
		...models.getProvider("openai")!.getModels()[0],
		headers: { Authorization: `Bearer ${override}` },
		baseUrl: "http://mock.test/v1",
	};
	const scratch = mkdtempSync(join(tmpdir(), "131-r3-sdk-transform-"));
	const extensionsResult = await createTestExtensionsResult(
		[
			(pi) => {
				pi.on("before_provider_headers", async (event) => {
					event.headers.Authorization = `Bearer ${transformed}`;
				});
			},
		],
		scratch,
	);
	const logs: unknown[] = [];
	vi.stubEnv("OPENAI_LOG", "debug");
	for (const level of ["debug", "info", "warn", "error"] as const)
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			logs.push(args);
		});
	let requests = 0;
	vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
		requests++;
		expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${transformed}`);
		return Response.json(
			{
				error: {
					message: `${refresh} ${idToken} ${override} ${transformed} ${JSON.stringify(JSON.stringify(opaque))}`,
				},
			},
			{ status: 400 },
		);
	});
	const { session } = await createAgentSession({
		cwd: scratch,
		agentDir: scratch,
		modelRuntime: models,
		model,
		sessionManager: SessionManager.inMemory(scratch),
		settingsManager: SettingsManager.inMemory({
			retry: { enabled: false, provider: { maxRetries: 0 } },
			cacheWarming: "off",
			compaction: { enabled: false },
		}),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		tools: [],
	});
	const events: unknown[] = [];
	const unsubscribe = session.subscribe((event) => {
		events.push(event);
	});
	try {
		await session.prompt("fake offline transform request");
		expect(requests).toBe(1);
		for (const secret of [refresh, idToken, override, transformed, opaque]) {
			expectPrivate(events, secret);
			expectPrivate(session.agent.state.messages, secret);
			expectPrivate(logs, secret);
		}
	} finally {
		unsubscribe();
		session.dispose();
	}
});
