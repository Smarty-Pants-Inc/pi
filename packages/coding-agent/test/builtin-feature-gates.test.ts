import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";

// pi#107 decision (a): park codemode F5/A2, F16 and MCP A1, F17 reporting behind explicit opt-in.
describe("security-sensitive built-in feature gates", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-builtin-gates-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(root, { recursive: true, force: true });
	});

	async function load(settings: SettingsManager = SettingsManager.create(cwd, agentDir)) {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: settings,
			extensionFactories: builtInExtensions.filter(
				(input) => typeof input !== "function" && ["codemode", "mcp"].includes(input.name),
			),
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		return loader.getExtensions().extensions;
	}

	it("does not register either built-in by default, even with old tool and MCP configuration", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultTools: ["codemode"], codemode: { mode: "only" } }),
		);
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { private: { url: "https://fake:FAKE_SECRET@example.invalid/mcp", enabled: false } },
			}),
		);
		expect(await load()).toEqual([]);
	});

	it.each(["codemode", "mcp"])("registers only %s after its explicit settings opt-in", async (name) => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [`+builtin:${name}`] }));
		const extensions = await load();
		expect(extensions.map((extension) => extension.path)).toEqual([`builtin:${name}`]);
		if (name === "codemode") expect(extensions[0].tools.has("codemode")).toBe(true);
		else expect(extensions[0].commands.has("mcp")).toBe(true);
	});

	it("does not accept an untrusted project opt-in", async () => {
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ extensions: ["+builtin:codemode", "+builtin:mcp"] }),
		);
		expect(await load(SettingsManager.create(cwd, agentDir, { projectTrusted: false }))).toEqual([]);
		expect((await load()).map((extension) => extension.path)).toEqual(["builtin:codemode", "builtin:mcp"]);
	});

	it("respects project disable overrides after global opt-in", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ extensions: ["+builtin:codemode", "+builtin:mcp"] }),
		);
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ extensions: ["-builtin:codemode", "-builtin:mcp"] }),
		);
		expect(await load()).toEqual([]);
	});

	it.each([
		["list"],
		["list", "--json"],
		["login", "private"],
		["logout", "private"],
		["add", "new", "--url", "https://example.invalid/mcp"],
		["remove", "private"],
	])("blocks pi mcp %j before configuration, credentials, network or browser use by default", async (...args) => {
		const config = JSON.stringify({
			mcpServers: { private: { url: "https://fake:FAKE_SECRET@example.invalid/mcp", enabled: false } },
		});
		writeFileSync(join(agentDir, "mcp.json"), config);
		const fetchSpy = vi.fn(() => {
			throw new Error("unexpected network");
		});
		vi.stubGlobal("fetch", fetchSpy);
		const openUrl = vi.fn();
		const output: string[] = [];
		const exit = await runMcpCommand(args, {
			cwd,
			agentDir,
			openUrl,
			log: (line) => output.push(line),
			error: (line) => output.push(line),
		});
		expect(exit).toBe(1);
		expect(output.join("\n")).toContain("MCP is disabled");
		expect(output.join("\n")).toContain("+builtin:mcp");
		expect(output.join("\n")).not.toContain("FAKE_SECRET");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(openUrl).not.toHaveBeenCalled();
		expect(readFileSync(join(agentDir, "mcp.json"), "utf8")).toBe(config);
	});

	it("allows pi mcp only with explicit global or trusted project enablement", async () => {
		const output: string[] = [];
		const options = {
			cwd,
			agentDir,
			log: (line: string) => output.push(line),
			error: (line: string) => output.push(line),
		};
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["+builtin:mcp"] }));
		expect(await runMcpCommand(["list", "--json"], options)).toBe(1);
		new ProjectTrustStore(agentDir).set(cwd, true);
		output.length = 0;
		expect(await runMcpCommand(["list", "--json"], options)).toBe(0);
		expect(JSON.parse(output[0])).toEqual({ servers: [], errors: [] });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["+builtin:mcp"] }));
		expect(await runMcpCommand(["list"], options)).toBe(1);
		writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
		expect(await runMcpCommand(["list", "--json"], options)).toBe(0);
	});
});
