import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectSettingsDiagnostics } from "../src/core/settings-diagnostics.ts";
import { FileSettingsStorage, SettingsManager, type SettingsScope } from "../src/core/settings-manager.ts";

// smarty-dev#4605: a settings lock permission failure must not discard readable settings or their policy.
// Keep these integration tests for data safety and the project-trust boundary; all files are test-owned.
describe("read-only settings fallback", () => {
	const globalSettings = {
		$schema: "https://pi.dev/schemas/settings.schema.json",
		lastChangelogVersion: "1.2.3",
		defaultProvider: "openai",
		defaultModel: "allowed",
		defaultThinkingLevel: "xhigh",
		modelThinkingLevels: { "openai/allowed": "max", "openai/global-only": "high" },
		thinkingBudgets: { minimal: 17, low: 101, medium: 2001, high: 12001 },
		transport: "sse",
		steeringMode: "all",
		followUpMode: "all",
		theme: "saved-theme",
		compaction: {
			enabled: false,
			reserveTokens: 9001,
			keepRecentTokens: 19001,
			modelOverrides: { "openai/allowed": { reserveTokens: 8001, keepRecentTokens: 18001 } },
		},
		branchSummary: { reserveTokens: 10001, skipPrompt: true },
		retry: { enabled: false, maxRetries: 7, baseDelayMs: 113, provider: { maxRetries: 2, timeoutMs: 777 } },
		defaultTools: ["read", "bash", "write"],
		modelPolicy: { allow: ["openai/allowed", "openai/global-only"] },
		enabledModels: ["openai/allowed"],
		quietStartup: "header",
		defaultProjectTrust: "never",
		cacheWarming: "off",
		hideThinkingBlock: true,
		showCacheMissNotices: true,
		externalEditor: "saved-editor --wait",
		shellPath: "/saved/shell",
		shellCommandPrefix: "saved-prefix",
		npmCommand: ["saved-npm", "--offline"],
		packages: ["npm:saved-fixture", { source: "./fixture", extensions: [], skills: ["skill.md"] }],
		extensions: ["./extension.ts"],
		skills: ["./skills"],
		prompts: ["./prompts"],
		themes: ["./themes"],
		enableSkillCommands: false,
		enableInstallTelemetry: false,
		enableAnalytics: false,
		trackingId: "saved-tracking-id",
		deviceId: "saved-device-id",
		terminal: { showImages: false, images: "kitty", trueColor: false, hyperlinks: true },
		images: { autoResize: false, blockImages: true },
		markdown: { codeBlockIndent: "    ", mermaid: "off" },
		warnings: { anthropicExtraUsage: false },
		codemode: { mode: "only", inlineBudget: 999 },
		sessionDir: "./saved-sessions",
		httpProxy: "http://proxy.invalid:8080",
		httpIdleTimeoutMs: 12345,
		websocketConnectTimeoutMs: 6789,
		tuiMode: "regular",
		fullscreenExitOutput: "resume-hint",
		fullscreenScrollbar: "hidden",
		fullscreenCopyOnSelect: false,
		fullscreenWheelScrollLines: 7,
		customSetting: { nested: { array: [1, false, null, "saved"] }, empty: {} },
	};
	const projectSettings = {
		theme: "project-theme",
		compaction: { enabled: true },
		retry: { provider: { maxRetries: 5 } },
		defaultTools: ["-write", "+grep"],
		modelPolicy: { allow: ["*/allowed", "openai/project-only"] },
		packages: ["npm:project-fixture"],
		customProjectSetting: { nested: ["preserved", 0, false] },
	};
	const effectiveSettings = {
		...globalSettings,
		...projectSettings,
		compaction: { ...globalSettings.compaction, ...projectSettings.compaction },
		retry: {
			...globalSettings.retry,
			provider: { ...globalSettings.retry.provider, ...projectSettings.retry.provider },
		},
		defaultTools: [...globalSettings.defaultTools, ...projectSettings.defaultTools],
	};
	const globalContents = JSON.stringify(globalSettings, null, 2);
	const projectContents = JSON.stringify(projectSettings, null, 2);
	const allowed = { provider: "openai", id: "allowed" };
	const globalOnly = { provider: "openai", id: "global-only" };
	const projectOnly = { provider: "openai", id: "project-only" };
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let paths: Record<SettingsScope, string>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-settings-readonly-"));
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		paths = { global: join(agentDir, "settings.json"), project: join(projectDir, ".pi", "settings.json") };
		mkdirSync(agentDir);
		mkdirSync(dirname(paths.project), { recursive: true });
		writeFileSync(paths.global, globalContents);
		writeFileSync(paths.project, projectContents);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// Restore only the test-allocated directories before deleting the test's own tree.
		chmodSync(agentDir, 0o700);
		chmodSync(dirname(paths.project), 0o700);
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each([
		["global", "EROFS"],
		["global", "EACCES"],
		["global", "EPERM"],
		["project", "EROFS"],
		["project", "EACCES"],
		["project", "EPERM"],
	] as const)("preserves all values on %s %s and disables only that scope's disk writes", async (scope, code) => {
		const originalLockSync = lockfile.lockSync;
		let denyLock = true;
		const lockError = Object.assign(new Error(`${code}: cannot create settings lock`), { code });
		const lockSpy = vi.spyOn(lockfile, "lockSync").mockImplementation((path, options) => {
			if (path === paths[scope] && denyLock) throw lockError;
			return originalLockSync(path, options);
		});
		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getGlobalSettings()).toEqual(globalSettings);
		expect(manager.getProjectSettings()).toEqual(projectSettings);
		expect(manager.getSettings()).toEqual(effectiveSettings);
		expect(manager.isModelAllowed(allowed)).toBe(true);
		expect(manager.isModelAllowed(globalOnly)).toBe(false);
		expect(manager.isModelAllowed(projectOnly)).toBe(false);
		expect(collectSettingsDiagnostics(manager)).toEqual([
			{
				type: "warning",
				message: `Read-only settings file ${paths[scope]}: ${lockError.message}. Using unlocked reads; disk writes are disabled for this scope.`,
			},
		]);
		expect(manager.drainErrors()).toEqual([]);

		denyLock = false; // Even if locking becomes possible, this storage instance must stay read-only.
		manager.setTheme("session-theme");
		manager.setProjectPackages(["npm:session-fixture"]);
		await manager.flush();

		expect(manager.getGlobalSettings()).toEqual({ ...globalSettings, theme: "session-theme" });
		expect(manager.getProjectSettings()).toEqual({ ...projectSettings, packages: ["npm:session-fixture"] });
		expect(readFileSync(paths.global, "utf8")).toBe(
			scope === "global" ? globalContents : JSON.stringify({ ...globalSettings, theme: "session-theme" }, null, 2),
		);
		expect(readFileSync(paths.project, "utf8")).toBe(
			scope === "project"
				? projectContents
				: JSON.stringify({ ...projectSettings, packages: ["npm:session-fixture"] }, null, 2),
		);
		expect(lockSpy.mock.calls.filter(([path]) => path === paths[scope])).toHaveLength(1);

		await manager.reload();
		expect(manager.getGlobalSettings()).toEqual(
			scope === "global" ? globalSettings : { ...globalSettings, theme: "session-theme" },
		);
		expect(manager.getProjectSettings()).toEqual(
			scope === "project" ? projectSettings : { ...projectSettings, packages: ["npm:session-fixture"] },
		);
		expect(manager.isModelAllowed(allowed)).toBe(true);
		expect(collectSettingsDiagnostics(manager)).toEqual([]);
		expect(lockSpy.mock.calls.filter(([path]) => path === paths[scope])).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["global", "project"] as const)(
		"reads %s settings when the real POSIX directory cannot create a lock",
		async (scope) => {
			chmodSync(dirname(paths[scope]), 0o555);
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getGlobalSettings()).toEqual(globalSettings);
			expect(manager.getProjectSettings()).toEqual(projectSettings);
			expect(manager.getSettings()).toEqual(effectiveSettings);
			expect(manager.isModelAllowed(allowed)).toBe(true);
			expect(manager.isModelAllowed(globalOnly)).toBe(false);
			expect(manager.isModelAllowed(projectOnly)).toBe(false);
			expect(manager.drainErrors()).toMatchObject([
				{ scope, path: paths[scope], kind: "read-only", error: { code: "EACCES" } },
			]);

			chmodSync(dirname(paths[scope]), 0o700);
			manager.setTheme("after-chmod");
			manager.setProjectPackages(["npm:after-chmod"]);
			await manager.flush();
			expect(readFileSync(paths[scope], "utf8")).toBe(scope === "global" ? globalContents : projectContents);
			const otherScope = scope === "global" ? "project" : "global";
			expect(JSON.parse(readFileSync(paths[otherScope], "utf8"))).toEqual(
				scope === "global"
					? { ...projectSettings, packages: ["npm:after-chmod"] }
					: { ...globalSettings, theme: "after-chmod" },
			);
			expect(manager.drainErrors()).toEqual([]);
		},
	);

	it("skips untrusted project settings during bootstrap and reports fallback only when trust is granted", async () => {
		const lockSpy = vi.spyOn(lockfile, "lockSync").mockImplementation((path) => {
			throw Object.assign(new Error(`read-only lock ${path}`), { code: "EROFS" });
		});
		const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

		expect(manager.getSettings()).toEqual(globalSettings);
		expect(manager.getProjectSettings()).toEqual({});
		expect(manager.getDefaultProjectTrust()).toBe("never");
		expect(manager.isModelAllowed(globalOnly)).toBe(true);
		expect(manager.isModelAllowed(projectOnly)).toBe(false);
		expect(collectSettingsDiagnostics(manager)).toMatchObject([
			{ type: "warning", message: expect.stringContaining(`Read-only settings file ${paths.global}:`) },
		]);
		await manager.reload();
		expect(manager.getSettings()).toEqual(globalSettings);
		expect(collectSettingsDiagnostics(manager)).toEqual([]);
		expect(lockSpy).toHaveBeenCalledTimes(1);

		manager.setProjectTrusted(true);
		expect(manager.getSettings()).toEqual(effectiveSettings);
		expect(manager.isModelAllowed(allowed)).toBe(true);
		expect(manager.isModelAllowed(globalOnly)).toBe(false);
		expect(collectSettingsDiagnostics(manager)).toMatchObject([
			{ type: "warning", message: expect.stringContaining(`Read-only settings file ${paths.project}:`) },
		]);

		manager.setProjectTrusted(false);
		await manager.reload();
		expect(manager.getSettings()).toEqual(globalSettings);
		expect(manager.isModelAllowed(globalOnly)).toBe(true);
		expect(() => manager.setProjectPackages(["npm:untrusted"])).toThrow("Project is not trusted");
		manager.setProjectTrusted(true);
		manager.setProjectPackages(["npm:trusted-session"]);
		await manager.flush();
		expect(readFileSync(paths.project, "utf8")).toBe(projectContents);
		expect(collectSettingsDiagnostics(manager)).toEqual([]);
		expect(lockSpy).toHaveBeenCalledTimes(2);
	});

	it("can enter read-only mode on reload and keeps evaluating the newly read policy", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(collectSettingsDiagnostics(manager)).toEqual([]);
		const originalLockSync = lockfile.lockSync;
		vi.spyOn(lockfile, "lockSync").mockImplementation((path, options) => {
			if (path === paths.global) throw Object.assign(new Error("read-only lock"), { code: "EROFS" });
			return originalLockSync(path, options);
		});
		const changed = {
			...globalSettings,
			defaultThinkingLevel: "max",
			modelPolicy: { allow: ["openai/project-only"] },
		};
		const changedContents = JSON.stringify(changed, null, 2);
		writeFileSync(paths.global, changedContents);

		await manager.reload();
		expect(manager.getGlobalSettings()).toEqual(changed);
		expect(manager.getProjectSettings()).toEqual(projectSettings);
		expect(manager.isModelAllowed(allowed)).toBe(false);
		expect(manager.isModelAllowed(projectOnly)).toBe(true);
		expect(collectSettingsDiagnostics(manager)).toMatchObject([
			{ type: "warning", message: expect.stringContaining(`Read-only settings file ${paths.global}:`) },
		]);
		manager.setTheme("not-persisted");
		await manager.flush();
		expect(readFileSync(paths.global, "utf8")).toBe(changedContents);
		await manager.reload();
		expect(manager.getGlobalSettings()).toEqual(changed);
		expect(manager.isModelAllowed(projectOnly)).toBe(true);
		expect(collectSettingsDiagnostics(manager)).toEqual([]);
	});

	it.each(["", "{", "null", "[]", "42", '"not an object"'])(
		"does not turn invalid settings %j into a successful load after fallback",
		async (contents) => {
			writeFileSync(paths.global, contents);
			const originalLockSync = lockfile.lockSync;
			vi.spyOn(lockfile, "lockSync").mockImplementation((path, options) => {
				if (path === paths.global) throw Object.assign(new Error("read-only lock"), { code: "EPERM" });
				return originalLockSync(path, options);
			});
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getGlobalSettings()).toEqual({});
			expect(manager.isModelAllowed(allowed)).toBe(false);
			expect(manager.isModelAllowed(projectOnly)).toBe(false);
			const diagnostics = collectSettingsDiagnostics(manager);
			expect(diagnostics).toHaveLength(2);
			expect(diagnostics).toEqual(
				expect.arrayContaining([
					{ type: "warning", message: expect.stringContaining(`Invalid settings file ${paths.global}:`) },
					{ type: "warning", message: expect.stringContaining(`Read-only settings file ${paths.global}:`) },
				]),
			);
			manager.setTheme("not-persisted");
			await manager.flush();
			expect(readFileSync(paths.global, "utf8")).toBe(contents);
		},
	);

	it.each(["global", "project"] as const)("propagates %s read errors after a lock permission failure", (scope) => {
		rmSync(paths[scope]);
		mkdirSync(paths[scope]);
		vi.spyOn(lockfile, "lockSync").mockImplementation(() => {
			throw Object.assign(new Error("read-only lock"), { code: "EROFS" });
		});
		const storage = new FileSettingsStorage(projectDir, agentDir);
		const read = vi.fn(() => undefined);

		expect(() => storage.withLock(scope, read)).toThrow();
		expect(read).not.toHaveBeenCalled();
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.isModelAllowed(allowed)).toBe(false);
		expect(manager.drainErrors().filter(({ kind }) => kind === undefined)).toMatchObject([
			{ scope, error: expect.any(Error) },
		]);
	});

	it("keeps the last snapshot but fails policy closed if a later unlocked read is invalid", async () => {
		vi.spyOn(lockfile, "lockSync").mockImplementation(() => {
			throw Object.assign(new Error("read-only lock"), { code: "EROFS" });
		});
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.drainErrors();
		writeFileSync(paths.global, "{");
		await manager.reload();

		expect(manager.getGlobalSettings()).toEqual(globalSettings);
		expect(manager.isModelAllowed(allowed)).toBe(false);
		expect(collectSettingsDiagnostics(manager)).toMatchObject([
			{ type: "warning", message: expect.stringContaining(`Invalid settings file ${paths.global}:`) },
		]);
		writeFileSync(paths.global, globalContents);
		await manager.reload();
		expect(manager.isModelAllowed(allowed)).toBe(true);
		manager.setTheme("still-not-persisted");
		await manager.flush();
		expect(readFileSync(paths.global, "utf8")).toBe(globalContents);
		expect(manager.drainErrors()).toEqual([]);
	});

	it.each([{ allow: [] }, { allow: "*" }, null])("preserves and enforces restrictive policy %j", (modelPolicy) => {
		const settings = { ...globalSettings, modelPolicy };
		writeFileSync(paths.global, JSON.stringify(settings));
		vi.spyOn(lockfile, "lockSync").mockImplementation(() => {
			throw Object.assign(new Error("read-only lock"), { code: "EROFS" });
		});
		const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

		expect(manager.getSettings()).toEqual(settings);
		expect(manager.isModelAllowed(allowed)).toBe(false);
		expect(manager.isModelAllowed(globalOnly)).toBe(false);
		expect(manager.drainErrors()).toMatchObject([{ scope: "global", kind: "read-only" }]);
	});

	it("also disables writes when a missing file's first write cannot acquire its lock", async () => {
		rmSync(paths.global);
		const manager = SettingsManager.create(projectDir, agentDir);
		const originalLockSync = lockfile.lockSync;
		vi.spyOn(lockfile, "lockSync").mockImplementation((path, options) => {
			if (path === paths.global) throw Object.assign(new Error("read-only lock"), { code: "EROFS" });
			return originalLockSync(path, options);
		});

		manager.setTheme("session-only");
		await manager.flush();
		expect(manager.getGlobalSettings()).toEqual({ theme: "session-only" });
		expect(existsSync(paths.global)).toBe(false);
		expect(manager.drainErrors()).toMatchObject([{ scope: "global", path: paths.global, kind: "read-only" }]);
		vi.restoreAllMocks();
		manager.setTheme("still-session-only");
		await manager.flush();
		expect(existsSync(paths.global)).toBe(false);

		const fresh = SettingsManager.create(projectDir, agentDir);
		fresh.setTheme("fresh-storage-can-write");
		await fresh.flush();
		expect(JSON.parse(readFileSync(paths.global, "utf8"))).toEqual({ theme: "fresh-storage-can-write" });
	});

	it("still retries ELOCKED and can read and write normally once the lock succeeds", async () => {
		const originalLockSync = lockfile.lockSync;
		let attempts = 0;
		vi.spyOn(lockfile, "lockSync").mockImplementation((path, options) => {
			if (path === paths.global && ++attempts <= 3) {
				throw Object.assign(new Error("busy lock"), { code: "ELOCKED" });
			}
			return originalLockSync(path, options);
		});
		const manager = SettingsManager.create(projectDir, agentDir);

		expect(attempts).toBe(4);
		expect(manager.getGlobalSettings()).toEqual(globalSettings);
		expect(manager.getProjectSettings()).toEqual(projectSettings);
		expect(manager.getSettings()).toEqual(effectiveSettings);
		expect(manager.isModelAllowed(allowed)).toBe(true);
		expect(manager.drainErrors()).toEqual([]);
		manager.setTheme("lock-recovered");
		await manager.flush();
		expect(JSON.parse(readFileSync(paths.global, "utf8"))).toEqual({ ...globalSettings, theme: "lock-recovered" });
		expect(manager.drainErrors()).toEqual([]);
	});

	it.each(["global", "project"] as const)("fails closed when the %s lock exhausts ELOCKED retries", async (scope) => {
		const originalLockSync = lockfile.lockSync;
		const lockError = Object.assign(new Error("busy lock"), { code: "ELOCKED" });
		let denyLock = true;
		const lockSpy = vi.spyOn(lockfile, "lockSync").mockImplementation((path, options) => {
			if (path === paths[scope] && denyLock) throw lockError;
			return originalLockSync(path, options);
		});
		const manager = SettingsManager.create(projectDir, agentDir);

		expect(lockSpy.mock.calls.filter(([path]) => path === paths[scope])).toHaveLength(10);
		expect(scope === "global" ? manager.getGlobalSettings() : manager.getProjectSettings()).toEqual({});
		expect(manager.isModelAllowed(allowed)).toBe(false);
		expect(manager.isModelAllowed(globalOnly)).toBe(false);
		expect(manager.isModelAllowed(projectOnly)).toBe(false);
		expect(manager.drainErrors()).toEqual([{ scope, path: paths[scope], error: lockError }]);
		manager.setTheme("session-theme");
		manager.setProjectPackages(["npm:session-fixture"]);
		await manager.flush();
		expect(readFileSync(paths[scope], "utf8")).toBe(scope === "global" ? globalContents : projectContents);
		expect(lockSpy.mock.calls.filter(([path]) => path === paths[scope])).toHaveLength(10);

		denyLock = false;
		await manager.reload();
		expect(manager.isModelAllowed(allowed)).toBe(true);
		expect(manager.drainErrors()).toEqual([]);
		manager.setTheme("recovered-theme");
		manager.setProjectPackages(["npm:recovered"]);
		await manager.flush();
		expect(JSON.parse(readFileSync(paths[scope], "utf8"))).toEqual(
			scope === "global"
				? { ...globalSettings, theme: "recovered-theme" }
				: { ...projectSettings, packages: ["npm:recovered"] },
		);
	});
});
