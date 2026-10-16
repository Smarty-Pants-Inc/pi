import { fauxAssistantMessage, type ImageContent } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { type ReceivedInput, receiveInput } from "../../src/core/received-input.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

// pi#132 / smarty-dev#3048: shared Agent identity and transfer checks, without the omitted owner runtime.
describe("generic original Agent identity and input transfer", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});
	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const h = await createHarness({ extensionFactories: [extensionFactory] });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		await h.session.bindExtensions({});
		return { runtimeHost: { session: h.session } };
	}

	// Shared identity fence only: a real unowned session/faux provider, never a fake native owner.
	it.each(["transfer", "before_agent_start"] as const)(
		"refuses a replacement agent in %s without dispatching to it",
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
						onInputTransferred: () => {
							if (stage === "transfer") swap();
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

	it.each(["continuation", "abort", "dispose"] as const)(
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
				if (stage === "continuation") {
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
			const input = { input: receiveInput("original A"), mode: "steer" as const };
			const later = { input: receiveInput("new B"), mode: "steer" as const };
			const mode = {
				session,
				compactionQueuedMessages: [input],
				compactionQueueTransfers: 0,
				compactionQueueWork: new Set<Promise<void>>(),
				recoveredImages: new Map<string, ImageContent>(),
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
			Object.setPrototypeOf(mode, InteractiveMode.prototype);
			const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
				this: typeof mode,
			) => Promise<void>;
			try {
				await flush.call(mode);
				await vi.waitFor(() => expect(mode.compactionQueueTransfers).toBe(0));
				expect(mode.showError).toHaveBeenCalledTimes(1);
				expect(mode.compactionQueuedMessages).toEqual([later]);
				expect(session.getSteeringMessages()).toEqual([input.input.text]);
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
			compactionQueuedMessages: [{ input: receiveInput("dispatched A"), mode: "steer" as const }],
			compactionQueueTransfers: 0,
			compactionQueueWork: new Set<Promise<void>>(),
			recoveredImages: new Map<string, ImageContent>(),
			isExtensionCommand: () => false,
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};
		const post = vi
			.spyOn(session as unknown as { _handlePostAgentRun(): Promise<boolean> }, "_handlePostAgentRun")
			.mockRejectedValue(cause);
		const prompt = vi.spyOn(
			session as unknown as { _promptReceived(input: ReceivedInput): Promise<void> },
			"_promptReceived",
		);
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof mode,
		) => Promise<void>;
		try {
			await flush.call(mode);
			mode.compactionQueuedMessages.push({ input: receiveInput("new B"), mode: "steer" });
			await vi.waitFor(() => expect(mode.compactionQueueTransfers).toBe(0));
			expect(mode.compactionQueuedMessages.map((message) => message.input.text)).toEqual(["new B"]);
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
		const input = { input: receiveInput("refused A"), mode: "steer" as const };
		const later = { input: receiveInput("new B"), mode: "steer" as const };
		const mode = {
			session,
			compactionQueuedMessages: [input],
			compactionQueueTransfers: 0,
			compactionQueueWork: new Set<Promise<void>>(),
			recoveredImages: new Map<string, ImageContent>(),
			isExtensionCommand: () => false,
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};
		startOverlap = () => {
			mode.compactionQueuedMessages.push(later);
			overlap = session.agent.prompt("original overlapping run");
			expect(session.agent.signal).toBeDefined();
		};
		const prompt = vi.spyOn(
			session as unknown as { _promptReceived(input: ReceivedInput): Promise<void> },
			"_promptReceived",
		);
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof mode,
		) => Promise<void>;
		try {
			await flush.call(mode);
			await vi.waitFor(() => expect(mode.compactionQueueTransfers).toBe(0));
			expect(mode.compactionQueuedMessages).toEqual([input, later]);
			expect(session.getSteeringMessages()).toEqual([]);
			expect(session.messages.some((message) => JSON.stringify(message).includes(input.input.text))).toBe(false);
			await expect(prompt.mock.results[0].value).rejects.toThrow("OWNER_AGENT_BUSY_BEFORE_TRANSFER");
		} finally {
			release();
			await overlap;
			unsubscribe();
			prompt.mockRestore();
		}
	});
});
