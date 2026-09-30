import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	isJsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	type McpFetch,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import {
	isMcpServerRegistrationCurrent,
	isSameMcpServerRegistration,
	type McpServerConfig,
	McpServerRegistry,
} from "../../src/core/mcp-servers.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

/** Actual transport/client with an offline fetch boundary, never a socket or real provider. */
function endpoint(label: string, holdDiscovery = false, holdDelete = false) {
	const listed = Promise.withResolvers<void>();
	const releaseList = Promise.withResolvers<void>();
	const deleting = Promise.withResolvers<void>();
	const releaseDelete = Promise.withResolvers<void>();
	const methods: string[] = [];
	let constructed = 0;
	let deleted = 0;
	let closed = false;
	const fetch: McpFetch = async (_url, init) => {
		if (init?.method === "DELETE") {
			deleting.resolve();
			if (holdDelete) await releaseDelete.promise;
			deleted++;
			return new Response(null, { status: 204 });
		}
		if (init?.method === "GET") return new Response(null, { status: 405 });
		const message: unknown = JSON.parse(String(init?.body));
		if (!isJsonRpcRequest(message)) return new Response(null, { status: 202 });
		methods.push(message.method);
		let result: unknown;
		switch (message.method) {
			case "initialize":
				result = {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {}, resources: {} },
					serverInfo: { name: label, version: "1" },
				};
				break;
			case "tools/list": {
				listed.resolve();
				const signal = init?.signal;
				const onAbort = () => releaseList.resolve();
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					if (holdDiscovery) await releaseList.promise;
					signal?.throwIfAborted();
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
				result = {
					tools: ["echo", "second"].map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
				};
				break;
			}
			case "resources/list":
				result = { resources: [{ name: "doc", uri: "docs://doc" }] };
				break;
			case "resources/templates/list":
				result = { resourceTemplates: [] };
				break;
			case "resources/read":
				result = { contents: [{ uri: "docs://doc", text: label }] };
				break;
			default:
				result = { content: [{ type: "text", text: label }] };
		}
		return Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "mcp-session-id": label } });
	};
	return {
		methods,
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
		get closed() {
			return closed;
		},
		transport: () => {
			constructed++;
			const transport = new StreamableHttpTransport({ url: "http://offline.invalid", fetch });
			const close = transport.close.bind(transport);
			transport.close = async () => {
				await close();
				closed = true;
			};
			return transport;
		},
	};
}

const config = (enabled = true): McpServerConfig => ({
	url: "http://offline.invalid",
	headers: { Authorization: "fake-test-only" },
	exposure: "direct",
	enabled,
});

