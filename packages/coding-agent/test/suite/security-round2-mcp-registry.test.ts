import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	isJsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	type McpFetch,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { McpServerConfig } from "../../src/core/mcp-servers.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import * as mcpUi from "../../src/extensions/mcp/ui.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

/** Real HTTP transport with a controlled, offline fetch boundary. No credential or network access. */
function httpServer(label: string, pauseList = false, pauseDelete = false) {
	const listed = Promise.withResolvers<void>();
	const releaseList = Promise.withResolvers<void>();
	const deleting = Promise.withResolvers<void>();
	const releaseDelete = Promise.withResolvers<void>();
	const calls: string[] = [];
	let constructed = 0;
	let deleted = false;
	let aborted = false;
	const fetch: McpFetch = async (_url, init) => {
		if (init?.method === "DELETE") {
			deleting.resolve();
			if (pauseDelete) await releaseDelete.promise;
			deleted = true;
			return new Response(null, { status: 204 });
		}
		if (init?.method === "GET") return new Response(null, { status: 405 });
		const message: unknown = JSON.parse(String(init?.body));
		if (!isJsonRpcRequest(message)) return new Response(null, { status: 202 });
		let result: unknown;
		switch (message.method) {
			case "initialize":
				result = {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: label, version: "1" },
				};
				break;
			case "tools/list": {
				listed.resolve();
				const signal = init?.signal;
				const onAbort = () => {
					aborted = true;
					releaseList.resolve();
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					if (pauseList) await releaseList.promise;
					signal?.throwIfAborted();
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
				result = { tools: [{ name: label, inputSchema: { type: "object", properties: {} } }] };
				break;
			}
			case "tools/call":
				calls.push(label);
				result = { content: [{ type: "text", text: label }] };
				break;
			default:
				result = {};
		}
		return Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "mcp-session-id": label } });
	};
	return {
		calls,
		listed: listed.promise,
		deleting: deleting.promise,
		releaseList: () => releaseList.resolve(),
		releaseDelete: () => releaseDelete.resolve(),
		get constructed() {
			return constructed;
		},
		get deleted() {
			return deleted;
		},
		get aborted() {
			return aborted;
		},
		transport: () => {
			constructed++;
			return new StreamableHttpTransport({ url: `http://${label}.invalid`, fetch });
		},
	};
}

const config = (label: string, enabled = true): McpServerConfig => ({
	url: `http://${label}.invalid`,
	headers: { Authorization: "fake-test-only" },
	exposure: "direct",
	enabled,
});

