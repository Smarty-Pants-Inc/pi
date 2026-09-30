import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getMcpToolExposure,
	type McpExposure,
	type McpServerConfig,
	validateMcpServerConfig,
} from "../src/core/mcp-servers.ts";
import {
	addMcpServerConfig,
	loadMcpConfig,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "../src/extensions/mcp/config.ts";
import { createMcpToolDefinition } from "../src/extensions/mcp/tools.ts";
import { createHarness } from "./suite/harness.ts";

const RESERVED = ["__proto__", "constructor", "toString"] as const;
const SERVER: McpServerConfig = { command: "fake-not-executed" };

function withConfig(run: (path: string, directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "pi-round5-owned-"));
	try {
		const path = join(directory, "mcp.json");
		writeFileSync(path, '{"retained":true,"mcpServers":{}}\n', { mode: 0o600 });
		run(path, directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

// smarty-dev#2241: legal reserved names must remain owned data, not inherited CRUD targets.
describe("round5 MCP owned server dictionaries", () => {
	it.each([...RESERVED, "ordinary"])(
		"persists and reloads the legal server %s through owned CRUD",
		(name) => {
			withConfig((path, directory) => {
				expect(validateMcpServerConfig(name, SERVER)).toEqual(SERVER);
				const replaced = addMcpServerConfig(path, name, SERVER);
				const persisted = JSON.parse(readFileSync(path, "utf8")) as {
					retained: boolean;
					mcpServers: Record<string, McpServerConfig>;
				};
				// Check the actual omission before the replacement flag: __proto__ was silently lost on disk.
				expect(Object.hasOwn(persisted.mcpServers, name)).toBe(true);
				expect(persisted.mcpServers[name]).toEqual(SERVER);
				expect(Object.getPrototypeOf(persisted.mcpServers)).toBe(Object.prototype);
				expect(replaced).toBe(false);
				const load = () => loadMcpConfig({ agentDir: directory, cwd: directory, projectTrusted: false });
				expect(load().errors).toEqual([]);
				expect(load().servers.map((entry) => [entry.name, entry.config])).toEqual([[name, SERVER]]);

				expect(addMcpServerConfig(path, name, { command: "fake-replacement" })).toBe(true);
				updateMcpServerConfig(path, name, { enabled: false, exposure: "direct" });
				expect(load().servers[0]?.config).toEqual({
					command: "fake-replacement",
					enabled: false,
					exposure: "direct",
				});
				updateMcpServerConfig(path, name, { enabled: true, exposure: "codemode" });
				expect(load().servers[0]?.config).toEqual({ command: "fake-replacement" });
				expect(removeMcpServerConfig(path, name)).toBe(true);
				expect(removeMcpServerConfig(path, name)).toBe(false);
				expect(load().servers).toEqual([]);
				expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ retained: true, mcpServers: {} });
			});
		},
		10_000,
	);

	it.each([...RESERVED, "ordinary"])(
		"creates a fresh file with owned server %s",
		(name) => {
			withConfig((path, directory) => {
				rmSync(path);
				const replaced = addMcpServerConfig(path, name, SERVER);
				const persisted = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, McpServerConfig> };
				expect(Object.hasOwn(persisted.mcpServers, name)).toBe(true);
				expect(replaced).toBe(false);
				expect(
					loadMcpConfig({ agentDir: directory, cwd: directory, projectTrusted: false }).servers.map(
						(entry) => entry.name,
					),
				).toEqual([name]);
			});
		},
		10_000,
	);

	it.each(RESERVED)(
		"does not update an inherited nonexistent server %s or mutate its prototype",
		(name) => {
			withConfig((path) => {
				const before = readFileSync(path, "utf8");
				const descriptors = Object.getOwnPropertyDescriptors(Object.prototype);
				let thrown: unknown;
				let after: PropertyDescriptorMap;
				try {
					try {
						updateMcpServerConfig(path, name, { enabled: false, exposure: "direct" });
					} catch (error) {
						thrown = error;
					}
					after = Object.getOwnPropertyDescriptors(Object.prototype);
				} finally {
					// The exact-head regression mutates Object.prototype for __proto__. Restore saved
					// descriptors in this isolated worker before assertions or another case can run.
					for (const key of Object.getOwnPropertyNames(Object.prototype)) {
						if (!Object.hasOwn(descriptors, key)) Reflect.deleteProperty(Object.prototype, key);
					}
					Object.defineProperties(Object.prototype, descriptors);
				}
				expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(descriptors);
				expect(after).toEqual(descriptors);
				expect(thrown).toBeInstanceOf(Error);
				expect(String(thrown)).toContain(`does not define MCP server "${name}"`);
				expect(readFileSync(path, "utf8")).toBe(before);
			});
		},
		10_000,
	);

	it.each(RESERVED)(
		"does not remove an inherited nonexistent server %s or rewrite the file",
		(name) => {
			withConfig((path) => {
				const before = readFileSync(path, "utf8");
				expect(removeMcpServerConfig(path, name)).toBe(false);
				expect(readFileSync(path, "utf8")).toBe(before);
			});
		},
		10_000,
	);
});

