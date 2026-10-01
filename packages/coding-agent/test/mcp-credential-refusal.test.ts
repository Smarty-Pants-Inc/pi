/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: tests exercise literal config-value references */
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../src/core/mcp-servers.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../src/core/resolve-config-value.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import {
	addMcpServerConfig,
	loadMcpConfig,
	McpCredentialPersistenceError,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "../src/extensions/mcp/config.ts";

const FAKE_SECRET = "FAKE_MCP_REFUSAL_SECRET";
const URL_BASE = "https://example.invalid/mcp";
const HTTP = { url: URL_BASE };
const POSIX = process.platform !== "win32";
const TOKEN_REF = "${MCP_REFUSAL_TOKEN}";
const literalCases: Array<{ label: string; config: McpServerConfig; args: string[] }> = [
	...["Authorization", "authorization", "X-Api-Key", "Token", "X-Custom-Auth", "X-Custom"].map((header) => ({
		label: `header ${header}`,
		config: {
			...HTTP,
			headers: { [header]: header.toLowerCase() === "authorization" ? `Bearer ${FAKE_SECRET}` : FAKE_SECRET },
		},
		args: [
			"--url",
			URL_BASE,
			"--header",
			`${header}=${header.toLowerCase() === "authorization" ? `Bearer ${FAKE_SECRET}` : FAKE_SECRET}`,
		],
	})),
	{
		label: "Basic auth",
		config: { ...HTTP, headers: { Authorization: `Basic ${FAKE_SECRET}` } },
		args: ["--url", URL_BASE, "--header", `Authorization=Basic ${FAKE_SECRET}`],
	},
	{
		label: "stdio env",
		config: { command: "unused", env: { CUSTOM: FAKE_SECRET } },
		args: ["--env", `CUSTOM=${FAKE_SECRET}`, "--", "unused"],
	},
	{
		label: "OAuth client secret",
		config: { ...HTTP, oauth: { clientSecret: FAKE_SECRET } },
		args: ["--url", URL_BASE, "--oauth-client-secret", FAKE_SECRET],
	},
	...[
		`https://${FAKE_SECRET}:password@example.invalid/mcp`,
		`https://user:${FAKE_SECRET}@example.invalid/mcp`,
		`https://${FAKE_SECRET}@example.invalid/mcp`,
	].map((url, index) => ({ label: `userinfo ${index}`, config: { url }, args: ["--url", url] })),
	...[
		"token",
		"key",
		"auth",
		"X-Auth",
		"X-Api-Key",
		"access_key",
		"access_token",
		"sig",
		"api-key",
		"API_KEY",
		"X-Amz-Signature",
		"client_secret",
		"password",
		"jwt",
		"session_id",
		"%61ccess_token",
	].map((query) => {
		const url = `${URL_BASE}?filter=public&${query}=${FAKE_SECRET}`;
		return { label: `query ${query}`, config: { url }, args: ["--url", url] };
	}),
	{
		label: "duplicate query",
		config: { url: `${URL_BASE}?access_token=&access_token=${FAKE_SECRET}` },
		args: ["--url", `${URL_BASE}?access_token=&access_token=${FAKE_SECRET}`],
	},
];

// pi#92 round 6 F17-Q: actual CLI and public writer must reject URL access_token on 0644/0640.
describe("MCP literal credential persistence refusal", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		while (dirs.length) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	function fixture(scope: "global" | "project", mode?: number, servers: Record<string, unknown> = {}) {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-refusal-"));
		dirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["+builtin:mcp"] }));
		const path = scope === "global" ? join(agentDir, "mcp.json") : join(cwd, ".pi", "mcp.json");
		if (mode !== undefined) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify({ keep: true, mcpServers: servers }, null, "\t")}\n`, { mode });
			chmodSync(path, mode);
		}
		return { cwd, agentDir, path };
	}

	function expectRefusal(write: () => unknown, path: string) {
		const before = existsSync(path) ? { text: readFileSync(path, "utf8"), mode: statSync(path).mode } : undefined;
		let caught: unknown;
		try {
			write();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(McpCredentialPersistenceError);
		expect(caught).toMatchObject({ name: "McpCredentialPersistenceError" });
		const message = (caught as Error).message;
		expect(message).toContain("MCP_LITERAL_CREDENTIAL_REFUSED");
		expect(message).toContain("env-var reference or the private credential store");
		expect(message).not.toContain(FAKE_SECRET);
		if (before) {
			expect(readFileSync(path, "utf8")).toBe(before.text);
			expect(statSync(path).mode).toBe(before.mode);
		} else expect(existsSync(path)).toBe(false);
	}

	for (const scope of ["global", "project"] as const) {
		for (const mode of [0o644, 0o640, undefined]) {
			it.each(literalCases)(
				`refuses public writer $label in ${scope} ${mode?.toString(8) ?? "missing"}`,
				({ config }) => {
					const { path } = fixture(scope, mode);
					expectRefusal(() => addMcpServerConfig(path, "secret", config), path);
				},
			);
			it.each(literalCases)(`refuses CLI $label in ${scope} ${mode?.toString(8) ?? "missing"}`, async ({ args }) => {
				const { path, cwd, agentDir } = fixture(scope, mode);
				const before = existsSync(path)
					? { text: readFileSync(path, "utf8"), mode: statSync(path).mode }
					: undefined;
				const output: string[] = [];
				const exit = await runMcpCommand(["add", "secret", ...(scope === "project" ? ["--local"] : []), ...args], {
					cwd,
					agentDir,
					log: (line) => output.push(line),
					error: (line) => output.push(line),
				});
				expect(exit).toBe(1);
				expect(output.join("\n")).toContain("MCP_LITERAL_CREDENTIAL_REFUSED");
				expect(output.join("\n")).not.toContain(FAKE_SECRET);
				if (before) {
					expect(readFileSync(path, "utf8")).toBe(before.text);
					expect(statSync(path).mode).toBe(before.mode);
				} else {
					expect(existsSync(path)).toBe(false);
					if (scope === "project") expect(existsSync(dirname(path))).toBe(false);
				}
			});
		}
	}

	it.each(literalCases)("guards retained $label for all config rewrite paths", ({ config }) => {
		for (const action of ["add", "update", "remove"] as const) {
			const { path } = fixture("global", 0o644, { retained: config, other: HTTP });
			expectRefusal(() => {
				if (action === "add") return addMcpServerConfig(path, "new", HTTP);
				if (action === "remove") return removeMcpServerConfig(path, "other");
				return updateMcpServerConfig(path, "retained", { enabled: false, exposure: "direct" });
			}, path);
		}
	});

	it("allows removal/replacement of the final literal rather than migrating it", () => {
		for (const action of ["remove", "replace"] as const) {
			const { path } = fixture("global", 0o644, { secret: literalCases[0].config });
			if (action === "remove") expect(removeMcpServerConfig(path, "secret")).toBe(true);
			else expect(addMcpServerConfig(path, "secret", HTTP)).toBe(true);
			expect(readFileSync(path, "utf8")).not.toContain(FAKE_SECRET);
			if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o644);
		}
	});

	it.each([TOKEN_REF, "$MCP_REFUSAL_TOKEN", `Bearer ${TOKEN_REF}`, "Basic $MCP_REFUSAL_TOKEN"])(
		"keeps supported header reference %s usable",
		async (reference) => {
			vi.stubEnv("MCP_REFUSAL_TOKEN", FAKE_SECRET);
			const { path, cwd, agentDir } = fixture("global", 0o644);
			expect(
				await runMcpCommand(["add", "refs", "--url", URL_BASE, "--header", `Authorization=${reference}`], {
					cwd,
					agentDir,
					log: () => {},
					error: () => {},
				}),
			).toBe(0);
			const config = loadMcpConfig({ cwd, agentDir, projectTrusted: true }).servers[0].config;
			if (!("url" in config)) throw new Error("Expected HTTP config");
			expect(config.headers).toEqual({ Authorization: reference });
			expect(resolveHeadersOrThrow(config.headers, "test")?.Authorization).toBe(
				reference.replace(/\$\{MCP_REFUSAL_TOKEN\}|\$MCP_REFUSAL_TOKEN/g, FAKE_SECRET),
			);
			expect(readFileSync(path, "utf8")).not.toContain(FAKE_SECRET);
		},
	);

	it("persists env/client-secret refs and harmless queries without resolving secrets", () => {
		vi.stubEnv("MCP_REFUSAL_TOKEN", FAKE_SECRET);
		const { path } = fixture("project", 0o640);
		addMcpServerConfig(path, "stdio", { command: "unused", env: { API_KEY: TOKEN_REF } });
		addMcpServerConfig(path, "http", {
			url: `${URL_BASE}?filter=public&limit=10&author=public`,
			headers: { "X-Custom": TOKEN_REF },
			oauth: { clientSecret: TOKEN_REF },
		});
		updateMcpServerConfig(path, "http", { enabled: false });
		expect(resolveConfigValueOrThrow(TOKEN_REF, "test")).toBe(FAKE_SECRET);
		expect(readFileSync(path, "utf8")).not.toContain(FAKE_SECRET);
		const fresh = fixture("project");
		addMcpServerConfig(fresh.path, "refs", { command: "unused", env: { API_KEY: TOKEN_REF } });
		expect(existsSync(fresh.path)).toBe(true);
	});

	it.each([
		`Bearer ${FAKE_SECRET}${TOKEN_REF}`,
		`${TOKEN_REF}${FAKE_SECRET}`,
		"$${MCP_REFUSAL_TOKEN}",
		"${BAD-NAME}",
		`!echo ${FAKE_SECRET}`,
		"Bearer ",
		"!read-private-store",
	])("does not mistake literal/partial/command header text for an env reference (%s)", (value) => {
		const { path } = fixture("global", 0o644);
		expectRefusal(() => addMcpServerConfig(path, "secret", { ...HTTP, headers: { Authorization: value } }), path);
	});

	it.each([`${URL_BASE}?access_token=${TOKEN_REF}`, `https://${TOKEN_REF}@example.invalid/mcp`])(
		"does not add URL reference resolution (%s)",
		(url) => {
			const { path } = fixture("global", 0o644);
			expectRefusal(() => addMcpServerConfig(path, "secret", { url }), path);
		},
	);

	it.each(literalCases)("allows $label only in an already-private owned regular file on POSIX", ({ config }) => {
		const { path } = fixture("global", 0o600);
		if (!POSIX) {
			expectRefusal(() => addMcpServerConfig(path, "secret", config), path);
			return;
		}
		expect(addMcpServerConfig(path, "secret", config)).toBe(false);
		expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.secret).toEqual(config);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it.skipIf(!POSIX)("refuses symlink and hardlink destinations before mutating their target", () => {
		for (const kind of ["symlink", "hardlink"] as const) {
			const { path } = fixture("global", 0o600);
			const alias = join(dirname(path), `${kind}.json`);
			if (kind === "symlink") symlinkSync(path, alias);
			else linkSync(path, alias);
			expectRefusal(() => addMcpServerConfig(alias, "secret", literalCases[0].config), path);
		}
	});

	it("checks serialized config rather than trusting getters or toJSON", () => {
		const { path } = fixture("global", 0o644);
		const config = { ...HTTP, toJSON: () => ({ ...HTTP, headers: { Authorization: FAKE_SECRET } }) };
		expectRefusal(() => addMcpServerConfig(path, "secret", config), path);
	});
});
