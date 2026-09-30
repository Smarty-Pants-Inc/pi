import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import type { McpHttpServerConfig } from "../src/core/mcp-servers.ts";
import { getConfigValueEnvVarName, getConfigValueEnvVarNames } from "../src/core/resolve-config-value.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import { addMcpServerConfig, loadMcpConfig, updateMcpServerConfig } from "../src/extensions/mcp/config.ts";
import { McpOAuthCredentialStore } from "../src/extensions/mcp/runtime.ts";

const FAKE = "FAKE-LITERAL-SECRET";
const ENV = "$" + "{TOKEN}";
const COOKIE = `session=${FAKE}; theme=\${UI_THEME}`;
const SECRET = "FAKE-LITERAL$" + "{SUFFIX}";
const URL = "https://unused.invalid/mcp";
const FIELDS = [
	"Cookie",
	"oauth.clientSecret",
	"Authorization",
	"Proxy-Authorization",
	"X-Api-Key",
	"X-Token",
	"X-Secret",
	"X-Credential",
] as const;
type Field = (typeof FIELDS)[number];
const REPORTED = [
	{ field: "Cookie" as const, value: COOKIE, name: "cookie" },
	{ field: "oauth.clientSecret" as const, value: SECRET, name: "secret" },
];
const mode = (path: string) => statSync(path).mode & 0o777;

function configFor(field: Field, value: string): McpHttpServerConfig {
	return {
		url: URL,
		enabled: false,
		...(field === "oauth.clientSecret" ? { oauth: { clientSecret: value } } : { headers: { [field]: value } }),
	};
}

function addArgs(field: Field, value: string, local: boolean): string[] {
	return [
		"add",
		...(local ? ["--local"] : []),
		"mixed",
		"--url",
		URL,
		...(field === "oauth.clientSecret" ? ["--oauth-client-secret", value] : ["--header", `${field}=${value}`]),
	];
}

