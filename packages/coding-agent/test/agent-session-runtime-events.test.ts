import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntime,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	// Shared identity fence only: a real unowned session/faux provider, never a fake native owner.
	it.each(["preflight", "before_agent_start"] as const)(
		"refuses agent replacement in %s before dispatch",
		async (stage) => {
			let swap = () => {};
			const { runtimeHost } = await createRuntimeHost((pi) => {
				pi.on("before_agent_start", async () => {
					await Promise.resolve();
					if (stage === "before_agent_start") swap();
				});
			});
			const session = runtimeHost.session;
			const original = session.agent;
			const replacementPrompt = vi.fn(async () => {});
			const replacementContinue = vi.fn(async () => {});
			const replacement = Object.create(original);
			Object.assign(replacement, { prompt: replacementPrompt, continue: replacementContinue });
			swap = () => {
				Object.defineProperty(session, "agent", { value: replacement, configurable: true });
			};
			try {
				await expect(
					session.prompt("refuse this swap", {
						preflightResult: (accepted) => {
							if (accepted && stage === "preflight") swap();
						},
					}),
				).rejects.toThrow("OWNER_RUNTIME_AGENT_CHANGED");
				expect(replacementPrompt).not.toHaveBeenCalled();
				expect(replacementContinue).not.toHaveBeenCalled();
			} finally {
				Object.defineProperty(session, "agent", { value: original, configurable: true });
			}
		},
	);

	it.each(["enrollment", "continuation", "abort", "dispose"] as const)(
		"retains the original agent across %s callbacks",
		async (stage) => {
			const { runtimeHost } = await createRuntimeHost(() => {});
			const session = runtimeHost.session;
			const original = session.agent;
			const replacement = Object.create(original);
			const prompt = vi.fn(async () => {}),
				continuation = vi.fn(async () => {}),
				abort = vi.fn();
			Object.assign(replacement, { prompt, continue: continuation, abort });
			const swap = () => {
				Object.defineProperty(session, "agent", { value: replacement, configurable: true });
			};
			const originalAbort = vi.spyOn(original, "abort");
			try {
				if (stage === "enrollment") {
					const run = Reflect.get(session, "_runAgentPrompt") as (
						messages: [],
						token: undefined,
						enroll: (run: () => Promise<void>) => Promise<void>,
					) => Promise<void>;
					await expect(
						run.call(session, [], undefined, async (dispatch) => {
							swap();
							await dispatch();
						}),
					).rejects.toThrow("OWNER_RUNTIME_AGENT_CHANGED");
				} else if (stage === "continuation") {
					const post = vi
						.spyOn(session as unknown as { _handlePostAgentRun(): Promise<boolean> }, "_handlePostAgentRun")
						.mockImplementation(async () => {
							swap();
							return true;
						});
					try {
						await expect(session.prompt("original run")).rejects.toThrow("OWNER_RUNTIME_AGENT_CHANGED");
					} finally {
						post.mockRestore();
					}
				} else {
					const hook = vi.spyOn(session, "abortBranchSummary").mockImplementation(swap);
					try {
						if (stage === "abort") await session.abort();
						else session.dispose();
					} finally {
						hook.mockRestore();
					}
					expect(originalAbort).toHaveBeenCalledTimes(1);
				}
				expect(prompt).not.toHaveBeenCalled();
				expect(continuation).not.toHaveBeenCalled();
				expect(abort).not.toHaveBeenCalled();
			} finally {
				Object.defineProperty(session, "agent", { value: original, configurable: true });
				originalAbort.mockRestore();
			}
		},
	);

	it.each(["failed", "aborted"] as const)(
		"TUI does not restore input already retained by real session compaction (%s)",
		async (outcome) => {
			const { runtimeHost } = await createRuntimeHost(() => {});
			const session = runtimeHost.session;
			session.agent.state.messages = [fauxAssistantMessage("previous response")];
			await session.followUp("unrelated session input");
			const input = { text: "original A", mode: "steer" as const };
			const later = { text: "new B", mode: "steer" as const };
			const mode = {
				session,
				compactionQueuedMessages: [input],
				compactionQueueTransfers: 0,
				isExtensionCommand: () => false,
				updatePendingMessagesDisplay: vi.fn(),
				showError: vi.fn(),
			};
			const check = vi
				.spyOn(session as unknown as { _checkCompaction(): Promise<string> }, "_checkCompaction")
				.mockImplementation(async () => {
					mode.compactionQueuedMessages.push(later);
					return outcome;
				});
			const dispatch = vi.spyOn(session.agent, "prompt");
			const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
				this: typeof mode,
			) => Promise<void>;
			try {
				await flush.call(mode);
				await vi.waitFor(() => expect(mode.compactionQueueTransfers).toBe(0));
				expect(mode.showError).toHaveBeenCalledTimes(1);
				expect(mode.compactionQueuedMessages).toEqual([later]);
				expect(session.getSteeringMessages()).toEqual([input.text]);
				expect(session.getFollowUpMessages()).toEqual(["unrelated session input"]);
				expect(dispatch).not.toHaveBeenCalled();
			} finally {
				check.mockRestore();
				dispatch.mockRestore();
			}
		},
	);

	it("TUI does not restore a dispatched input after a later original run failure", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const session = runtimeHost.session;
		const cause = new Error("original post-run failure");
		const mode = {
			session,
			compactionQueuedMessages: [{ text: "dispatched A", mode: "steer" as const }],
			compactionQueueTransfers: 0,
			isExtensionCommand: () => false,
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};
		const post = vi
			.spyOn(session as unknown as { _handlePostAgentRun(): Promise<boolean> }, "_handlePostAgentRun")
			.mockRejectedValue(cause);
		const prompt = vi.spyOn(session, "prompt");
		const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof mode,
		) => Promise<void>;
		try {
			await flush.call(mode);
			mode.compactionQueuedMessages.push({ text: "new B", mode: "steer" });
			await vi.waitFor(() => expect(mode.compactionQueueTransfers).toBe(0));
			expect(mode.compactionQueuedMessages.map((message) => message.text)).toEqual(["new B"]);
			expect(
				session.messages.some(
					(message) => message.role === "user" && JSON.stringify(message).includes("dispatched A"),
				),
			).toBe(true);
			await expect(prompt.mock.results[0].value).rejects.toBe(cause);
			expect(mode.showError).toHaveBeenCalledWith(expect.stringContaining(cause.message));
		} finally {
			post.mockRestore();
			prompt.mockRestore();
		}
	});

	it("restores input once when an original run starts during preflight", async () => {
		let startOverlap = () => {};
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("before_agent_start", async () => {
				await Promise.resolve();
				startOverlap();
			});
		});
		const session = runtimeHost.session;
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const unsubscribe = session.agent.subscribe(async (event) => {
			if (event.type === "agent_start") await blocked;
		});
		let overlap: Promise<void> | undefined;
		const input = { text: "refused A", mode: "steer" as const };
		const later = { text: "new B", mode: "steer" as const };
		const mode = {
			session,
			compactionQueuedMessages: [input],
			compactionQueueTransfers: 0,
			isExtensionCommand: () => false,
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};
		startOverlap = () => {
			mode.compactionQueuedMessages.push(later);
			overlap = session.agent.prompt("original overlapping run");
			expect(session.agent.signal).toBeDefined();
		};
		const prompt = vi.spyOn(session, "prompt");
		const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof mode,
		) => Promise<void>;
		try {
			await flush.call(mode);
			await vi.waitFor(() => expect(mode.compactionQueueTransfers).toBe(0));
			expect(mode.compactionQueuedMessages).toEqual([input, later]);
			expect(session.getSteeringMessages()).toEqual([]);
			expect(session.messages.some((message) => JSON.stringify(message).includes(input.text))).toBe(false);
			await expect(prompt.mock.results[0].value).rejects.toThrow("OWNER_AGENT_BUSY_BEFORE_TRANSFER");
		} finally {
			release();
			await overlap;
			unsubscribe();
			prompt.mockRestore();
		}
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
