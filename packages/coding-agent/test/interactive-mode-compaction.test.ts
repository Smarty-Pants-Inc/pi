import type { Usage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("InteractiveMode compaction events", () => {
	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
			this: { chatContainer: Container; settingsManager: { getShowCacheMissNotices(): boolean } },
			notice: {
				type: "compaction_cost";
				kind: "compaction" | "branch_summary";
				usage: Usage;
			},
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCompactionCostNotice.call(enabled, { type: "compaction_cost", kind: "compaction", usage });
		addCompactionCostNotice.call(enabled, {
			type: "compaction_cost",
			kind: "branch_summary",
			usage,
		});
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
		expect(output).toContain("Branch summary: 100 tokens billed (~$0.13)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCompactionCostNotice.call(disabled, { type: "compaction_cost", kind: "compaction", usage });
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("renders each compaction cost after its summary", () => {
		const currentUsage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const previousUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "current",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "current summary",
				firstKeptEntryId: "kept",
				tokensBefore: 200,
				usage: currentUsage,
			},
			{
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage: previousUsage,
			},
		];
		const fakeThis = { renderSessionItems: vi.fn() };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(fakeThis, entries);

		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			[
				expect.objectContaining({ role: "compactionSummary", summary: "current summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: currentUsage },
				expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			],
			{},
		);
	});

	test.each([false, true])(
		"renders a successful compaction and flushes its queue (willRetry: %s)",
		async (willRetry) => {
			const usage: Usage = {
				input: 10,
				output: 20,
				cacheRead: 30,
				cacheWrite: 40,
				totalTokens: 100,
				cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
			};
			const latestCompaction: SessionEntry = {
				type: "compaction",
				id: "latest",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 123,
				usage,
			};
			const previousCompaction: SessionEntry = {
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage,
			};
			const fakeThis = {
				isInitialized: true,
				footer: { invalidate: vi.fn() },
				autoCompactionEscapeHandler: undefined as (() => void) | undefined,
				autoCompactionLoader: undefined,
				defaultEditor: {},
				statusContainer: { clear: vi.fn() },
				chatContainer: { clear: vi.fn() },
				sessionManager: { buildContextEntries: vi.fn().mockReturnValue([latestCompaction, previousCompaction]) },
				renderSessionEntries: vi.fn(),
				addMessageToChat: vi.fn(),
				addCompactionCostNotice: vi.fn(),
				showError: vi.fn(),
				showStatus: vi.fn(),
				clearStatusIndicator: vi.fn(),
				flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
				settingsManager: { getShowTerminalProgress: () => false },
				ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			};

			const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
				this: typeof fakeThis,
				event: {
					type: "compaction_end";
					reason: "manual" | "threshold" | "overflow";
					result: { tokensBefore: number; summary: string; usage?: Usage } | undefined;
					aborted: boolean;
					willRetry: boolean;
					errorMessage?: string;
				},
			) => Promise<void>;

			await handleEvent.call(fakeThis, {
				type: "compaction_end",
				reason: willRetry ? "overflow" : "manual",
				result: {
					tokensBefore: 123,
					summary: "summary",
					usage,
				},
				aborted: false,
				willRetry,
			});

			expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
			expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith([previousCompaction]);
			expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
			expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
				expect.objectContaining({
					role: "compactionSummary",
					tokensBefore: 123,
					summary: "summary",
				}),
			);
			expect(fakeThis.addCompactionCostNotice).toHaveBeenCalledWith({
				type: "compaction_cost",
				kind: "compaction",
				usage,
			});
			expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry });
		},
	);

	test.each([
		{ reason: "manual" as const, aborted: false },
		{ reason: "manual" as const, aborted: true },
		{ reason: "threshold" as const, aborted: true },
		{ reason: "overflow" as const, aborted: false },
	])("retains exact queued input after $reason compaction (aborted: $aborted)", async ({ reason, aborted }) => {
		const queued = [
			{ text: "  original steering\n", mode: "steer" },
			{ text: "original follow-up", mode: "followUp" },
		];
		const before = structuredClone(queued);
		initTheme("dark");
		const fakeThis = {
			isInitialized: true,
			chatContainer: new Container(),
			compactionQueuedMessages: queued,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			clearStatusIndicator: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason,
			result: undefined,
			aborted,
			willRetry: false,
			errorMessage: aborted ? undefined : "synthetic compaction failure",
		});

		expect(fakeThis.flushCompactionQueue).not.toHaveBeenCalled();
		expect(fakeThis.compactionQueuedMessages).toBe(queued);
		expect(queued).toEqual(before);
		if (reason === "overflow" && !aborted) {
			expect(stripAnsi(fakeThis.chatContainer.render(120).join("\n"))).toContain("synthetic compaction failure");
		}
	});

	test("updates the working state when the same agent run resumes after compaction", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			activeStatusIndicator: undefined,
			workingVisible: true,
			showWorkingStatusIndicator: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "turn_start" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		fakeThis.workingVisible = false;
		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	test.each([false, true])("keeps detached prompt transfers staged until settlement (reject: %s)", async (reject) => {
		let resolvePrompt!: () => void;
		let rejectPrompt!: (error: Error) => void;
		const prompt = new Promise<void>((resolve, reject) => {
			resolvePrompt = resolve;
			rejectPrompt = reject;
		});
		const queued = [{ text: "original input", mode: "steer" as const }];
		const snapshots: { kind: string; transfers: number; queued: number }[] = [];
		const fakeThis = {
			compactionQueuedMessages: [...queued],
			compactionQueueTransfers: 0,
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockReturnValue(prompt),
				steer: vi.fn(),
				followUp: vi.fn(),
			},
			stagingAudit: (kind: string) =>
				snapshots.push({
					kind,
					transfers: fakeThis.compactionQueueTransfers,
					queued: fakeThis.compactionQueuedMessages.length,
				}),
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};
		const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
		) => Promise<void>;
		await flush.call(fakeThis);
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.compactionQueueTransfers).toBe(1);
		expect(snapshots[0]).toEqual({ kind: "compaction-transfer-start", transfers: 1, queued: 1 });
		const intervening = { text: "newly staged input", mode: "steer" as const };
		fakeThis.compactionQueuedMessages.push(intervening);
		if (reject) rejectPrompt(new Error("preflight failed"));
		else resolvePrompt();
		await vi.waitFor(() => expect(fakeThis.compactionQueueTransfers).toBe(0));
		expect(fakeThis.compactionQueuedMessages).toEqual(reject ? [...queued, intervening] : [intervening]);
		expect(fakeThis.session.clearQueue).not.toHaveBeenCalled();
		expect(fakeThis.showError).toHaveBeenCalledTimes(reject ? 1 : 0);
		if (reject) expect(snapshots).toContainEqual({ kind: "compaction-restored", transfers: 1, queued: 2 });
	});

	test.each([false, true])(
		"partial transfer preserves accepted messages and restores failures in order (prompt fails first: %s)",
		async (promptFirst) => {
			let rejectPrompt!: (cause: Error) => void;
			let rejectTail!: (cause: Error) => void;
			const prompt = new Promise<void>((_, reject) => {
				rejectPrompt = reject;
			});
			const tail = new Promise<void>((_, reject) => {
				rejectTail = reject;
			});
			const batch = [
				{ text: "A", mode: "steer" as const },
				{ text: "accepted", mode: "followUp" as const },
				{ text: "C", mode: "followUp" as const },
			];
			const fakeThis = {
				compactionQueuedMessages: [...batch],
				compactionQueueTransfers: 0,
				session: {
					prompt: vi.fn(() => prompt),
					clearQueue: vi.fn(),
					steer: vi.fn(),
					followUp: vi.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(tail),
				},
				isExtensionCommand: () => false,
				updatePendingMessagesDisplay: vi.fn(),
				showError: vi.fn(),
			};
			const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
				this: typeof fakeThis,
			) => Promise<void>;
			const completion = flush.call(fakeThis);
			await vi.waitFor(() => expect(fakeThis.session.followUp).toHaveBeenCalledTimes(2));
			const intervening = { text: "B", mode: "steer" as const };
			fakeThis.compactionQueuedMessages.push(intervening);
			if (promptFirst) {
				rejectPrompt(new Error("first"));
				await vi.waitFor(() => expect(fakeThis.showError).toHaveBeenCalledTimes(1));
				rejectTail(new Error("tail"));
			} else {
				rejectTail(new Error("tail"));
				await completion;
				expect(fakeThis.compactionQueuedMessages).toEqual([batch[2], intervening]);
				rejectPrompt(new Error("first"));
			}
			await completion;
			await vi.waitFor(() => expect(fakeThis.compactionQueueTransfers).toBe(0));
			expect(fakeThis.compactionQueuedMessages).toEqual([batch[0], batch[2], intervening]);
			expect(fakeThis.session.clearQueue).not.toHaveBeenCalled();
		},
	);

	// Regression test for #9340.
	test("routes interactive response aborts through AgentSession", () => {
		const abort = vi.fn(async () => {});
		const ui = {
			clearAllQueues: () => ({ steering: [], followUp: [] }),
			updatePendingMessagesDisplay: vi.fn(),
			session: { abort },
		};
		const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
			this: typeof ui,
			options?: { abort?: boolean },
		) => number;

		restoreQueuedMessagesToEditor.call(ui, { abort: true });

		expect(abort).toHaveBeenCalledOnce();
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			compactionQueueTransfers: 0,
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith(
			"change direction",
			expect.objectContaining({ streamingBehavior: "steer" }),
		);
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
