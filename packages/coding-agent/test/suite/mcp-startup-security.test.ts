import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import * as runtimeLoader from "../../src/extensions/mcp/runtime.lazy.ts";
import * as runtime from "../../src/extensions/mcp/runtime.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const peers: ReturnType<typeof createInMemoryTransportPair>["server"][] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	await Promise.all(peers.splice(0).map((peer) => peer.close()));
	vi.restoreAllMocks();
});

// pi#137 / smarty-dev#3535, security finding 8.
it.each([
	["unregister", 1],
	["replace", 1],
	["unregister", 2],
	["replace", 2],
] as const)("revokes startup before connection assignment on %s at runtime load %s", async (action, boundary) => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let loads = 0;
	vi.spyOn(runtimeLoader, "loadMcpRuntime").mockImplementation(async () => {
		if (++loads >= boundary) await gate;
		return runtime;
	});
	let api: ExtensionAPI | undefined;
	const connected: string[] = [];
	const harness = await createHarness({
		initialActiveToolNames: [],
		extensionFactories: [
			(pi) => {
				api = pi;
				pi.registerMcpServer("revoked", { command: "old", exposure: "direct" });
			},
			createMcpExtension({
				loadConfig: () => ({ servers: [], errors: [] }),
				createTransport: (entry) => {
					connected.push("command" in entry.config ? entry.config.command : "");
					const pair = fakeServer("new");
					return pair.client;
				},
			}),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext() });
	await vi.waitFor(() => expect(loads).toBeGreaterThanOrEqual(boundary));
	if (!api) throw new Error("Missing extension API");
	if (action === "unregister") api.unregisterMcpServer("revoked");
	else api.registerMcpServer("revoked", { command: "new", exposure: "direct" });
	release();
	if (action === "replace")
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__revoked__new"));
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(connected).toEqual(action === "replace" ? ["new"] : []);
	expect(harness.session.getCallableToolNames()).not.toContain("mcp__revoked__old");
});

function fakeServer(tool: string, holdTools = false) {
	const pair = createInMemoryTransportPair();
	peers.push(pair.server);
	let pending: JsonRpcRequest | undefined;
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		if (message.method === "tools/list" && holdTools) {
			pending = message;
			return;
		}
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "fake", version: "1" },
					}
				: { tools: [{ name: tool, inputSchema: { type: "object" } }] };
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	void pair.server.start();
	return { ...pair, pending: () => pending };
}

it.each(["unregister", "replace"])("revokes a connected startup before tool publication on %s", async (action) => {
	let api: ExtensionAPI | undefined;
	const old = fakeServer("old", true);
	const close = vi.spyOn(old.client, "close");
	const harness = await createHarness({
		initialActiveToolNames: [],
		extensionFactories: [
			(pi) => {
				api = pi;
				pi.registerMcpServer("revoked", { command: "old", exposure: "direct" });
			},
			createMcpExtension({
				loadConfig: () => ({ servers: [], errors: [] }),
				createTransport: (entry) =>
					"command" in entry.config && entry.config.command === "old" ? old.client : fakeServer("new").client,
			}),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext() });
	await vi.waitFor(() => expect(old.pending()).toBeDefined());
	if (!api) throw new Error("Missing extension API");
	if (action === "unregister") api.unregisterMcpServer("revoked");
	else api.registerMcpServer("revoked", { command: "new", exposure: "direct" });
	await vi.waitFor(() => expect(close).toHaveBeenCalled());
	if (action === "replace")
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__revoked__new"));
	expect(harness.session.getCallableToolNames()).not.toContain("mcp__revoked__old");
});
