import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../../src/core/agent-session-services.ts";
import type { BoundaryContextPreview, ExtensionAPI, ExtensionContext } from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function user(content: string) {
	return { role: "user" as const, content, timestamp: 1 };
}

async function boundedSettlement(operation: Promise<unknown>): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation.then(() => true),
			new Promise<false>((resolve) => {
				timeout = setTimeout(() => resolve(false), 1600);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

describe("PR #131 round-3 extension boundaries", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const h of harnesses.splice(0)) {
			h.session.dispose();
			h.faux.unregister();
		}
	});
	async function harness(options: Parameters<typeof createHarness>[0] = {}) {
		let extensionsResult = await createTestExtensionsResult(options.extensionFactories ?? []);
		const loader = createTestResourceLoader({ extensionsResult });
		loader.getExtensions = () => extensionsResult;
		loader.reload = async () => {
			extensionsResult = await createTestExtensionsResult([]);
		};
		const h = await createHarness({ ...options, extensionFactories: undefined, resourceLoader: loader });
		harnesses.push(h);
		return h;
	}
	function services(h: Harness): AgentSessionServices {
		return {
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.session.modelRuntime,
			settingsManager: h.settingsManager,
			resourceLoader: createTestResourceLoader(),
			diagnostics: [],
		};
	}

	// PR #131 F14: reload and every replacement must retire a non-cooperative shutdown handler.
	it.each(["reload", "new", "resume", "fork", "import"] as const)(
		"bounds %s cleanup and refuses late retired writes",
		async (action) => {
			const held = gate();
			const entered = gate();
			let lateError: unknown;
			let oldContext: ExtensionContext | undefined;
			let oldAPI: ExtensionAPI | undefined;
			let laterHandlers = 0;
			const h = await harness({
				persistSession: true,
				extensionFactories: [
					(pi) => {
						oldAPI = pi;
						pi.on("session_shutdown", async (_event, ctx) => {
							oldContext = ctx;
							entered.release();
							await held.promise;
							try {
								pi.appendEntry("late-retired-write", true);
							} catch (error) {
								lateError = error;
							}
						});
						pi.on("session_shutdown", () => {
							laterHandlers++;
						});
					},
				],
			});
			const forkId = h.sessionManager.appendMessage(user("saved"));
			h.sessionManager.appendMessage({
				...fauxAssistantMessage("saved answer"),
				provider: h.getModel().provider,
				model: h.getModel().id,
			});
			const target = SessionManager.create(h.tempDir, h.tempDir);
			target.appendMessage(user("target"));
			target.appendMessage({
				...fauxAssistantMessage("target answer"),
				provider: h.getModel().provider,
				model: h.getModel().id,
			});
			const runtime = new AgentSessionRuntime(h.session, services(h), async (options) => {
				const replacement = await harness({ sessionManager: options.sessionManager });
				return {
					session: replacement.session,
					services: services(replacement),
					diagnostics: [],
					extensionsResult: await createTestExtensionsResult([]),
				};
			});
			const operation =
				action === "reload"
					? h.session.reload()
					: action === "new"
						? runtime.newSession()
						: action === "resume"
							? runtime.switchSession(target.getSessionFile()!)
							: action === "fork"
								? runtime.fork(forkId, { position: "at" })
								: runtime.importFromJsonl(target.getSessionFile()!);
			void operation.catch(() => {});
			try {
				await entered.promise;
				expect(await boundedSettlement(operation), "outgoing runtime remains blocked by shutdown").toBe(true);
				expect(laterHandlers).toBe(0);
				expect(() => oldContext!.hasPendingMessages()).toThrow(/stale|shutdown/i);
				expect(() => oldAPI!.appendEntry("retired", true)).toThrow(/stale|shutdown/i);
			} finally {
				held.release();
				await operation;
			}
			expect(lateError).toBeInstanceOf(Error);
			expect(
				h.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === "late-retired-write"),
			).toBe(false);
		},
	);

	// PR #131 F14 control: cooperative cleanup still has effect before invalidation, including terminal quit.
	it.each(["reload", "new", "quit"] as const)("permits cooperative %s cleanup", async (action) => {
		let completed = false;
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", async () => {
						await Promise.resolve();
						pi.appendEntry("cleanup", true);
						completed = true;
					});
				},
			],
		});
		const runtime = new AgentSessionRuntime(h.session, services(h), async (options) => {
			const replacement = await harness({ sessionManager: options.sessionManager });
			return {
				session: replacement.session,
				services: services(replacement),
				diagnostics: [],
				extensionsResult: await createTestExtensionsResult([]),
			};
		});
		await (action === "reload" ? h.session.reload() : action === "new" ? runtime.newSession() : runtime.dispose());
		expect(completed).toBe(true);
		expect(
			h.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "cleanup"),
		).toBe(true);
	});

	// PR #131 F14 control: a failing timeout observer cannot prevent definitive invalidation/replacement.
	it("retires unfinished cleanup even when the diagnostic observer throws and observes late rejection", async () => {
		const entered = gate();
		const held = gate();
		const finished = gate();
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", async () => {
						entered.release();
						await held.promise;
						finished.release();
						throw new Error("late native shutdown rejection");
					});
				},
			],
		});
		h.session.extensionRunner.onError(() => {
			throw new Error("fallible timeout observer");
		});
		const operation = h.session.reload();
		void operation.catch(() => {});
		try {
			await entered.promise;
			expect(await boundedSettlement(operation)).toBe(true);
		} finally {
			held.release();
			await operation.catch(() => {});
			await finished.promise;
		}
	});

	// PR #131 F14 control: terminal quit keeps its existing bounded failure/disposal contract.
	it("bounds terminal quit, disposes the runner, and observes unfinished native rejection", async () => {
		const entered = gate();
		const held = gate();
		const finished = gate();
		let ctx: ExtensionContext | undefined;
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", async (_event, context) => {
						ctx = context;
						entered.release();
						await held.promise;
						finished.release();
						throw new Error("late terminal cleanup rejection");
					});
				},
			],
		});
		const runtime = new AgentSessionRuntime(h.session, services(h), async () => {
			throw new Error("unexpected replacement");
		});
		const operation = runtime.dispose();
		void operation.catch(() => {});
		try {
			await entered.promise;
			await expect(operation).rejects.toThrow(/shutdown dispatch exceeded/i);
			expect(() => ctx!.hasPendingMessages()).toThrow(/stale/i);
		} finally {
			held.release();
			await operation.catch(() => {});
			await finished.promise;
		}
	});

	// PR #131 controls: the round-2 production cuts must remain early and unconditional.
	it("preserves Codemode/MCP factory and extension registration refusal", async () => {
		let api: ExtensionAPI | undefined;
		await harness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		expect(() => createCodemodeExtension()(api!)).toThrow(/CODEMODE_SECURITY_REVIEW_REQUIRED/);
		expect(() => createMcpExtension()(api!)).toThrow(/MCP_SECURITY_REVIEW_REQUIRED/);
		expect(() => api!.registerMcpServer("never-admit", { type: "stdio", command: "never-spawn" })).toThrow(
			/MCP_SECURITY_REVIEW_REQUIRED/,
		);
	});

	// PR #131 F17 controls: retain shared no-op previews and detach each handler's draft proposals.
	it("shares one stable preview between no-op observers without sharing writable drafts", async () => {
		const contexts: BoundaryContextPreview[] = [];
		let retained: { type: "custom"; customType: string; data: { value: number } } | undefined;
		let builds = 0;
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => ({
						entries: [{ type: "custom", customType: "kept", data: { value: 1 } }],
					}));
					pi.on("agent_before_settle", (event) => {
						contexts.push(event.context);
						retained = event.entries[0] as typeof retained;
					});
					pi.on("agent_before_settle", (event) => {
						contexts.push(event.context);
					});
				},
			],
		});
		const result = await h.session.extensionRunner.emitBoundary(
			{ type: "agent_before_settle", outcome: "completed" },
			() => {
				builds++;
				return {
					contextEntries: [],
					contextMessages: [],
					llmMessages: [],
					pendingMessages: [],
					canContinue: false,
				};
			},
		);
		expect(builds).toBe(2);
		expect(contexts[0]).toBe(contexts[1]);
		retained!.data.value = 99;
		expect(result.entries).toMatchObject([{ data: { value: 1 } }]);
	});

	// PR #131 F17: continual accepted mutation must be refused without admitting a stale handler.
	it("boundedly refuses a preview that changes during every build", async () => {
		let handlers = 0;
		let builds = 0;
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => {
						handlers++;
					});
				},
			],
		});
		const operation = h.session.extensionRunner.emitBoundary(
			{ type: "agent_before_settle", outcome: "completed" },
			async () => {
				builds++;
				const contextMessages = h.sessionManager.buildSessionContext().messages;
				await Promise.resolve();
				h.sessionManager.appendMessage(user(`accepted-${builds}`));
				return { contextEntries: [], contextMessages, llmMessages: [], pendingMessages: [], canContinue: false };
			},
		);
		await expect(operation).rejects.toThrow(/context changed.*dispatch refused/i);
		expect(builds).toBe(8);
		expect(handlers).toBe(0);
	});

	// PR #131 F17: a preview captured before an awaited build must not be admitted after accepted input changes.
	it.each(["initial", "replacement"] as const)(
		"reconciles suspended %s builds before the next handler",
		async (phase) => {
			const held = gate();
			const entered = gate();
			let calls = 0;
			let observed: BoundaryContextPreview | undefined;
			const pending: AgentMessage[] = [];
			const h = await harness({
				extensionFactories: [
					(pi) => {
						if (phase === "replacement")
							pi.on("agent_before_settle", () => ({
								entries: [{ type: "custom", customType: "draft", data: { retained: true } }],
							}));
						pi.on("agent_before_settle", (event) => {
							observed = event.context;
						});
					},
				],
			});
			const build = async (): Promise<BoundaryContextPreview> => {
				const preview: BoundaryContextPreview = {
					contextEntries: [],
					contextMessages: h.sessionManager.buildSessionContext().messages,
					llmMessages: [],
					pendingMessages: pending.slice(),
					canContinue: pending.length > 0,
				};
				calls++;
				if (calls === (phase === "initial" ? 1 : 2)) {
					entered.release();
					await held.promise;
				}
				return preview;
			};
			const operation = h.session.extensionRunner.emitBoundary(
				{ type: "agent_before_settle", outcome: "completed" },
				build,
				() => pending,
			);
			try {
				await entered.promise;
				h.sessionManager.appendMessage(user("accepted append"));
				pending.push(user("accepted queue"));
			} finally {
				held.release();
			}
			const result = await operation;
			expect(observed?.contextMessages).toContainEqual(user("accepted append"));
			expect(observed?.pendingMessages).toContainEqual(user("accepted queue"));
			expect(observed?.canContinue).toBe(true);
			expect(result.valid).toBe(true);
			expect(calls).toBe(phase === "initial" ? 2 : 3);
		},
	);
});
