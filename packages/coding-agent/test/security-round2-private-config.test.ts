import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import {
	addMcpServerConfig,
	loadMcpConfig,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "../src/extensions/mcp/config.ts";
import { McpOAuthCredentialStore } from "../src/extensions/mcp/runtime.ts";

vi.mock("node:fs", async (original) => ({ ...(await original()) }));

const FAKE = "FAKE-2241-DO-NOT-USE";
const http = { url: "https://unused.invalid/mcp", enabled: false, headers: { Authorization: FAKE } };
const mode = (path: string) => fs.statSync(path).mode & 0o777;

// #2241: all config, trust, and credentials are isolated fixtures; disabled servers never connect.
describe("private MCP config public paths", () => {
	const dirs: string[] = [];
	const initialUmask = process.umask();
	afterEach(() => {
		vi.restoreAllMocks();
		process.umask(initialUmask);
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function setup() {
		process.umask(0o022);
		const root = fs.mkdtempSync(join(tmpdir(), "pi-2241-config-"));
		dirs.push(root);
		const cwd = join(root, "project");
		fs.mkdirSync(cwd, { mode: 0o755 });
		return { root, cwd, agentDir: join(root, "global", "nested", "agent") };
	}

	async function run(args: string[], paths: { cwd: string; agentDir: string }) {
		const output: string[] = [];
		const warnings: string[] = [];
		const code = await runMcpCommand(args, {
			...paths,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			log: (line) => output.push(line),
			error: (line) => warnings.push(line),
		});
		return { code, output: output.join("\n"), warnings };
	}

	it("creates private nested global/project configs and keeps public add/update/remove/load behavior", async () => {
		const paths = setup();
		const global = join(paths.agentDir, "mcp.json");
		expect((await run(["add", "global", "--url", http.url, "--header", `Authorization=${FAKE}`], paths)).code).toBe(
			0,
		);
		for (const dir of [join(paths.root, "global"), dirname(paths.agentDir), paths.agentDir])
			expect(mode(dir)).toBe(0o700);
		expect(mode(global)).toBe(0o600);
		updateMcpServerConfig(global, "global", { enabled: false });
		expect((await run(["list", "--json"], paths)).code).toBe(0);
		expect(addMcpServerConfig(global, "global", http)).toBe(true);
		expect((await run(["add", "-l", "local", "--url", http.url], paths)).code).toBe(0);
		const project = join(paths.cwd, ".pi", "mcp.json");
		expect(mode(dirname(project))).toBe(0o700);
		expect(mode(project)).toBe(0o600);
		expect(mode(paths.cwd)).toBe(0o755);
		updateMcpServerConfig(project, "local", { enabled: false, exposure: "direct" });
		expect(loadMcpConfig({ ...paths, projectTrusted: false }).servers.map((entry) => entry.name)).toEqual(["global"]);
		new ProjectTrustStore(paths.agentDir).set(paths.cwd, true);
		expect((await run(["list", "--json"], paths)).code).toBe(0);
		expect((await run(["remove", "local", "-l"], paths)).code).toBe(0);
		expect(removeMcpServerConfig(global, "global")).toBe(true);
		expect(removeMcpServerConfig(global, "global")).toBe(false);
		expect(mode(project)).toBe(0o600);
		expect(mode(global)).toBe(0o600);
	});

	it("preserves deliberately managed directory/file modes, indentation, and unrelated content", () => {
		const paths = setup();
		fs.mkdirSync(paths.agentDir, { recursive: true });
		fs.chmodSync(paths.agentDir, 0o750);
		const path = join(paths.agentDir, "mcp.json");
		fs.writeFileSync(path, '{\n\t"keep": {"note": "managed"},\n\t"mcpServers": {}\n}\n');
		fs.chmodSync(path, 0o640);
		expect(
			addMcpServerConfig(path, "managed", {
				...http,
				headers: { Authorization: "$FAKE_TOKEN", "X-Team": "$TEAM" },
				oauth: { clientSecret: "!exit 2241" },
			}),
		).toBe(false);
		updateMcpServerConfig(path, "managed", { enabled: true, exposure: "hidden" });
		expect(removeMcpServerConfig(path, "managed")).toBe(true);
		expect(mode(paths.agentDir)).toBe(0o750);
		expect(mode(path)).toBe(0o640);
		expect(fs.readFileSync(path, "utf8")).toBe(
			'{\n\t"keep": {\n\t\t"note": "managed"\n\t},\n\t"mcpServers": {}\n}\n',
		);
	});

	// #2241 / F17: existing nonprivate files must not silently receive or retain literal credentials.
	it("refuses unsafe existing literal persistence without chmod or value leakage, but permits private literals", async () => {
		const paths = setup();
		for (const local of [false, true]) {
			const path = local ? join(paths.cwd, ".pi", "mcp.json") : join(paths.agentDir, "mcp.json");
			fs.mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
			for (const permissions of [0o644, 0o640, 0o620]) {
				const original = '{"keep":"managed","mcpServers":{}}\n';
				fs.writeFileSync(path, original);
				fs.chmodSync(path, permissions);
				const added = await run(
					[
						"add",
						...(local ? ["-l"] : []),
						"literal",
						"--url",
						http.url,
						"--header",
						`Authorization=${FAKE}`,
						"--oauth-client-secret",
						FAKE,
					],
					paths,
				);
				expect(added.code).toBe(1);
				expect(added.warnings.join()).toContain("refusing to persist literal credentials");
				expect(added.warnings.join()).toContain("0600");
				expect(added.warnings.join()).toContain("headers.Authorization");
				expect(added.warnings.join()).toContain("oauth.clientSecret");
				expect(added.warnings.join()).not.toContain(FAKE);
				expect(fs.readFileSync(path, "utf8")).toBe(original);
				expect(mode(path)).toBe(permissions);
			}
			fs.writeFileSync(
				path,
				JSON.stringify({ mcpServers: { literal: { ...http, oauth: { clientSecret: FAKE } } } }),
			);
			fs.chmodSync(path, 0o640);
			const original = fs.readFileSync(path, "utf8");
			expect(() => updateMcpServerConfig(path, "literal", { exposure: "direct" })).toThrow("refusing");
			expect(() => addMcpServerConfig(path, "ordinary", { command: "unused" })).toThrow("refusing");
			expect(fs.readFileSync(path, "utf8")).toBe(original);
			// Removing the last literal credential is an allowed remediation, with managed modes preserved.
			expect(removeMcpServerConfig(path, "literal")).toBe(true);
			expect(mode(path)).toBe(0o640);
			fs.chmodSync(path, 0o600);
			expect(addMcpServerConfig(path, "literal", { ...http, oauth: { clientSecret: FAKE } })).toBe(false);
			updateMcpServerConfig(path, "literal", { exposure: "direct" });
			expect(mode(path)).toBe(0o600);
		}
	});

	it("warns through load and CLI without resolving or disclosing literals and respects trust/override", async () => {
		const paths = setup();
		addMcpServerConfig(join(paths.agentDir, "mcp.json"), "shared", http);
		const project = join(paths.cwd, ".pi", "mcp.json");
		addMcpServerConfig(project, "shared", { ...http, oauth: { clientSecret: FAKE } });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const loaded = loadMcpConfig({ ...paths, projectTrusted: true });
		expect(loaded.errors).toEqual([]);
		expect(loaded.servers).toMatchObject([{ name: "shared", scope: "project", config: http }]);
		expect(warn).toHaveBeenCalledTimes(2);
		const warnings = warn.mock.calls.flat().join("\n");
		expect(warnings).toContain(project);
		expect(warnings).toContain('server "shared"');
		expect(warnings).toContain("headers.Authorization");
		expect(warnings).toContain("oauth.clientSecret");
		expect(warnings).not.toContain(FAKE);
		warn.mockClear();
		expect(loadMcpConfig({ ...paths, projectTrusted: false }).servers[0].scope).toBe("global");
		expect(warn).not.toHaveBeenCalled();
		new ProjectTrustStore(paths.agentDir).set(paths.cwd, true);
		const list = await run(["list", "--json"], paths);
		expect(list.code).toBe(0);
		expect(list.warnings).toHaveLength(2);
		expect(list.warnings.join("\n")).not.toContain(FAKE);
		expect(list.output).not.toContain(FAKE);
		const added = await run(
			["add", "-l", "literal", "--url", http.url, "--header", `X-API-Key=${FAKE}`, "--oauth-client-secret", FAKE],
			paths,
		);
		expect(added.code).toBe(0);
		expect(added.warnings).toHaveLength(2);
		expect(added.warnings.join("\n")).not.toContain(FAKE);
	});

	it("accepts supported references and ordinary headers, warning only for escaped/invalid literal references", async () => {
		const paths = setup();
		const project = join(paths.cwd, ".pi", "mcp.json");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config reference
		const env = "${FAKE_TOKEN}";
		for (const reference of [env, "$FAKE_TOKEN", `Bearer ${env}`, "!exit 2241"]) {
			addMcpServerConfig(project, "ref", {
				...http,
				headers: {
					Authorization: reference,
					"X-Team": "$TEAM",
					"Content-Type": "application/json",
					Accept: "application/json",
					"X-Token-Count": "$TOKEN_COUNT",
					"X-Credential-Format": "$CREDENTIAL_FORMAT",
				},
				// #2241: the Authorization scheme is not part of a client-secret reference.
				oauth: { clientSecret: reference.startsWith("Bearer ") ? env : reference },
			});
			const warnings: string[] = [];
			loadMcpConfig({ ...paths, projectTrusted: true, onWarning: (warning) => warnings.push(warning) });
			expect(warnings).toEqual([]);
		}
		// biome-ignore lint/suspicious/noTemplateCurlyInString: escaped and invalid references must stay literal
		for (const literal of ["$${FAKE_TOKEN}", "${not valid}", "$!exit 2241"]) {
			addMcpServerConfig(project, "ref", { ...http, headers: { Authorization: literal } });
			const warnings: string[] = [];
			loadMcpConfig({ ...paths, projectTrusted: true, onWarning: (warning) => warnings.push(warning) });
			expect(warnings).toHaveLength(1);
			expect(warnings.join()).not.toContain(literal);
		}
		const added = await run(
			[
				"add",
				"-l",
				"ref",
				"--url",
				http.url,
				"--bearer-token-env-var",
				"FAKE_TOKEN",
				"--header",
				"X-Team=$TEAM",
				"--oauth-client-secret",
				"!exit 2241",
			],
			paths,
		);
		expect(added.code).toBe(0);
		expect(added.warnings).toEqual([]);
	});

	it("does not clobber a raced new file, including the CLI error path", async () => {
		const paths = setup();
		const path = join(paths.agentDir, "mcp.json");
		const mkdir = fs.mkdirSync;
		vi.spyOn(fs, "mkdirSync").mockImplementation((...args: Parameters<typeof fs.mkdirSync>) => {
			const result = mkdir(...args);
			if (args[0] === paths.agentDir) fs.writeFileSync(path, "raced-owner-content", { mode: 0o640 });
			return result;
		});
		const added = await run(["add", "new", "--url", http.url], paths);
		expect(added.code).toBe(1);
		expect(added.warnings.join()).toContain("EEXIST");
		expect(fs.readFileSync(path, "utf8")).toBe("raced-owner-content");
		expect(mode(path)).toBe(0o640);
	});

	it("preserves malformed inputs and reports filesystem errors without creating missing update/remove files", async () => {
		const paths = setup();
		const path = join(paths.agentDir, "mcp.json");
		expect(() => updateMcpServerConfig(path, "missing", { enabled: false })).toThrow("does not define");
		expect(removeMcpServerConfig(path, "missing")).toBe(false);
		expect(fs.existsSync(paths.agentDir)).toBe(false);
		fs.mkdirSync(paths.agentDir, { recursive: true });
		for (const text of ["{malformed", '{"mcpServers": []}']) {
			fs.writeFileSync(path, text);
			expect(() => addMcpServerConfig(path, "new", http)).toThrow();
			expect(fs.readFileSync(path, "utf8")).toBe(text);
			expect(loadMcpConfig({ ...paths, projectTrusted: false }).errors).toHaveLength(1);
		}
		fs.rmSync(path);
		fs.mkdirSync(path);
		expect((await run(["add", "new", "--url", http.url], paths)).code).toBe(1);
	});
});
