import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { McpServerRegistry } from "../src/core/mcp-servers.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import {
	addMcpServerConfig,
	loadMcpConfig,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "../src/extensions/mcp/config.ts";
import { createCodemodeExtension, createMcpExtension } from "../src/index.ts";

// PR #131: retained APIs must refuse mutation even after an empty factory returns.
it("refuses retained extension MCP mutation before input inspection", async () => {
	let retained: ExtensionAPI | undefined;
	const runtime = createExtensionRuntime();
	await loadExtensionFromFactory(
		(api) => {
			retained = api;
		},
		process.cwd(),
		createEventBus(),
		runtime,
	);
	if (!retained) throw new Error("Missing retained API");
	expect(() => retained!.registerMcpServer("x", poison as never)).toThrow("MCP_SECURITY_REVIEW_REQUIRED");
	expect(() => retained!.unregisterMcpServer("x")).toThrow("MCP_SECURITY_REVIEW_REQUIRED");
	expect(runtime.mcpServers.list()).toEqual([]);
});

const poison = new Proxy(
	{},
	{
		get() {
			throw new Error("INPUT_INSPECTED");
		},
	},
);

// smarty-dev#4506 step 2: only Codemode's prerequisites were repaired by pi#203.
it("supplies Codemode but not MCP to ordinary CLI startup", () => {
	expect(builtInExtensions.map((extension) => extension.name)).toContain("codemode");
	expect(builtInExtensions.map((extension) => extension.name)).not.toContain("mcp");
});

it("loads the SDK Codemode factory as an inactive tool", async () => {
	const extension = await loadExtensionFromFactory(
		createCodemodeExtension(),
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
	);
	expect(extension.tools.get("codemode")?.definition).toMatchObject({ name: "codemode", defaultActive: false });
});

it("still refuses the MCP SDK factory before inspecting its API", () => {
	expect(() => createMcpExtension(poison)(poison as ExtensionAPI)).toThrow("MCP_SECURITY_REVIEW_REQUIRED");
});

// smarty-dev#4506: settings and explicit -e activate Codemode, never MCP.
it("resolves Codemode but keeps MCP refused with settings and explicit -e", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi131-admission-"));
	try {
		for (const extensions of [[], ["+builtin:codemode", "+builtin:mcp"]]) {
			const manager = new DefaultPackageManager({
				cwd: directory,
				agentDir: directory,
				settingsManager: SettingsManager.inMemory({ extensions }),
				builtinExtensions: ["codemode", "mcp"],
			});
			const resolved = await manager.resolve();
			expect(resolved.extensions.filter((resource) => resource.enabled).map((resource) => resource.path)).toEqual([
				"builtin:codemode",
			]);
			const explicit = await manager.resolveExtensionSources(["builtin:codemode"]);
			expect(explicit.extensions).toMatchObject([{ path: "builtin:codemode", enabled: true }]);
			await expect(manager.resolveExtensionSources(["builtin:mcp"])).rejects.toThrow("MCP_SECURITY_REVIEW_REQUIRED");
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("refuses standalone pi mcp before configuration or credentials are read", async () => {
	const output: string[] = [];
	const options = {
		cwd: "/nonexistent/pi131",
		agentDir: "/nonexistent/pi131",
		error: (line: string) => output.push(line),
		get credentials(): never {
			throw new Error("CREDENTIALS_READ");
		},
	};
	for (const command of ["add", "remove", "list", "login", "logout"])
		expect(await runMcpCommand([command], options)).toBe(1);
	expect(output).toHaveLength(5);
	for (const line of output) expect(line).toContain("MCP_SECURITY_REVIEW_REQUIRED");
});

it("refuses configuration readers and writers before inspecting paths or values", () => {
	expect(() => loadMcpConfig(poison as never)).toThrow("MCP_SECURITY_REVIEW_REQUIRED");
	expect(() => addMcpServerConfig("/nonexistent/pi131", "x", poison as never)).toThrow("MCP_SECURITY_REVIEW_REQUIRED");
	expect(() => updateMcpServerConfig("/nonexistent/pi131", "x", poison)).toThrow("MCP_SECURITY_REVIEW_REQUIRED");
	expect(() => removeMcpServerConfig("/nonexistent/pi131", "x")).toThrow("MCP_SECURITY_REVIEW_REQUIRED");
});

it("refuses registry mutation before cloning or reading registration input", () => {
	const registry = new McpServerRegistry();
	expect(() => registry.register(poison as never)).toThrow("MCP_SECURITY_REVIEW_REQUIRED");
	expect(() => registry.unregister("x", "sense")).toThrow("MCP_SECURITY_REVIEW_REQUIRED");
	expect(registry.list()).toEqual([]);
});