// smarty-dev#2241 (F13/Astra6): exercise the public registration API, not a raw connection owner.
describe("MCP registry pending ownership", () => {
	const harnesses: Harness[] = [];
	const endpoints: ReturnType<typeof httpServer>[] = [];

	afterEach(async () => {
		for (const endpoint of endpoints) {
			endpoint.releaseList();
			endpoint.releaseDelete();
		}
		while (harnesses.length > 0) {
			const harness = harnesses.pop();
			if (!harness) continue;
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		endpoints.length = 0;
		vi.restoreAllMocks();
	});

	async function setup(seed = false, pauseList = false, pauseDelete = false) {
		const old = httpServer("old", pauseList, pauseDelete);
		const healthy = httpServer("healthy");
		const unrelated = httpServer("unrelated");
		endpoints.push(old, healthy, unrelated);
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					api = pi;
					if (seed) pi.registerMcpServer("pending", config("old"));
				},
				(pi) => pi.registerMcpServer("other", config("unrelated")),
				createMcpExtension({
					loadConfig: () => ({ servers: [], errors: [] }),
					credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
					createTransport: (entry) => {
						if (!("url" in entry.config)) throw new Error("Expected HTTP config");
						const hostname = new URL(entry.config.url).hostname;
						const endpoint =
							hostname === "healthy.invalid" ? healthy : hostname === "unrelated.invalid" ? unrelated : old;
						return endpoint.transport();
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		if (!api) throw new Error("Missing registration API");
		return { harness, pi: api, old, healthy, unrelated };
	}

	async function call(harness: Harness, name: string) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call the test tool");
		return getToolResult(harness, name);
	}

	it.each(["unregister", "replace", "disable"] as const)(
		"fences immediate %s before construction and keeps other registrations usable",
		async (action) => {
			const { harness, pi, old, healthy, unrelated } = await setup();
			pi.registerMcpServer("pending", config("old"));
			if (action === "unregister") pi.unregisterMcpServer("pending");
			else pi.registerMcpServer("pending", config("healthy", action !== "disable"));
			// Another extension's registry entry cannot be removed by this API owner.
			pi.unregisterMcpServer("other");
			await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__other__unrelated"));
			if (action === "replace") {
				await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__pending__healthy"));
				expect(getMessageText(await call(harness, "mcp__pending__healthy"))).toBe("healthy");
				expect(healthy.calls).toEqual(["healthy"]);
			}
			const staleCall = await call(harness, "mcp__pending__old");
			expect({ isError: staleCall.isError, calls: old.calls }).toEqual({ isError: true, calls: [] });
			expect(harness.session.getCallableToolNames()).not.toContain("mcp__pending__old");
			expect(old.constructed).toBe(0);
			expect(old.calls).toEqual([]);
			expect(getMessageText(await call(harness, "mcp__other__unrelated"))).toBe("unrelated");
			expect(unrelated.calls).toEqual(["unrelated"]);
		},
	);

	it("fences disabled replacement captured by deferred session startup", async () => {
		const { harness, pi, old } = await setup(true);
		pi.registerMcpServer("pending", config("old", false));
		expect((await call(harness, "mcp__pending__old")).isError).toBe(true);
		expect(old.constructed).toBe(0);
	});

	it.each(["unregister", "replace"] as const)(
		"joins %s during gated HTTP discovery through owner shutdown",
		async (action) => {
			const { harness, pi, old, healthy } = await setup(false, true, true);
			pi.registerMcpServer("pending", config("old"));
			await old.listed;
			if (action === "unregister") pi.unregisterMcpServer("pending");
			else pi.registerMcpServer("pending", config("healthy"));
			await old.deleting;
			if (action === "replace") {
				await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__pending__healthy"));
				expect(getMessageText(await call(harness, "mcp__pending__healthy"))).toBe("healthy");
				expect(healthy.calls).toEqual(["healthy"]);
			}
			let shutDown = false;
			const shutdown = harness.session.extensionRunner
				.emit({ type: "session_shutdown", reason: "quit" })
				.then(() => {
					shutDown = true;
				});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(shutDown).toBe(false);
			expect(old.deleted).toBe(false);
			expect(old.aborted).toBe(true);
			expect(harness.session.getCallableToolNames()).not.toContain("mcp__pending__old");
			old.releaseDelete();
			await shutdown;
			expect(old.deleted).toBe(true);
			expect(shutDown).toBe(true);
			expect(old.calls).toEqual([]);
		},
	);

	it("disables gated discovery through the public manager and re-enables a fresh lifetime", async () => {
		const { harness, pi, old } = await setup(false, true, true);
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__other__unrelated"));
		const choices = ["pending", "disable", "enable", undefined, undefined];
		vi.spyOn(mcpUi, "showMcpManager").mockImplementation(async (_ctx, manage) => {
			await manage({
				menu: async () => choices.shift(),
				status: () => {},
				redirectUrl: async () => undefined,
			});
		});
		harness.session.extensionRunner.setUIContext(createTestUiContext(), "tui");
		pi.registerMcpServer("pending", config("old"));
		await old.listed;
		const managing = harness.session.prompt("/mcp");
		await old.deleting;
		expect(old.aborted).toBe(true);
		expect(harness.session.getCallableToolNames()).not.toContain("mcp__pending__old");
		old.releaseDelete();
		await managing;
		expect(old.constructed).toBe(2);
		expect(getMessageText(await call(harness, "mcp__pending__old"))).toBe("old");
		expect(old.calls).toEqual(["old"]);
	});

	it("joins shutdown of an immediately registered owner before runtime load resumes", async () => {
		const { harness, pi, old } = await setup();
		pi.registerMcpServer("pending", config("old"));
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(old.constructed).toBe(0);
		expect(old.calls).toEqual([]);
	});

	it("joins shutdown before deferred construction without opening a transport", async () => {
		const { harness, old, unrelated } = await setup(true);
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(old.constructed).toBe(0);
		expect(unrelated.constructed).toBe(0);
		expect(harness.session.getCallableToolNames()).toEqual([]);
	});
});