// smarty-dev#2241: inherited tool names must use normal defaults/patterns and stay callable.
describe("round5 MCP owned exposure dictionaries", () => {
	it.each([...RESERVED, "ordinary"])(
		"uses defaults, patterns and exact entries for tool %s",
		(name) => {
			expect.soft(getMcpToolExposure(SERVER, name)).toBe("codemode");
			for (const exposure of ["codemode", "codemode-deferred", "deferred", "direct", "hidden"] as const) {
				expect.soft(getMcpToolExposure({ ...SERVER, exposure, toolExposure: {} }, name)).toBe(exposure);
			}
			const pattern = `${name.slice(0, 2)}*`;
			expect
				.soft(
					getMcpToolExposure(
						{ ...SERVER, exposure: "hidden", toolExposure: { [pattern]: "deferred", "*": "direct" } },
						name,
					),
				)
				.toBe("deferred");
			const toolExposure = Object.fromEntries([
				["*", "hidden"],
				[name, "direct"],
			]) as Record<string, McpExposure>;
			expect(Object.hasOwn(toolExposure, name)).toBe(true);
			expect.soft(getMcpToolExposure({ ...SERVER, exposure: "deferred", toolExposure }, name)).toBe("direct");
			expect
				.soft(getMcpToolExposure({ ...SERVER, toolExposure: { [name]: "hidden", "*": "direct" } }, name))
				.toBe("hidden");
			expect
				.soft(getMcpToolExposure({ ...SERVER, toolExposure: { [`${name}.*`]: "hidden" } }, name))
				.toBe("codemode");
		},
		10_000,
	);

	it("retains ordinary pattern ordering, escaped punctuation, and explicit hidden entries", () => {
		const config: McpServerConfig = {
			...SERVER,
			exposure: "deferred",
			toolExposure: { "get_*": "codemode", "get_file*": "hidden", get_file: "direct", "file.*": "hidden" },
		};
		expect(getMcpToolExposure(config, "get_file")).toBe("direct");
		expect(getMcpToolExposure(config, "get_file_more")).toBe("codemode");
		expect(getMcpToolExposure(config, "file.txt")).toBe("hidden");
		expect(getMcpToolExposure(config, "file_txt")).toBe("deferred");
	}, 10_000);

	it("publishes reserved MCP tools into the actual session callable set with no provider requests", async () => {
		const offered = [...RESERVED, "ordinary"];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					for (const name of offered) {
						pi.registerTool(
							createMcpToolDefinition({
								server: "fixture",
								tool: { name, inputSchema: { type: "object" } },
								name: `mcp__fixture__${name}`,
								exposure: getMcpToolExposure(SERVER, name),
								namespace: { name: "mcp__fixture", description: "Fake local tools" },
								timeoutMs: 1000,
								getClient: async () => ({ callTool: async () => ({ content: [] }) }),
							}),
						);
					}
				},
			],
		});
		try {
			await harness.session.bindExtensions({});
			expect(harness.session.getCallableToolNames()).toEqual(offered.map((name) => `mcp__fixture__${name}`));
			expect(harness.session.getActiveToolNames()).toEqual([]);
		} finally {
			harness.cleanup();
		}
	}, 10_000);
});
