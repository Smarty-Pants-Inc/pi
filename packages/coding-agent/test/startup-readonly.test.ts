import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getPackageDir } from "../src/config.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import { migrateAuthToAuthJson } from "../src/migrations.ts";

// Keep the real filesystem, with replaceable exports for deterministic OS failures.
vi.mock("fs", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }));

let tempRoot: string;
let agentDir: string;
let projectDir: string;

beforeEach(() => {
	tempRoot = fs.mkdtempSync(join(tmpdir(), "pi-startup-readonly-"));
	agentDir = join(tempRoot, "agent");
	projectDir = join(tempRoot, "project");
	fs.mkdirSync(projectDir);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	// Only the fresh directory created by this test is made writable and removed.
	if (fs.existsSync(agentDir)) fs.chmodSync(agentDir, 0o700);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

// #4605: startup must explain an unwritable session directory without changing storage mode.
describe("startup session directory failures", () => {
	it.each(["EROFS", "EACCES", "EPERM"])("explains default session mkdir %s", (code) => {
		const failure = Object.assign(new Error("synthetic mkdir failure"), { code });
		const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
			throw failure;
		});
		let caught: unknown;
		try {
			SessionManager.create(projectDir);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBe(failure);
		expect((caught as Error).cause).toBe(failure);
		const attemptedDir = String(mkdir.mock.calls[0][0]);
		expect(attemptedDir.startsWith(join(agentDir, "sessions"))).toBe(true);
		expect((caught as Error).message).toContain(attemptedDir);
		expect((caught as Error).message).toContain(code);
		expect((caught as Error).message).toContain("--session-dir <writable-directory>");
		expect((caught as Error).message).toContain("--no-session");
	});

	it.each(["EROFS", "EACCES", "EPERM"])("explains constructor session mkdir %s", (code) => {
		const sessionDir = join(tempRoot, "custom-sessions");
		const failure = Object.assign(new Error("synthetic mkdir failure"), { code });
		vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
			throw failure;
		});

		expect(() => SessionManager.create(projectDir, sessionDir)).toThrow(
			expect.objectContaining({ cause: failure, message: expect.stringContaining(sessionDir) }),
		);
	});

	it.each([false, true])("preserves other mkdir errors with custom directory=%s", (custom) => {
		const failure = Object.assign(new Error("synthetic I/O failure"), { code: "EIO" });
		vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
			throw failure;
		});

		try {
			SessionManager.create(projectDir, custom ? join(tempRoot, "custom-sessions") : undefined);
			expect.fail("Expected the original mkdir failure");
		} catch (error) {
			expect(error).toBe(failure);
		}
	});

	it("keeps no-session in memory even when mkdir and file writes are denied", () => {
		const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
			throw Object.assign(new Error("synthetic read-only filesystem"), { code: "EROFS" });
		});
		const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
			throw Object.assign(new Error("synthetic read-only filesystem"), { code: "EROFS" });
		});
		const manager = SessionManager.inMemory(projectDir);
		manager.appendMessage({ role: "user", content: "synthetic prompt", timestamp: 1 });

		expect(manager.isPersisted()).toBe(false);
		expect(manager.getSessionFile()).toBeUndefined();
		expect(manager.buildSessionContext().messages).toHaveLength(1);
		expect(mkdir).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("creates and persists a normal session on a writable filesystem", () => {
		const manager = SessionManager.create(projectDir);
		manager.appendMessage({ role: "user", content: "synthetic prompt", timestamp: 1 });

		expect(manager.getSessionDir()).toBe(getDefaultSessionDir(projectDir));
		expect(SessionManager.open(manager.getSessionFile()!).buildSessionContext()).toEqual(
			manager.buildSessionContext(),
		);
	});

	it("uses a writable custom session directory without touching the denied default path", () => {
		const originalMkdir = fs.mkdirSync;
		const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation((path, options) => {
			if (String(path).startsWith(agentDir)) {
				throw Object.assign(new Error("synthetic read-only filesystem"), { code: "EROFS" });
			}
			return originalMkdir(path, options);
		});
		const sessionDir = join(tempRoot, "custom-sessions");
		const manager = SessionManager.create(projectDir, sessionDir);
		manager.appendMessage({ role: "user", content: "synthetic prompt", timestamp: 1 });

		expect(manager.getSessionDir()).toBe(sessionDir);
		expect(SessionManager.open(manager.getSessionFile()!).buildSessionContext()).toEqual(
			manager.buildSessionContext(),
		);
		expect(mkdir.mock.calls.every(([path]) => !String(path).startsWith(agentDir))).toBe(true);
		expect(fs.existsSync(agentDir)).toBe(false);
	});
});