// smarty-dev#2241 F13 P1: authority must retire at core mutation, before serial async receivers.
describe("MCP synchronous registration lifetime fence", () => {
	const cleanups: (() => Promise<void>)[] = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function setup(
		options: {
			seed?: boolean;
			holdDiscovery?: boolean;
			holdDelete?: boolean;
			retireInFactory?: boolean;
			retireOnPublication?: boolean;
			holdUnrelatedDiscovery?: boolean;
			startupWaitMs?: number;
		} = {},
	) {
		const old = endpoint("old", options.holdDiscovery, options.holdDelete);
		const replacement = endpoint("replacement");
		const unrelated = endpoint("unrelated", options.holdUnrelatedDiscovery);
		const gate = Promise.withResolvers<void>();
		const observed = Promise.withResolvers<void>();
		let blocked = false;
		let apiA: ExtensionAPI | undefined;
		let apiB: ExtensionAPI | undefined;
		const constructedSources: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: options.retireOnPublication ? ["publication_observer"] : [],
			extensionFactories: [
				{
					path: "observer.ts",
					factory: (pi) => {
						if (options.retireOnPublication) {
							pi.registerTool({
								name: "publication_observer",
								label: "publication observer",
								description: "Offline registry callback probe",
								parameters: Type.Object({}),
								execute: async () => ({ content: [], details: {} }),
								prepareLoadout: (loadout) => {
									if (!blocked && loadout.registered.some((tool) => tool.name === "mcp__pending__echo")) {
										blocked = true;
										apiA?.unregisterMcpServer("pending");
									}
									return undefined;
								},
							});
						}
						pi.on("mcp_servers_change", async () => {
							if (!blocked) return;
							observed.resolve();
							await gate.promise;
						});
					},
				},
				{
					path: "owner-a.ts",
					factory: (pi) => {
						apiA = pi;
						if (options.seed) pi.registerMcpServer("pending", config());
					},
				},
				{
					path: "owner-b.ts",
					factory: (pi) => {
						apiB = pi;
						pi.registerMcpServer("other", config());
					},
				},
				createMcpExtension({
					loadConfig: () => ({ servers: [], errors: [] }),
					startupWaitMs: options.startupWaitMs,
					credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
					createTransport: (entry) => {
						constructedSources.push(entry.source);
						const transport = (
							entry.name === "other" ? unrelated : entry.source === "owner-a.ts" ? old : replacement
						).transport();
						if (entry.name === "pending" && options.retireInFactory) {
							blocked = true;
							apiA?.unregisterMcpServer("pending");
						}
						return transport;
					},
				}),
			],
		});
		cleanups.push(async () => {
			blocked = false;
			gate.resolve();
			old.releaseList();
			unrelated.releaseList();
			old.releaseDelete();
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		});
		await harness.session.bindExtensions({});
		if (!apiA || !apiB) throw new Error("Registration APIs not loaded");
		return {
			harness,
			a: apiA,
			b: apiB,
			old,
			replacement,
			unrelated,
			constructedSources,
			block: () => {
				blocked = true;
			},
			observed: observed.promise,
			releaseObserver: () => {
				blocked = false;
				gate.resolve();
			},
		};
	}

	async function prompt(harness: Harness, tool?: string) {
		harness.setResponses(
			tool
				? [fauxAssistantMessage([fauxToolCall(tool, {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")]
				: [fauxAssistantMessage("ready")],
		);
		await harness.session.prompt("offline registry probe");
		return tool ? getToolResult(harness, tool) : undefined;
	}

	function captured(harness: Harness, name = "mcp__pending__echo"): ToolDefinition {
		const definition = harness.session.extensionRunner.getToolDefinition(name);
		if (!definition) throw new Error(`Missing captured tool ${name}`);
		return definition;
	}

	function execute(harness: Harness, definition: ToolDefinition, args: Record<string, unknown> = {}) {
		return definition.execute(
			"captured",
			args,
			undefined,
			undefined,
			harness.session.extensionRunner.createToolContext("captured", undefined),
		);
	}

	// smarty-dev#2241: independent startup can outlast the first prompt's bounded wait.
	it("joins unrelated public readiness independently of a held registry observer", async () => {
		const fixture = await setup({ seed: true, holdUnrelatedDiscovery: true, startupWaitMs: 0 });
		fixture.block();
		fixture.a.unregisterMcpServer("pending");
		await fixture.observed;
		await fixture.unrelated.listed;
		try {
			expect(getMessageText(await prompt(fixture.harness, "mcp__other__echo"))).toBe(
				"Tool mcp__other__echo not found. No tools are available in this session.",
			);
			expect(fixture.unrelated.methods).not.toContain("tools/call");
		} finally {
			fixture.unrelated.releaseList();
			// Public startup completion does not wait for the held registry-change observer.
			await fixture.harness.session.prompt("/mcp");
		}
		expect(fixture.harness.session.getActiveToolNames()).toContain("mcp__other__echo");
		expect(getMessageText(await prompt(fixture.harness, "mcp__other__echo"))).toBe("unrelated");
		expect(fixture.unrelated.methods.filter((method) => method === "tools/call")).toHaveLength(1);
		expect(fixture.unrelated.constructed).toBe(1);
		expect(fixture.unrelated.deleted).toBe(0);
		expect({ constructed: fixture.old.constructed, methods: fixture.old.methods }).toEqual({
			constructed: 0,
			methods: [],
		});
	});

	it.each(["unregister", "replace", "disable"] as const)(
		"does not construct a seeded server after %s while an earlier observer holds the receiver",
		async (action) => {
			const fixture = await setup({ seed: true });
			fixture.block();
			if (action === "unregister") fixture.a.unregisterMcpServer("pending");
			else fixture.a.registerMcpServer("pending", config(action !== "disable"));
			await fixture.observed;
			// The first prompt has a bounded wait, not a readiness guarantee. Public /mcp
			// joins startup independently of the held change receiver before healthy calls.
			await prompt(fixture.harness);
			await fixture.harness.session.prompt("/mcp");
			expect({ constructed: fixture.old.constructed, methods: fixture.old.methods }).toEqual({
				constructed: 0,
				methods: [],
			});
			expect(fixture.harness.session.getActiveToolNames()).not.toContain("mcp__pending__echo");
			expect(getMessageText(await prompt(fixture.harness, "mcp__other__echo"))).toBe("unrelated");
			fixture.releaseObserver();
			if (action === "replace") {
				await vi.waitFor(() => expect(fixture.old.constructed).toBe(1));
				expect(getMessageText(await prompt(fixture.harness, "mcp__pending__echo"))).toBe("old");
			} else {
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(fixture.old.constructed).toBe(0);
			}
		},
	);

	it.each(["tool", "resource"] as const)("rejects a previously published captured %s immediately", async (kind) => {
		const fixture = await setup({ seed: true });
		await prompt(fixture.harness);
		const definition = captured(fixture.harness, kind === "tool" ? "mcp__pending__echo" : "read_mcp_resource");
		fixture.block();
		fixture.a.unregisterMcpServer("pending");
		await fixture.observed;
		const result = await execute(
			fixture.harness,
			definition,
			kind === "tool" ? {} : { server: "pending", uri: "docs://doc" },
		).then(
			() => "unexpected success",
			(error: unknown) => error,
		);
		expect({
			rejected: result instanceof Error,
			methods: fixture.old.methods.filter((method) => /call|read/.test(method)),
		}).toEqual({
			rejected: true,
			methods: [],
		});
		expect(getMessageText(await prompt(fixture.harness, "mcp__other__echo"))).toBe("unrelated");
	});

	it("retires a same-config lifetime and uses the new source when another owner claims the name in one turn", async () => {
		const fixture = await setup({ seed: true });
		await prompt(fixture.harness);
		const definition = captured(fixture.harness);
		fixture.block();
		fixture.a.unregisterMcpServer("pending");
		fixture.b.registerMcpServer("pending", config());
		await fixture.observed;
		const registration = fixture.b.getMcpServers().find((server) => server.name === "pending");
		expect(registration?.extensionPath).toBe("owner-b.ts");
		await expect(execute(fixture.harness, definition)).rejects.toThrow(/no longer enabled/);
		fixture.releaseObserver();
		await vi.waitFor(() => expect(fixture.replacement.constructed).toBe(1));
		await vi.waitFor(() => expect(fixture.old.deleted).toBe(1));
		expect(fixture.constructedSources.filter((source) => source === "owner-a.ts")).toEqual(["owner-a.ts"]);
		await expect(execute(fixture.harness, definition)).rejects.toThrow(/no longer enabled/);
		expect(getMessageText(await prompt(fixture.harness, "mcp__pending__echo"))).toBe("replacement");
	});

	it("does not publish completed discovery after unregister while the receiver is blocked", async () => {
		const fixture = await setup({ seed: true, holdDiscovery: true });
		await fixture.old.listed;
		fixture.block();
		fixture.a.unregisterMcpServer("pending");
		await fixture.observed;
		fixture.old.releaseList();
		await prompt(fixture.harness);
		expect(fixture.old.constructed).toBe(1);
		expect(fixture.old.deleted).toBe(1);
		expect(fixture.harness.session.getActiveToolNames()).not.toContain("mcp__pending__echo");
		expect(getMessageText(await prompt(fixture.harness, "mcp__other__echo"))).toBe("unrelated");
	});

	it("closes a transport constructed by a reentrant factory without starting it", async () => {
		const fixture = await setup({ seed: true, retireInFactory: true });
		await prompt(fixture.harness);
		await fixture.observed;
		expect(fixture.old.constructed).toBe(1);
		expect(fixture.old.methods).toEqual([]);
		expect(fixture.old.closed).toBe(true);
		expect(fixture.harness.session.getActiveToolNames()).not.toContain("mcp__pending__echo");
	});

	it("rechecks authority between publications when a loadout callback unregisters the server", async () => {
		const fixture = await setup({ seed: true, retireOnPublication: true });
		await prompt(fixture.harness);
		await fixture.observed;
		expect(fixture.harness.session.extensionRunner.getToolDefinition("mcp__pending__second")).toBeUndefined();
		expect(fixture.old.closed).toBe(true);
		await expect(execute(fixture.harness, captured(fixture.harness))).rejects.toThrow(/no longer enabled/);
		fixture.releaseObserver();
		await vi.waitFor(() =>
			expect(fixture.harness.session.getCallableToolNames()).not.toContain("mcp__pending__echo"),
		);
	});

	it("fences dispatch when mutation runs between the captured executor and the connection's await", async () => {
		const fixture = await setup({ seed: true });
		await prompt(fixture.harness);
		fixture.block();
		const running = execute(fixture.harness, captured(fixture.harness)).catch((error: unknown) => error);
		// First continuation acquires the connection; this mutation precedes withClient's continuation.
		queueMicrotask(() => fixture.a.unregisterMcpServer("pending"));
		await fixture.observed;
		expect(await running).toBeInstanceOf(Error);
		expect(fixture.old.methods).not.toContain("tools/call");
	});

	it.each([false, true])("replaces identical config with the same owner (blocked observer: %s)", async (blocked) => {
		const fixture = await setup({ seed: true });
		await prompt(fixture.harness);
		const oldDefinition = captured(fixture.harness);
		if (blocked) fixture.block();
		fixture.a.registerMcpServer("pending", config());
		if (blocked) await fixture.observed;
		await expect(execute(fixture.harness, oldDefinition)).rejects.toThrow(/no longer enabled/);
		fixture.releaseObserver();
		await vi.waitFor(() => expect(fixture.old.constructed).toBe(2));
		await vi.waitFor(() => expect(fixture.old.deleted).toBe(1));
		expect(getMessageText(await prompt(fixture.harness, "mcp__pending__echo"))).toBe("old");
	});

	it("drains pending old discovery through shutdown even while the registry receiver remains blocked", async () => {
		const fixture = await setup({ seed: true, holdDiscovery: true, holdDelete: true });
		await fixture.old.listed;
		fixture.block();
		fixture.a.unregisterMcpServer("pending");
		await fixture.observed;
		let finished = false;
		const shutdown = fixture.harness.session.extensionRunner
			.emit({ type: "session_shutdown", reason: "quit" })
			.then(() => {
				finished = true;
			});
		await fixture.old.deleting;
		expect(finished).toBe(false);
		expect(fixture.old.deleted).toBe(0);
		fixture.old.releaseDelete();
		await shutdown;
		expect(finished).toBe(true);
		expect(fixture.old.deleted).toBe(1);
		expect(fixture.harness.session.getCallableToolNames()).not.toContain("mcp__pending__echo");
	});

	it("ordinary unregister retires healthy connections and leaves unrelated ownership usable", async () => {
		const fixture = await setup({ seed: true });
		await prompt(fixture.harness);
		expect(getMessageText(await prompt(fixture.harness, "mcp__pending__echo"))).toBe("old");
		fixture.a.unregisterMcpServer("other");
		fixture.a.unregisterMcpServer("pending");
		await vi.waitFor(() => expect(fixture.old.deleted).toBe(1));
		expect(getMessageText(await prompt(fixture.harness, "mcp__other__echo"))).toBe("unrelated");
		expect(fixture.unrelated.deleted).toBe(0);
	});

	it("keeps lifetime identity across list copies without adding public schema properties", () => {
		const registry = new McpServerRegistry();
		const input = { name: "server", config: config(), extensionPath: "owner-a.ts" };
		registry.register(input);
		const first = registry.list()[0];
		const second = registry.list()[0];
		expect(first).not.toBe(second);
		expect(first.config).not.toBe(second.config);
		expect(Object.keys(first).sort()).toEqual(["config", "extensionPath", "name"]);
		expect(isSameMcpServerRegistration(first, second)).toBe(true);
		expect(isMcpServerRegistrationCurrent(first)).toBe(true);
		expect(isMcpServerRegistrationCurrent(structuredClone(first))).toBe(false);
		registry.unregister("server", "wrong-owner.ts");
		expect(isMcpServerRegistrationCurrent(first)).toBe(true);
		const observations: boolean[] = [];
		registry.setChangeListener(() => observations.push(isMcpServerRegistrationCurrent(first)));
		registry.register(input);
		const third = registry.list()[0];
		expect(observations).toEqual([false]);
		expect(isSameMcpServerRegistration(first, third)).toBe(false);
		expect(isMcpServerRegistrationCurrent(third)).toBe(true);
		registry.unregister("server", "owner-a.ts");
		expect(isMcpServerRegistrationCurrent(third)).toBe(false);
	});
});
