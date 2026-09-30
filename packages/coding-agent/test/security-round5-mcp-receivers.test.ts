import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import type { McpExposure, McpServerConfig } from "../src/core/mcp-servers.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import * as runtime from "../src/extensions/mcp/runtime.ts";
import * as mcpUi from "../src/extensions/mcp/ui.ts";
import { createHarness, createTestUiContext } from "./suite/harness.ts";

const KEYS = ["__proto__", "constructor", "toString", "ordinary"] as const;
const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(mode: number) {
	const directory = mkdtempSync(join(tmpdir(), "pi-round5-receivers-"));
	directories.push(directory);
	const path = join(directory, "mcp.json");
	writeFileSync(path, '{"retained":true,"mcpServers":{}}\n', { mode });
	chmodSync(path, mode);
	const output: string[] = [];
	return {
		path,
		output,
		run: (args: string[]) =>
			runMcpCommand(args, {
				cwd: directory,
				agentDir: directory,
				credentials: new runtime.McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
				log: (line) => output.push(line),
				error: (line) => output.push(line),
			}),
	};
}

function addArgs(channel: "env" | "header", key: string, value: string): string[] {
	return [
		"add",
		"fixture",
		`--${channel}`,
		`${key}=${value}`,
		...(channel === "env" ? ["--", "not-executed"] : ["--url", "https://unused.invalid/mcp"]),
	];
}

// smarty-dev#2507: the real parser/writer must not silently drop legal pair names before the guard.
describe.each(["env", "header"] as const)("round5 CLI %s pairs", (channel) => {
	it.each(KEYS)(
		"persists %s as own private JSON data, including replacement",
		async (key) => {
			const fixture = setup(0o600);
			const args = addArgs(channel, key, "fake-first");
			args.splice(4, 0, `--${channel}`, `${key}=fake-final=x`);
			expect(await fixture.run(args)).toBe(0);
			const parsed = JSON.parse(readFileSync(fixture.path, "utf8")) as {
				retained: boolean;
				mcpServers: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
			};
			const record = channel === "env" ? parsed.mcpServers.fixture.env : parsed.mcpServers.fixture.headers;
			expect(record).toBeDefined();
			expect(Object.hasOwn(record ?? {}, key)).toBe(true);
			expect(record?.[key]).toBe("fake-final=x");
			expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
			expect(parsed.retained).toBe(true);
			expect(statSync(fixture.path).mode & 0o777).toBe(0o600);
		},
		10_000,
	);

	it.each(KEYS)(
		"refuses literal %s in a public file without rewriting",
		async (key) => {
			const fixture = setup(0o644);
			const before = readFileSync(fixture.path, "utf8");
			expect(await fixture.run(addArgs(channel, key, "fake-literal"))).toBe(1);
			expect(readFileSync(fixture.path, "utf8")).toBe(before);
			expect(statSync(fixture.path).mode & 0o777).toBe(0o644);
			expect(fixture.output.join("\n")).toContain("refusing to persist literal credentials");
			expect(fixture.output.join("\n")).not.toContain("fake-literal");
		},
		10_000,
	);

	it.each(KEYS)(
		"retains whole references for %s in a public file",
		async (key) => {
			const fixture = setup(0o644);
			expect(await fixture.run(addArgs(channel, key, "$FAKE_REFERENCE"))).toBe(0);
			const parsed = JSON.parse(readFileSync(fixture.path, "utf8")) as {
				mcpServers: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
			};
			const record = channel === "env" ? parsed.mcpServers.fixture.env : parsed.mcpServers.fixture.headers;
			expect(Object.hasOwn(record ?? {}, key)).toBe(true);
			expect(record?.[key]).toBe("$FAKE_REFERENCE");
			expect(statSync(fixture.path).mode & 0o777).toBe(0o644);
		},
		10_000,
	);
});

// smarty-dev#2507: exercise actual CLI plain-list formatting with a public in-memory transport.
describe("round5 CLI exposure receiver", () => {
	it.each(["codemode", "codemode-deferred", "deferred", "direct", "hidden"] as const)(
		"prints own overrides and leaves reserved defaults undecorated for %s",
		async (exposure) => {
			vi.spyOn(runtime, "createDefaultTransport").mockImplementation(() => {
				const pair = createInMemoryTransportPair();
				pair.server.onMessage((message) => {
					if (!("id" in message) || !("method" in message)) return;
					const result =
						message.method === "initialize"
							? {
									protocolVersion: LATEST_PROTOCOL_VERSION,
									capabilities: { tools: {} },
									serverInfo: { name: "fake", version: "1" },
								}
							: { tools: KEYS.map((name) => ({ name, inputSchema: { type: "object" } })) };
					queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: message.id, result }));
				});
				void pair.server.start();
				return pair.client;
			});
			const fixture = setup(0o600);
			const alternate: McpExposure = exposure === "direct" ? "deferred" : "direct";
			const list = async (toolExposure: Record<string, McpExposure>, expected: string) => {
				writeFileSync(
					fixture.path,
					JSON.stringify({ mcpServers: { fixture: { command: "not-executed", exposure, toolExposure } } }),
				);
				fixture.output.length = 0;
				expect(await fixture.run(["list"])).toBe(0);
				expect.soft(fixture.output.find((line) => line.startsWith("  tools:"))).toBe(expected);
			};
			await list({ ordinary: alternate }, `  tools: __proto__, constructor, toString, ordinary [${alternate}]`);
			await list(
				Object.fromEntries(KEYS.map((key) => [key, alternate])),
				`  tools: ${KEYS.map((key) => `${key} [${alternate}]`).join(", ")}`,
			);
			await list(
				{ "*": alternate, constructor: exposure },
				`  tools: __proto__ [${alternate}], constructor, toString [${alternate}], ordinary [${alternate}]`,
			);
		},
		10_000,
	);
});

// smarty-dev#2507: reuse the existing suite's public manager-menu interception, not a rendered-proof claim.
describe("round5 interactive server details receiver", () => {
	it.each([
		["https://fake-user:fake-password@example.invalid/mcp", "https://REDACTED:REDACTED@example.invalid/mcp"],
		["https://fake-user@example.invalid/mcp", "https://REDACTED@example.invalid/mcp"],
		["https://:fake-password@example.invalid/mcp", "https://:REDACTED@example.invalid/mcp"],
		["https://example.invalid/mcp?ordinary=yes", "https://example.invalid/mcp?ordinary=yes"],
	])(
		"keeps private userinfo out of /mcp details for %s",
		async (url, expected) => {
			const details: string[] = [];
			const choices = ["fixture", undefined, undefined];
			vi.spyOn(mcpUi, "showMcpManager").mockImplementation(async (_ctx, manage) => {
				await manage({
					menu: async (build) => {
						const menu = build();
						if (menu.details) details.push(menu.details);
						return choices.shift();
					},
					status: () => {},
					redirectUrl: async () => undefined,
				});
			});
			const config: McpServerConfig = { url, enabled: false };
			const harness = await createHarness({
				initialActiveToolNames: [],
				extensionFactories: [
					createMcpExtension({
						loadConfig: () => ({
							servers: [{ name: "fixture", config, source: "private-test-file", scope: "global" }],
							errors: [],
						}),
					}),
				],
			});
			try {
				await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
				await harness.session.prompt("/mcp");
				expect(details).toEqual([`${expected}\nglobal: private-test-file\nState: disabled`]);
				expect(config.url).toBe(url);
				expect(harness.getPendingResponseCount()).toBe(0);
			} finally {
				await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				harness.cleanup();
			}
		},
		10_000,
	);
});