const oauth = { anthropic: { access: "synthetic-access", refresh: "synthetic-refresh", expires: 123 } };
const apiKeys = { anthropic: "synthetic-shadowed-key", openai: "synthetic-api-key" };
const settings = { theme: "dark", retry: { enabled: false }, apiKeys };
const oauthContent = `${JSON.stringify(oauth, null, 2)}\n`;
const settingsContent = `${JSON.stringify(settings, null, 2)}\n`;
const expectedAuth = {
	anthropic: { type: "oauth", ...oauth.anthropic },
	openai: { type: "api_key", key: apiKeys.openai },
};

function writeLegacyCredentials(): void {
	fs.mkdirSync(agentDir);
	fs.writeFileSync(join(agentDir, "oauth.json"), oauthContent);
	fs.writeFileSync(join(agentDir, "settings.json"), settingsContent);
}

function expectSuccessfulMigration(): void {
	expect(JSON.parse(fs.readFileSync(join(agentDir, "auth.json"), "utf8"))).toEqual(expectedAuth);
	expect(fs.existsSync(join(agentDir, "oauth.json"))).toBe(false);
	expect(fs.readFileSync(join(agentDir, "oauth.json.migrated"), "utf8")).toBe(oauthContent);
	expect(JSON.parse(fs.readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
		theme: settings.theme,
		retry: settings.retry,
	});
}