// #2241 / F17: exercise the actual CLI writer/list receiver and trusted loader, not a warning helper.
// Every listed server is disabled: no transport, command resolution, model, or provider request is needed.
describe("mixed MCP credential persistence and warnings", () => {
	const roots: string[] = [];
	const initialUmask = process.umask();
	afterEach(() => {
		vi.restoreAllMocks();
		process.umask(initialUmask);
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function setup(local = false, permissions = 0o644) {
		process.umask(0o022);
		const root = mkdtempSync(join(tmpdir(), "pi-2241-mixed-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { mode: 0o755 });
		mkdirSync(agentDir, { mode: 0o750 });
		const path = join(local ? join(cwd, ".pi") : agentDir, "mcp.json");
		mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
		chmodSync(dirname(path), 0o750);
		writeFileSync(path, '{\n\t"keep": "managed",\n\t"mcpServers": {}\n}\n', { mode: permissions });
		chmodSync(path, permissions);
		return { root, cwd, agentDir, path };
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

	it.each(REPORTED.flatMap((credential) => [false, true].map((local) => ({ ...credential, local }))))(
		"refuses the reported $name CLI add before rewriting 0644 (local=$local)",
		async ({ field, value, local }) => {
			// The plural parser finds a reference in both reported inputs, but the whole-reference parser does not.
			expect(getConfigValueEnvVarNames(value)).toHaveLength(1);
			expect(getConfigValueEnvVarName(value)).toBeUndefined();
			const paths = setup(local);
			const before = readFileSync(paths.path, "utf8");
			const result = await run(addArgs(field, value, local), paths);
			const persisted = readFileSync(paths.path, "utf8");
			// Include the effect in one assertion so the pre-fix receipt proves persistence, not just an exit-code gap.
			expect({
				code: result.code,
				changed: persisted !== before,
				literalPersisted: persisted.includes("FAKE-LITERAL"),
				mode: mode(paths.path),
			}).toEqual({ code: 1, changed: false, literalPersisted: false, mode: 0o644 });
			expect(result.warnings.join("\n")).toContain("refusing to persist literal credentials");
			expect(result.warnings.join("\n")).toContain(field);
			expect(result.warnings.join("\n")).toContain("0600");
			expect(result.warnings.join("\n")).not.toContain("FAKE-LITERAL");
			expect(result.output).not.toContain("FAKE-LITERAL");
			expect(mode(dirname(paths.path))).toBe(0o750);
		},
	);

	it.each(REPORTED)(
		"warns redacted through project CLI add, trusted load and list for $name",
		async ({ field, value }) => {
			const paths = setup(true, 0o600);
			const added = await run(addArgs(field, value, true), paths);
			expect(added.code).toBe(0);
			expect(readFileSync(paths.path, "utf8")).toContain(value);
			expect(mode(paths.path)).toBe(0o600);
			updateMcpServerConfig(paths.path, "mixed", { enabled: false });
			// Global literals do not produce project warnings; the project entry still overrides this one.
			addMcpServerConfig(join(paths.agentDir, "mcp.json"), "mixed", configFor(field, value));
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			const trusted = loadMcpConfig({ ...paths, projectTrusted: true });
			expect(trusted.errors).toEqual([]);
			expect(trusted.servers).toMatchObject([{ name: "mixed", scope: "project", config: configFor(field, value) }]);
			const loadWarnings = warning.mock.calls.flat();
			warning.mockClear();
			const untrusted = loadMcpConfig({ ...paths, projectTrusted: false });
			expect(untrusted.servers[0].scope).toBe("global");
			expect(warning).not.toHaveBeenCalled();
			const ignored = await run(["list", "--json"], paths);
			expect(ignored.code).toBe(0);
			expect(ignored.warnings).toEqual([]);
			expect(ignored.output).toContain("not trusted");
			new ProjectTrustStore(paths.agentDir).set(paths.cwd, true);
			const lists = [];
			for (const args of [["list"], ["list", "--json"]]) lists.push(await run(args, paths));
			// Reach all public warning receivers before asserting, including in the pre-fix reproduction.
			expect({
				add: added.warnings.length,
				load: loadWarnings.length,
				lists: lists.map((listed) => listed.warnings.length),
			}).toEqual({ add: 1, load: 1, lists: [1, 1] });
			expect(added.warnings[0]).toContain(paths.path);
			expect(added.warnings[0]).toContain('server "mixed"');
			expect(added.warnings[0]).toContain(field);
			expect(added.warnings[0]).not.toContain("FAKE-LITERAL");
			expect(loadWarnings).toEqual(added.warnings);
			for (const listed of lists) {
				expect(listed.code).toBe(0);
				expect(listed.warnings).toEqual(added.warnings);
				expect(listed.output).not.toContain("FAKE-LITERAL");
			}
		},
	);

	it.each(REPORTED)(
		"scans retained $name even when editing/removing a different server, and allows remediation",
		async ({ field, value }) => {
			for (const local of [false, true]) {
				const paths = setup(local, 0o640);
				writeFileSync(
					paths.path,
					JSON.stringify({
						keep: "managed",
						mcpServers: { retained: configFor(field, value), ordinary: { command: "unused", enabled: false } },
					}),
				);
				const before = readFileSync(paths.path, "utf8");
				expect(() => updateMcpServerConfig(paths.path, "ordinary", { exposure: "direct" })).toThrow("refusing");
				for (const args of [
					["add", ...(local ? ["-l"] : []), "ordinary", "--url", URL, "--header", "Accept=application/json"],
					["remove", ...(local ? ["-l"] : []), "ordinary"],
				]) {
					const result = await run(args, paths);
					expect(result.code).toBe(1);
					expect(result.warnings.join("\n")).toContain(field);
					expect(result.warnings.join("\n")).not.toContain("FAKE-LITERAL");
					expect(readFileSync(paths.path, "utf8")).toBe(before);
				}
				const removed = await run(["remove", ...(local ? ["-l"] : []), "retained"], paths);
				expect(removed.code).toBe(0);
				expect(readFileSync(paths.path, "utf8")).not.toContain("FAKE-LITERAL");
				expect(mode(paths.path)).toBe(0o640);
			}
		},
	);

	it("keeps scanning after safe retained entries and permits replacement that removes the unsafe value", async () => {
		const paths = setup(false);
		writeFileSync(
			paths.path,
			JSON.stringify({
				mcpServers: { safe: configFor("Cookie", ENV), mixed: configFor("oauth.clientSecret", SECRET) },
			}),
		);
		const before = readFileSync(paths.path, "utf8");
		expect(() => updateMcpServerConfig(paths.path, "safe", { enabled: true })).toThrow("oauth.clientSecret");
		expect(readFileSync(paths.path, "utf8")).toBe(before);
		expect((await run(addArgs("oauth.clientSecret", ENV, false), paths)).code).toBe(0);
		expect(readFileSync(paths.path, "utf8")).not.toContain("FAKE-LITERAL");
		expect(mode(paths.path)).toBe(0o644);
	});

	it.each(FIELDS)(
		"allows only whole references/commands for %s, with scheme-plus-reference restricted to authorization",
		async (field) => {
			const paths = setup(true, 0o640);
			const marker = join(paths.root, "must-not-execute");
			const command = `!printf executed > '${marker}'`;
			const authorization = field.toLowerCase().endsWith("authorization");
			const allowed = [
				ENV,
				"$TOKEN",
				command,
				...(authorization ? [`Bearer ${ENV}`, "Basic $TOKEN", `bEaReR\t${ENV}`] : []),
			];
			for (const value of allowed) {
				const result = await run(addArgs(field, value, true), paths);
				expect(result.code, value).toBe(0);
				expect(result.warnings, value).toEqual([]);
				expect(mode(paths.path)).toBe(0o640);
				updateMcpServerConfig(paths.path, "mixed", { enabled: false });
				const warnings: string[] = [];
				loadMcpConfig({ ...paths, projectTrusted: true, onWarning: (warning) => warnings.push(warning) });
				expect(warnings, value).toEqual([]);
			}
			const rejected = [
				`${FAKE}${ENV}`,
				`${ENV}-suffix`,
				`$$TOKEN${ENV}`,
				"$" + "{INVALID-NAME}",
				`$$` + "{TOKEN}",
				`$!command${ENV}`,
				`${ENV}$OTHER`,
				...(!authorization
					? [`Bearer ${ENV}`]
					: [
							`Bearer ${ENV}${FAKE}`,
							`Bearer $$` + "{TOKEN}",
							`Bearer ${ENV}\n`,
							`Bearer ${ENV}\r\n`,
							`(invalid) ${ENV}`,
							` Bearer ${ENV}`,
						]),
			];
			for (const value of rejected) {
				const before = readFileSync(paths.path, "utf8");
				const result = await run(addArgs(field, value, true), paths);
				expect(result.code, value).toBe(1);
				expect(result.warnings.join("\n"), value).toContain(field);
				expect(result.warnings.join("\n"), value).not.toContain(value);
				expect(readFileSync(paths.path, "utf8"), value).toBe(before);
				// Private literal persistence remains supported, but the actual project loader must warn.
				chmodSync(paths.path, 0o600);
				addMcpServerConfig(paths.path, "mixed", configFor(field, value));
				const warnings: string[] = [];
				loadMcpConfig({ ...paths, projectTrusted: true, onWarning: (warning) => warnings.push(warning) });
				expect(warnings, value).toHaveLength(1);
				expect(warnings[0], value).not.toContain(value);
				addMcpServerConfig(paths.path, "mixed", configFor(field, ENV));
				chmodSync(paths.path, 0o640);
			}
			expect(existsSync(marker)).toBe(false);
			expect(mode(dirname(paths.path))).toBe(0o750);
		},
	);

	it("conservatively treats every mixed Cookie as literal and leaves ordinary/global header warnings alone", async () => {
		const paths = setup(true, 0o644);
		for (const value of [COOKIE, `session=${ENV}`, `session=${ENV}; theme=$UI_THEME`, `${ENV}; theme=dark`]) {
			const result = await run(addArgs("Cookie", value, true), paths);
			expect(result.code, value).toBe(1);
			expect(result.warnings.join("\n")).toContain("headers.Cookie");
		}
		const result = await run(
			[
				"add",
				"-l",
				"ordinary",
				"--url",
				URL,
				"--header",
				"Accept=application/json",
				"--header",
				"X-Token-Count=$TOKEN_COUNT",
				"--header",
				"X-Team=$TEAM",
			],
			paths,
		);
		expect(result.code).toBe(0);
		expect(result.warnings).toEqual([]);
		updateMcpServerConfig(paths.path, "ordinary", { enabled: false });
		new ProjectTrustStore(paths.agentDir).set(paths.cwd, true);
		expect((await run(["list", "--json"], paths)).warnings).toEqual([]);
		expect(mode(paths.path)).toBe(0o644);
	});
});
