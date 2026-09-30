import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import type { McpServerConfig } from "../src/core/mcp-servers.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import {
	addMcpServerConfig,
	loadMcpConfig,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "../src/extensions/mcp/config.ts";
import { McpOAuthCredentialStore } from "../src/extensions/mcp/runtime.ts";

const FAKE = "FAKE-ROUND5-2241-NOT-A-CREDENTIAL";
const URL = "https://unused.invalid/mcp";
const REF = "$" + "{ROUND5_UNSET_TOKEN}";
const CHANNELS = [
	{ kind: "env", key: "API_TOKEN", field: "env.API_TOKEN" },
	{ kind: "env", key: "CUSTOM_SETTING", field: "env.CUSTOM_SETTING" },
	{ kind: "header", key: "X-Auth", field: "headers.X-Auth" },
	{ kind: "header", key: "X-Custom-Setting", field: "headers.X-Custom-Setting" },
] as const;
type Channel = (typeof CHANNELS)[number];
const LOCATIONS = [false, true].flatMap((local) => [0o644, 0o640].map((permissions) => ({ local, permissions })));
const CASES = CHANNELS.flatMap((channel) => LOCATIONS.map((location) => ({ ...channel, ...location })));
const mode = (path: string) => statSync(path).mode & 0o777;
const URL_CREDENTIALS = [
	{ field: "url.username", url: `https://${FAKE}@unused.invalid/mcp`, marker: FAKE },
	{ field: "url.password", url: `https://:${FAKE}@unused.invalid/mcp`, marker: FAKE },
	// URL userinfo is passed through, not resolved as a config-value reference.
	{ field: "url.username", url: `https://${REF}@unused.invalid/mcp`, marker: "ROUND5_UNSET_TOKEN" },
	{ field: "url.password", url: `https://:${REF}@unused.invalid/mcp`, marker: "ROUND5_UNSET_TOKEN" },
];

function server(channel: Channel, value: string): McpServerConfig {
	return channel.kind === "env"
		? { command: "round5-must-not-spawn", env: { [channel.key]: value }, enabled: false }
		: { url: URL, headers: { [channel.key]: value }, enabled: false };
}

function addArgs(channel: Channel, value: string, local: boolean, name = "credential"): string[] {
	return [
		"add",
		...(local ? ["--local"] : []),
		name,
		...(channel.kind === "env"
			? ["--env", `${channel.key}=${value}`, "--", "round5-must-not-spawn"]
			: ["--url", URL, "--header", `${channel.key}=${value}`]),
	];
}