// #4605: a failed auth write must never consume the only copy of legacy credentials.
describe("startup auth migration on read-only storage", () => {
	it.each(
		["EROFS", "EACCES", "EPERM"].flatMap((code) => ["mkdir", "write"].map((operation) => ({ code, operation }))),
	)("preserves legacy data after $operation $code and succeeds on retry", ({ operation, code }) => {
		writeLegacyCredentials();
		const authPath = join(agentDir, "auth.json");
		// Deliberately put synthetic secrets in the exception to catch accidental logging.
		const failure = Object.assign(new Error(`${oauth.anthropic.access} ${apiKeys.openai}`), { code });
		const fail = operation === "mkdir" ? vi.spyOn(fs, "mkdirSync") : vi.spyOn(fs, "writeFileSync");
		fail.mockImplementationOnce(() => {
			throw failure;
		});
		const warning = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(migrateAuthToAuthJson()).toEqual([]);
		expect(String(fail.mock.calls[0][0])).toBe(operation === "mkdir" ? agentDir : authPath);
		expect(fs.existsSync(authPath)).toBe(false);
		expect(fs.readFileSync(join(agentDir, "oauth.json"), "utf8")).toBe(oauthContent);
		expect(fs.existsSync(join(agentDir, "oauth.json.migrated"))).toBe(false);
		expect(fs.readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(settingsContent);
		expect(warning).toHaveBeenCalledTimes(1);
		const message = warning.mock.calls.flat().join(" ");
		expect(message).toContain(authPath);
		expect(message).toContain("writable");
		expect(message).toContain("restart to retry");
		for (const secret of [
			...Object.values(oauth.anthropic).filter((value) => typeof value === "string"),
			...Object.values(apiKeys),
		]) {
			expect(message).not.toContain(secret);
		}

		fail.mockRestore();
		expect(migrateAuthToAuthJson()).toEqual(["anthropic", "openai"]);
		expectSuccessfulMigration();
		expect(warning).toHaveBeenCalledTimes(1);
	});

	it("persists auth before cleaning up legacy input and does not migrate again", () => {
		writeLegacyCredentials();
		const warning = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(migrateAuthToAuthJson()).toEqual(["anthropic", "openai"]);
		expectSuccessfulMigration();
		if (process.platform !== "win32") {
			expect(fs.statSync(join(agentDir, "auth.json")).mode & 0o777).toBe(0o600);
		}
		expect(migrateAuthToAuthJson()).toEqual([]);
		expect(warning).not.toHaveBeenCalled();
	});

	it.each(["missing directory", "settings without keys", "empty legacy credentials"])(
		"does not mkdir, write, or warn with %s",
		(kind) => {
			if (kind !== "missing directory") {
				fs.mkdirSync(agentDir);
				fs.writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify(kind === "empty legacy credentials" ? { theme: "dark", apiKeys: {} } : { theme: "dark" }),
				);
				if (kind === "empty legacy credentials") fs.writeFileSync(join(agentDir, "oauth.json"), "{}");
			}
			const mkdir = vi.spyOn(fs, "mkdirSync");
			const write = vi.spyOn(fs, "writeFileSync");
			const warning = vi.spyOn(console, "error").mockImplementation(() => {});

			expect(migrateAuthToAuthJson()).toEqual([]);
			expect(fs.existsSync(join(agentDir, "auth.json"))).toBe(false);
			expect(mkdir).not.toHaveBeenCalled();
			expect(write).not.toHaveBeenCalled();
			expect(warning).not.toHaveBeenCalled();
		},
	);

	it("leaves existing auth and legacy inputs untouched", () => {
		writeLegacyCredentials();
		const authPath = join(agentDir, "auth.json");
		const originalAuth = '{"existing":{"type":"api_key","key":"synthetic-existing-key"}}\n';
		fs.writeFileSync(authPath, originalAuth);
		const mkdir = vi.spyOn(fs, "mkdirSync");
		const write = vi.spyOn(fs, "writeFileSync");
		const warning = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(migrateAuthToAuthJson()).toEqual([]);
		expect(fs.readFileSync(authPath, "utf8")).toBe(originalAuth);
		expect(fs.readFileSync(join(agentDir, "oauth.json"), "utf8")).toBe(oauthContent);
		expect(fs.readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(settingsContent);
		expect(mkdir).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(warning).not.toHaveBeenCalled();
	});
});

const cliPath = join(getPackageDir(), "src", "cli.ts");
const sourceResolverUrl = pathToFileURL(join(getPackageDir(), "src", "experimental", "source-resolver.ts")).href;

async function runCli(args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
	let stderr = "";
	const child = spawn(
		process.execPath,
		[
			"--import",
			sourceResolverUrl,
			cliPath,
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-tools",
			"--model",
			"missing-model",
			"-p",
			...args,
		],
		{
			cwd: projectDir,
			// No inherited provider keys, real home, NODE_OPTIONS, or session-dir overrides.
			env: {
				PATH: process.env.PATH,
				HOME: tempRoot,
				USERPROFILE: tempRoot,
				XDG_CONFIG_HOME: join(tempRoot, "config"),
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				NO_COLOR: "1",
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			resolve({ code, signal, stderr });
		});
	});
}

// #4605: exercise main() through the real CLI, not only the SDK exception.
// chmod cannot deny root and does not provide this permission model on Windows.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("read-only startup CLI", () => {
	it.each(["default", "no-session", "custom"])("handles %s session storage", async (mode) => {
		fs.mkdirSync(agentDir);
		fs.chmodSync(agentDir, 0o500);
		const customDir = join(tempRoot, "writable-sessions");
		const args = mode === "no-session" ? ["--no-session"] : mode === "custom" ? ["--session-dir", customDir] : [];
		const result = await runCli(args);

		expect(result.code).toBe(1);
		expect(result.signal).toBeNull();
		expect(result.stderr).not.toMatch(/\n\s+at\s|node:internal|UnhandledPromiseRejection|\[cause\]/);
		if (mode === "default") {
			expect(result.stderr).toMatch(/^Error: Cannot create session directory /m);
			expect(result.stderr).toContain(join(agentDir, "sessions"));
			expect(result.stderr).toContain("--session-dir <writable-directory>");
			expect(result.stderr).toContain("--no-session");
			expect(result.stderr).not.toContain('Model "missing-model" not found');
		} else {
			expect(result.stderr).toContain('Model "missing-model" not found');
			expect(result.stderr).not.toContain("Cannot create session directory");
			if (mode === "custom") expect(fs.statSync(customDir).isDirectory()).toBe(true);
		}
		expect(fs.readdirSync(agentDir)).toEqual([]);
	});
});
