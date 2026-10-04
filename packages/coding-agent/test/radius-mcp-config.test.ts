import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { RADIUS_MCP_URL } from "../src/core/radius.ts";
import { addMcpServerConfig } from "../src/extensions/mcp/config.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const offer = Reflect.get(InteractiveMode.prototype, "offerRadiusMcpServer") as (
	this: object,
	providerId: string,
	providerName: string,
) => void;

// pi#137 A2: accepting Radius setup must not destroy unrelated or malformed entries.
describe("Radius MCP configuration custody", () => {
	beforeAll(() => initTheme("dark"));
	let directory: string;
	afterEach(() => {
		vi.unstubAllEnvs();
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	function setup(servers: Record<string, unknown>) {
		directory = mkdtempSync(join(tmpdir(), "pi-radius-mcp-"));
		vi.stubEnv(ENV_AGENT_DIR, directory);
		const path = join(directory, "mcp.json");
		writeFileSync(path, JSON.stringify({ mcpServers: servers }));
		return path;
	}

	function accept(beforeAccept?: () => void) {
		const showError = vi.fn();
		const handleReloadCommand = vi.fn(async () => {});
		offer.call(
			{
				sessionManager: { getCwd: () => directory },
				showError,
				handleReloadCommand,
				ui: { requestRender: vi.fn() },
				showSelector: (create: (done: () => void) => { component: { handleInput(data: string): void } }) => {
					const { component } = create(() => {});
					beforeAccept?.();
					component.handleInput("\r");
				},
			},
			"radius",
			"Radius",
		);
		return { showError, handleReloadCommand };
	}

	it.each([
		{ radius: { command: "unrelated-a" }, "radius-mcp": { command: "unrelated-b" } },
		{ radius: null, radius_mcp: { command: "unrelated-b" }, "radius-mcp-2": false },
	])("chooses an unused name across exact, malformed and normalized collisions: %j", (servers) => {
		const path = setup(servers);
		const { showError, handleReloadCommand } = accept();
		const saved = JSON.parse(readFileSync(path, "utf8")).mcpServers as Record<string, unknown>;
		for (const [name, config] of Object.entries(servers)) expect(saved[name]).toEqual(config);
		const added = Object.keys(saved).filter((name) => !Object.hasOwn(servers, name));
		expect(added).toHaveLength(1);
		expect(saved[added[0]]).toEqual({ url: RADIUS_MCP_URL, auth: { provider: "radius" } });
		expect(showError).not.toHaveBeenCalled();
		expect(handleReloadCommand).toHaveBeenCalledOnce();
	});

	it("preserves a matching Radius server's other settings while replacing its OAuth login", () => {
		const path = setup({ custom: { url: `${RADIUS_MCP_URL}/`, timeout: 20, oauth: { clientId: "old" } } });
		accept();
		expect(JSON.parse(readFileSync(path, "utf8")).mcpServers).toEqual({
			custom: { url: `${RADIUS_MCP_URL}/`, timeout: 20, auth: { provider: "radius" } },
		});
	});

	it.each([null, false, { command: "other" }, { url: "https://other.example/mcp" }])(
		"refuses a nonmatching replacement introduced while the prompt is open: %j",
		(replacement) => {
			const path = setup({ custom: { url: RADIUS_MCP_URL } });
			const { showError, handleReloadCommand } = accept(() => {
				writeFileSync(path, JSON.stringify({ mcpServers: { custom: replacement } }));
			});
			expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.custom).toEqual(replacement);
			expect(showError).toHaveBeenCalledOnce();
			expect(handleReloadCommand).not.toHaveBeenCalled();
		},
	);

	it("rejects a normalized namespace collision before writing any bytes", () => {
		const path = setup({ radius_mcp: null });
		const before = readFileSync(path, "utf8");
		expect(() =>
			addMcpServerConfig(path, "radius-mcp", { url: RADIUS_MCP_URL }, { expectedUrl: RADIUS_MCP_URL }),
		).toThrow("conflicts");
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("keeps the explicitly named CLI add replacement behavior", () => {
		const path = setup({ custom: { command: "old" } });
		expect(addMcpServerConfig(path, "custom", { command: "new" })).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.custom).toEqual({ command: "new" });
	});
});
