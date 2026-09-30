import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type OAuthAuth } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { CommandResult, ModelsEvent } from "../src/experimental/mini/shared/protocol.ts";
import { ModelsService } from "../src/experimental/mini/worker/models-service.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const HOST_ID = "a1234567-1234-4123-8123-123456789abc";

async function createRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

// smarty-dev#2241 A16: use the advertised account, real selector, ModelsService, and ModelRuntime.
// Only the provider's external authentication/browser flow is replaced with an offline callback.
describe("security: mini installation identity", () => {
	let root: string;
	let agentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-security-mini-login-"));
		agentDir = join(root, "worker-agent");
		mkdirSync(agentDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		initTheme("dark");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("passes the existing global host ID from selector to provider and forwards auth events", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ deviceId: HOST_ID }));
		const projectDir = join(root, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ deviceId: "project-spoof" }));
		expect(SettingsManager.create(projectDir, agentDir).getOrCreateDeviceId()).toBe(HOST_ID);
		const runtime = await createRuntime();
		const oauth = runtime.getProvider("openai")!.auth.oauth!;
		const providerLogin = vi.spyOn(oauth, "login").mockImplementation(async (interaction, options) => {
			expect(options?.getDeviceId?.()).toBe(HOST_ID);
			interaction.notify({ type: "auth_url", url: "https://example.invalid/authorize" });
			expect(await interaction.prompt({ type: "text", message: "Offline auth answer" })).toBe("offline-answer");
			return {
				type: "oauth",
				access: "fixture-access",
				refresh: "fixture-refresh",
				expires: Date.now() + 3_600_000,
			};
		});
		const events: ModelsEvent[] = [];
		const service = new ModelsService(runtime, (event) => {
			events.push(event);
			if (event.type === "prompt") void service.authReply(event.requestId, "offline-answer");
		});
		const account = service.state.accounts.find((entry) => entry.id === "openai" && entry.authType === "oauth")!;
		expect(account).toMatchObject({ interactive: true, methodName: "OpenAI (ChatGPT subscription)" });
		let selectedLogin: Promise<CommandResult> | undefined;
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: account.id, name: account.name, authType: account.authType }],
			(providerId, authType) => {
				selectedLogin = service.login(providerId, authType);
			},
			() => {
				throw new Error("Unexpected selector cancellation");
			},
		);
		selector.handleInput("\r");
		expect(selectedLogin).toBeDefined();
		expect(await selectedLogin).toEqual({ ok: true });
		expect(providerLogin).toHaveBeenCalledOnce();
		expect(events).toContainEqual({
			type: "notice",
			notice: { type: "auth_url", url: "https://example.invalid/authorize" },
		});
		expect(
			service.state.accounts.find((entry) => entry.id === "openai" && entry.authType === "oauth")?.configured,
		).toBe(true);
		expect(SettingsManager.create(projectDir, agentDir).getOrCreateDeviceId()).toBe(HOST_ID);
	});

	it("persists a first-use identity even after cancellation and reuses it in another service", async () => {
		const runtime = await createRuntime();
		const ids: string[] = [];
		const login: OAuthAuth["login"] = async (_interaction, options) => {
			ids.push(options!.getDeviceId!());
			throw new Error("Login cancelled");
		};
		vi.spyOn(runtime.getProvider("openai")!.auth.oauth!, "login").mockImplementation(login);
		const first = new ModelsService(runtime, () => {});
		expect(await first.login("openai", "oauth")).toEqual({ ok: false, error: "Login cancelled" });
		expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		const persisted: { deviceId: string } = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(persisted.deviceId).toBe(ids[0]);

		const secondRuntime = await createRuntime();
		vi.spyOn(secondRuntime.getProvider("openai")!.auth.oauth!, "login").mockImplementation(login);
		const second = new ModelsService(secondRuntime, () => {});
		expect(await second.login("openai", "oauth")).toEqual({ ok: false, error: "Login cancelled" });
		expect(ids).toEqual([persisted.deviceId, persisted.deviceId]);
	});

	it("rejects a malformed existing host ID without replacing it or opening auth", async () => {
		const settingsPath = join(agentDir, "settings.json");
		const original = JSON.stringify({ deviceId: "not-a-host-uuid" });
		writeFileSync(settingsPath, original);
		const events: ModelsEvent[] = [];
		const service = new ModelsService(await createRuntime(), (event) => events.push(event));
		// The real ChatGPT flow validates identity before callback binding, browser notice, or token I/O.
		const result = await service.login("openai", "oauth");
		expect(result).toEqual({
			ok: false,
			error: "Sign in with ChatGPT requires a device ID (UUID) for this installation",
		});
		expect(events.filter((event) => event.type !== "state")).toEqual([]);
		expect(readFileSync(settingsPath, "utf8")).toBe(original);
	});

	it("refuses unreadable settings instead of inventing an unpersisted identity", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, "{invalid settings");
		const events: ModelsEvent[] = [];
		const service = new ModelsService(await createRuntime(), (event) => events.push(event));
		expect((await service.login("openai", "oauth")).ok).toBe(false);
		expect(events.filter((event) => event.type !== "state")).toEqual([]);
		expect(readFileSync(settingsPath, "utf8")).toBe("{invalid settings");
	});

	it("reports installation identity persistence failures instead of login success", async () => {
		const runtime = await createRuntime();
		vi.spyOn(runtime.getProvider("openai")!.auth.oauth!, "login").mockImplementation(
			async (_interaction, options) => {
				options!.getDeviceId!();
				// Block the queued settings write using the real filesystem, not a storage mock.
				mkdirSync(join(agentDir, "settings.json"));
				return {
					type: "oauth",
					access: "fixture-access",
					refresh: "fixture-refresh",
					expires: Date.now() + 3_600_000,
				};
			},
		);
		const service = new ModelsService(runtime, () => {});
		expect((await service.login("openai", "oauth")).ok).toBe(false);
	});

	it("does not create an installation ID for login methods that do not request one", async () => {
		const runtime = await createRuntime();
		vi.spyOn(runtime.getProvider("openai")!.auth.apiKey!, "login").mockResolvedValue({
			type: "api_key",
			key: "fixture-key",
		});
		const service = new ModelsService(runtime, () => {});
		expect(await service.login("openai", "api_key")).toEqual({ ok: true });
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	});
});