// #2241 / F17: actual exported CLI parser -> public writer -> persistence, with no transport/provider calls.
// Unknown env/header names are not evidence that literal values are harmless.
describe("round5 MCP credential channels", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function setup(local: boolean, permissions?: number) {
		const root = mkdtempSync(join(tmpdir(), "pi-round5-credential-"));
		roots.push(root);
		// Traversable fixture parents make the existing file's access bits the confidentiality boundary.
		chmodSync(root, 0o755);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { mode: 0o755 });
		mkdirSync(agentDir, { mode: 0o755 });
		chmodSync(cwd, 0o755);
		chmodSync(agentDir, 0o755);
		const path = join(local ? join(cwd, ".pi") : join(agentDir, "nested", "private"), "mcp.json");
		const paths = { root, cwd, agentDir: local ? agentDir : dirname(path), path };
		if (permissions !== undefined) {
			mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
			for (const parent of local ? [dirname(path)] : [join(agentDir, "nested"), dirname(path)])
				chmodSync(parent, 0o755);
			writeFileSync(path, '{\n\t"keep": "managed",\n\t"mcpServers": {}\n}\n');
			chmodSync(path, permissions);
		}
		return paths;
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

	// #2241: capture the actual byte disclosure in the baseline assertion, not just a wrong exit code.
	it.each(CASES)("CLI refuses $field (local=$local, mode=$permissions) before write", async (channel) => {
		const paths = setup(channel.local, channel.permissions);
		const before = readFileSync(paths.path, "utf8");
		const result = await run(addArgs(channel, FAKE, channel.local), paths);
		const persisted = readFileSync(paths.path, "utf8");
		const effect = {
			code: result.code,
			changed: persisted !== before,
			literalPersisted: persisted.includes(FAKE),
			mode: mode(paths.path),
		};
		expect(effect, JSON.stringify(effect)).toEqual({
			code: 1,
			changed: false,
			literalPersisted: false,
			mode: channel.permissions,
		});
		expect(result.warnings.join("\n")).toContain("refusing to persist literal credentials");
		expect(result.warnings.join("\n")).toContain(channel.field);
		expect(result.warnings.join("\n")).toContain("0600");
		expect(result.warnings.join("\n") + result.output).not.toContain(FAKE);
		expect(mode(dirname(paths.path))).toBe(0o755);
	});

	// #2241: SDK callers have the same storage boundary as CLI users, with no helper-only substitute.
	it.each(CASES)("public writer refuses $field (local=$local, mode=$permissions)", (channel) => {
		const paths = setup(channel.local, channel.permissions);
		const before = readFileSync(paths.path, "utf8");
		let refusal: unknown;
		try {
			addMcpServerConfig(paths.path, "credential", server(channel, FAKE));
		} catch (error) {
			refusal = error;
		}
		const persisted = readFileSync(paths.path, "utf8");
		const effect = {
			refused: refusal instanceof Error,
			changed: persisted !== before,
			literalPersisted: persisted.includes(FAKE),
		};
		expect(effect, JSON.stringify(effect)).toEqual({ refused: true, changed: false, literalPersisted: false });
		expect(String(refusal)).toContain(channel.field);
		expect(String(refusal)).not.toContain(FAKE);
		expect(mode(paths.path)).toBe(channel.permissions);
		expect(mode(dirname(paths.path))).toBe(0o755);
	});

	// #2241: private existing literals and exclusive fresh-file creation remain supported in both scopes.
	it.each(CHANNELS.flatMap((channel) => [false, true].map((local) => ({ ...channel, local }))))(
		"allows private/fresh $field (local=$local) without claiming a connection",
		async (channel) => {
			for (const permissions of [undefined, 0o600]) {
				const paths = setup(channel.local, permissions);
				const added = await run(addArgs(channel, FAKE, channel.local), paths);
				expect(added.code).toBe(0);
				expect(added.output).toContain("Added");
				expect(added.output).not.toMatch(/connected|Already signed in/);
				expect(added.output + added.warnings.join("\n")).not.toContain(FAKE);
				expect(readFileSync(paths.path, "utf8")).toContain(FAKE);
				expect(mode(paths.path)).toBe(0o600);
				expect(mode(dirname(paths.path))).toBe(permissions === undefined ? 0o700 : 0o755);
				if (!channel.local && permissions === undefined) expect(mode(dirname(dirname(paths.path)))).toBe(0o700);
				expect(addMcpServerConfig(paths.path, "credential", server(channel, FAKE))).toBe(true);
				expect(mode(paths.path)).toBe(0o600);
			}
		},
	);

	// #2241: stdio/custom-header advice reaches add, trusted startup, and both actual list receivers.
	it.each(CHANNELS)("warns redacted through project add/load/plain+JSON list for $field", async (channel) => {
		const paths = setup(true, 0o600);
		const added = await run(addArgs(channel, FAKE, true), paths);
		updateMcpServerConfig(paths.path, "credential", { enabled: false });
		addMcpServerConfig(join(paths.agentDir, "mcp.json"), "credential", server(channel, FAKE));
		const warnings: string[] = [];
		const loaded = loadMcpConfig({ ...paths, projectTrusted: true, onWarning: (line) => warnings.push(line) });
		const untrustedWarnings: string[] = [];
		const untrusted = loadMcpConfig({
			...paths,
			projectTrusted: false,
			onWarning: (line) => untrustedWarnings.push(line),
		});
		new ProjectTrustStore(paths.agentDir).set(paths.cwd, true);
		const plain = await run(["list"], paths);
		const json = await run(["list", "--json"], paths);
		expect({
			add: added.warnings.length,
			load: warnings.length,
			plain: plain.warnings.length,
			json: json.warnings.length,
		}).toEqual({ add: 1, load: 1, plain: 1, json: 1 });
		expect(added.code).toBe(0);
		expect(loaded.errors).toEqual([]);
		expect(loaded.servers).toMatchObject([{ name: "credential", scope: "project", config: server(channel, FAKE) }]);
		expect(untrusted.servers[0].scope).toBe("global");
		expect(untrustedWarnings).toEqual([]);
		for (const receiver of [added.warnings, warnings, plain.warnings, json.warnings]) {
			expect(receiver).toEqual(added.warnings);
			expect(receiver[0]).toContain(paths.path);
			expect(receiver[0]).toContain(channel.field);
			expect(receiver[0]).not.toContain(FAKE);
		}
		for (const listed of [plain, json]) {
			expect(listed.code).toBe(0);
			expect(listed.output).not.toContain(FAKE);
			expect(listed.output).not.toContain("connected");
		}
		expect(JSON.parse(json.output).servers).toMatchObject([{ name: "credential", state: "disabled", tools: [] }]);
	});

	// #2241: retained unsafe credentials block unrelated mutations; eliminating the literal is remediation.
	it.each(CASES)(
		"scans retained $field (local=$local, mode=$permissions), allows removal/replacement",
		async (channel) => {
			const paths = setup(channel.local, channel.permissions);
			const original = JSON.stringify({
				keep: "managed",
				mcpServers: {
					ordinary: { command: "round5-must-not-spawn", enabled: false },
					retained: server(channel, FAKE),
				},
			});
			writeFileSync(paths.path, original);
			const attempts: (() => unknown | Promise<unknown>)[] = [
				() => updateMcpServerConfig(paths.path, "ordinary", { exposure: "direct" }),
				() => addMcpServerConfig(paths.path, "ordinary", { command: "replacement", enabled: false }),
				() => removeMcpServerConfig(paths.path, "ordinary"),
				async () => {
					const result = await run(
						["add", ...(channel.local ? ["-l"] : []), "ordinary", "--", "replacement"],
						paths,
					);
					if (result.code !== 1) throw new Error("unrelated CLI add unexpectedly succeeded");
					return result.warnings.join("\n");
				},
				async () => {
					const result = await run(["remove", ...(channel.local ? ["-l"] : []), "ordinary"], paths);
					if (result.code !== 1) throw new Error("unrelated CLI remove unexpectedly succeeded");
					return result.warnings.join("\n");
				},
			];
			for (const attempt of attempts) {
				let message = "";
				try {
					const result = await attempt();
					if (typeof result === "string") message = result;
				} catch (error) {
					message = String(error);
				}
				expect({
					changed: readFileSync(paths.path, "utf8") !== original,
					refusal: message.includes("refusing"),
				}).toEqual({ changed: false, refusal: true });
				expect(message).toContain(channel.field);
				expect(message).not.toContain(FAKE);
				expect(mode(paths.path)).toBe(channel.permissions);
			}
			expect((await run(["remove", ...(channel.local ? ["-l"] : []), "retained"], paths)).code).toBe(0);
			expect(readFileSync(paths.path, "utf8")).not.toContain(FAKE);
			writeFileSync(paths.path, original);
			expect(addMcpServerConfig(paths.path, "retained", server(channel, REF))).toBe(true);
			expect(readFileSync(paths.path, "utf8")).not.toContain(FAKE);
			writeFileSync(paths.path, original);
			expect((await run(addArgs(channel, REF, channel.local, "retained"), paths)).code).toBe(0);
			expect(readFileSync(paths.path, "utf8")).not.toContain(FAKE);
			expect(mode(paths.path)).toBe(channel.permissions);
			expect(mode(dirname(paths.path))).toBe(0o755);
		},
	);

	// #2241: whole references must never resolve at persistence/load/list time; partial references remain literal.
	it.each(CASES)("permits complete references only for $field (local=$local, mode=$permissions)", async (channel) => {
		const paths = setup(channel.local, channel.permissions);
		const marker = join(paths.root, "must-not-execute");
		const command = `!printf executed > '${marker}'`;
		for (const value of [REF, "$ROUND5_UNSET_TOKEN", command]) {
			const added = await run(addArgs(channel, value, channel.local), paths);
			expect(added.code).toBe(0);
			expect(added.warnings).toEqual([]);
			expect(addMcpServerConfig(paths.path, "credential", server(channel, value))).toBe(true);
			const warnings: string[] = [];
			loadMcpConfig({ ...paths, projectTrusted: true, onWarning: (line) => warnings.push(line) });
			expect(warnings).toEqual([]);
			if (channel.local) new ProjectTrustStore(paths.agentDir).set(paths.cwd, true);
			const listed = await run(["list", "--json"], paths);
			expect(listed.code).toBe(0);
			expect(listed.warnings).toEqual([]);
		}
		for (const value of [`${FAKE}${REF}`, `${REF}-literal`, `$${REF}`, `Bearer ${REF}`]) {
			const before = readFileSync(paths.path, "utf8");
			const added = await run(addArgs(channel, value, channel.local), paths);
			expect(added.code).toBe(1);
			expect(added.warnings.join("\n")).toContain(channel.field);
			expect(added.warnings.join("\n")).not.toContain(value);
			expect(readFileSync(paths.path, "utf8")).toBe(before);
		}
		expect(existsSync(marker)).toBe(false);
		expect(mode(paths.path)).toBe(channel.permissions);
	});

	// #2241: --url admits literal userinfo; reference-looking userinfo is not a runtime reference.
	it.each(URL_CREDENTIALS.flatMap((credential) => LOCATIONS.map((location) => ({ ...credential, ...location }))))(
		"refuses admitted $field URL userinfo (local=$local, mode=$permissions) through CLI and writer",
		async ({ field, url, marker, local, permissions }) => {
			const paths = setup(local, permissions);
			const before = readFileSync(paths.path, "utf8");
			const cli = await run(["add", ...(local ? ["-l"] : []), "userinfo", "--url", url], paths);
			const cliText = readFileSync(paths.path, "utf8");
			writeFileSync(paths.path, before);
			let refusal: unknown;
			try {
				addMcpServerConfig(paths.path, "userinfo", { url, enabled: false });
			} catch (error) {
				refusal = error;
			}
			const writerText = readFileSync(paths.path, "utf8");
			const effect = {
				cliCode: cli.code,
				cliChanged: cliText !== before,
				cliLiteralPersisted: cliText.includes(marker),
				writerRefused: refusal instanceof Error,
				writerChanged: writerText !== before,
				writerLiteralPersisted: writerText.includes(marker),
				mode: mode(paths.path),
			};
			expect(effect, JSON.stringify(effect)).toEqual({
				cliCode: 1,
				cliChanged: false,
				cliLiteralPersisted: false,
				writerRefused: true,
				writerChanged: false,
				writerLiteralPersisted: false,
				mode: permissions,
			});
			for (const message of [cli.warnings.join("\n"), String(refusal)]) {
				expect(message).toContain("refusing to persist literal credentials");
				expect(message).toContain(field);
				expect(message).not.toContain(marker);
				expect(message).not.toContain(url);
			}
			expect(cli.output).not.toContain(marker);
			expect(mode(dirname(paths.path))).toBe(0o755);
		},
	);

	// #2241: private/fresh userinfo is supported but advice and actual disabled CLI reports redact it.
	it.each(URL_CREDENTIALS.flatMap((credential) => [false, true].map((local) => ({ ...credential, local }))))(
		"allows private/fresh $field URL userinfo, redacts plain+JSON list (local=$local)",
		async ({ field, url, marker, local }) => {
			for (const permissions of [undefined, 0o600]) {
				const paths = setup(local, permissions);
				const added = await run(["add", ...(local ? ["-l"] : []), "userinfo", "--url", url], paths);
				expect(added.code).toBe(0);
				expect(readFileSync(paths.path, "utf8")).toContain(url);
				expect(mode(paths.path)).toBe(0o600);
				expect(mode(dirname(paths.path))).toBe(permissions === undefined ? 0o700 : 0o755);
				updateMcpServerConfig(paths.path, "userinfo", { enabled: false });
				const warnings: string[] = [];
				const loaded = loadMcpConfig({ ...paths, projectTrusted: true, onWarning: (line) => warnings.push(line) });
				expect(loaded.errors).toEqual([]);
				if (local) new ProjectTrustStore(paths.agentDir).set(paths.cwd, true);
				const plain = await run(["list"], paths);
				const json = await run(["list", "--json"], paths);
				for (const receiver of [added.warnings, warnings, plain.warnings, json.warnings]) {
					expect(receiver).toHaveLength(local ? 1 : 0);
					if (local) expect(receiver[0]).toContain(field);
					expect(receiver.join("\n")).not.toContain(marker);
				}
				for (const listed of [plain, json]) {
					expect(listed.code).toBe(0);
					expect(listed.output).toContain("REDACTED");
					expect(listed.output).not.toContain(marker);
					expect(listed.output).not.toContain("connected");
				}
				expect(JSON.parse(json.output).servers).toMatchObject([{ name: "userinfo", state: "disabled" }]);
				expect(added.output).not.toContain(marker);
			}
		},
	);

	// #2241: URL/query/fragment syntax and ordinary command arguments are not speculative credential channels.
	it.each(LOCATIONS)(
		"preserves harmless URLs and structural settings (local=$local, mode=$permissions)",
		async ({ local, permissions }) => {
			const paths = setup(local, permissions);
			for (const url of [
				URL,
				`${URL}?filter=public&sort=asc`,
				"https://unused.invalid:8443/path?q=words#fragment",
				"https://@unused.invalid/mcp",
			]) {
				const added = await run(["add", ...(local ? ["-l"] : []), "ordinary-url", "--url", url], paths);
				expect(added.code).toBe(0);
				expect(added.warnings).toEqual([]);
				updateMcpServerConfig(paths.path, "ordinary-url", { enabled: false });
				if (local) new ProjectTrustStore(paths.agentDir).set(paths.cwd, true);
				const listed = await run(["list", "--json"], paths);
				expect(listed.code).toBe(0);
				expect(listed.warnings).toEqual([]);
				expect(JSON.parse(listed.output).servers[0].transport).toBe(url);
			}
			expect(
				addMcpServerConfig(paths.path, "structural", {
					command: "round5-must-not-spawn",
					args: ["--label", "public"],
					cwd: ".",
					exposure: "hidden",
					timeout: 2,
					enabled: false,
				}),
			).toBe(false);
			expect(mode(paths.path)).toBe(permissions);
			expect(mode(dirname(paths.path))).toBe(0o755);
		},
	);

	// #2241: ordinary protocol headers and bounded known harmless settings are not credential channels.
	it.each(LOCATIONS)(
		"preserves ordinary managed configuration (local=$local, mode=$permissions)",
		async ({ local, permissions }) => {
			const paths = setup(local, permissions);
			const http = {
				url: URL,
				headers: { Accept: "application/json", "Content-Type": "application/json" },
				oauth: { clientId: "public-client", callbackPort: 2241, scope: "read" },
				enabled: false,
				exposure: "hidden",
				timeout: 2,
			} as const;
			expect(addMcpServerConfig(paths.path, "ordinary", http)).toBe(false);
			expect(
				(
					await run(
						[
							"add",
							...(local ? ["-l"] : []),
							"ordinary",
							"--url",
							URL,
							"--header",
							"Accept=application/json",
							"--header",
							"Content-Type=application/json",
						],
						paths,
					)
				).code,
			).toBe(0);
			updateMcpServerConfig(paths.path, "ordinary", { enabled: false, exposure: "direct" });
			expect(
				addMcpServerConfig(paths.path, "stdio", {
					command: "round5-must-not-spawn",
					args: ["--safe"],
					cwd: ".",
					env: { NODE_ENV: "production" },
					enabled: false,
				}),
			).toBe(false);
			const warnings: string[] = [];
			const loaded = loadMcpConfig({ ...paths, projectTrusted: true, onWarning: (line) => warnings.push(line) });
			expect(loaded.errors).toEqual([]);
			expect(warnings).toEqual([]);
			expect(readFileSync(paths.path, "utf8")).toContain('"keep": "managed"');
			expect(readFileSync(paths.path, "utf8")).toContain('\n\t"mcpServers"');
			expect(removeMcpServerConfig(paths.path, "ordinary")).toBe(true);
			expect(removeMcpServerConfig(paths.path, "stdio")).toBe(true);
			expect(mode(paths.path)).toBe(permissions);
			expect(mode(dirname(paths.path))).toBe(0o755);
		},
	);
});
