// PR #95 / smarty-dev#2636: first receipt precedes host-owned compaction staging.
import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, PromptOptions } from "../../src/core/agent-session.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import * as provenance from "../../src/core/turn-provenance.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const RECEIPT = "2026-09-30T19:00:00.000Z";
const RELEASE = "2026-09-30T19:01:00.000Z";
const RESUBMIT = "2026-09-30T19:02:00.000Z";

type TestUi = {
	runtimeHost: { session: AgentSession };
	editor: {
		getText(): string;
		setText(text: string): void;
		addToHistory(text: string): void;
		onSubmit?: (text: string) => Promise<void>;
	};
	defaultEditor: TestUi["editor"];
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	compactionQueueTransfers: number;
	pendingUserInputs: Array<{ text: string; receipt: PromptOptions }>;
	userInputReceipt?: PromptOptions;
	getUserInput(): Promise<string>;
	setupEditorSubmitHandler(): void;
	handleFollowUp(): Promise<void>;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	restoreQueuedMessagesToEditor(): number;
	showError: ReturnType<typeof vi.fn>;
};

function createUi(harness: Harness): TestUi {
	let text = "";
	const editor = {
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
		addToHistory: vi.fn(),
	};
	const ui = Object.assign(Object.create(InteractiveMode.prototype) as TestUi, {
		runtimeHost: { session: harness.session },
		editor,
		defaultEditor: editor,
		compactionQueuedMessages: [],
		compactionQueueTransfers: 0,
		pendingUserInputs: [],
		updatePendingMessagesDisplay: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		flushPendingBashComponents: vi.fn(),
	});
	ui.setupEditorSubmitHandler();
	return ui;
}

function diskRecord(harness: Harness, text: string) {
	const entries = readFileSync(harness.sessionManager.getSessionFile()!, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as SessionEntry);
	const entry = entries.find(
		(entry) => entry.type === "message" && entry.message.role === "user" && getMessageText(entry.message) === text,
	);
	if (!entry) throw new Error(`Missing persisted input: ${text}`);
	return provenance.getTurnProvenance(entry);
}

describe("TUI host first receipt", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each([false, true])(
		"retains ingress UUID/time through held compaction and replay (retry: %s)",
		async (willRetry) => {
			let entered = () => {};
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const attest = vi.fn(() => ({ principal: "paul" }));
			const harness = await createHarness({
				persistSession: true,
				inputAttestation: { attest },
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							entered();
							await gate;
							return {
								compaction: {
									summary: "held summary",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			await harness.session.bindExtensions({ mode: "tui" });
			harness.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("ok")));
			await harness.session.prompt("seed");
			const ui = createUi(harness);
			const resolve = vi.spyOn(provenance, "resolveHostTurnProvenance");
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(RECEIPT));
			const compact = harness.session.compact();
			try {
				await started;
				expect(harness.session.isCompacting).toBe(true);
				await ui.defaultEditor.onSubmit!("steering received before release");
				ui.editor.setText("follow-up received before release");
				await ui.handleFollowUp();
				const admitted = resolve.mock.results.map((result) => result.value as provenance.TurnProvenance);
				expect(ui.compactionQueuedMessages).toHaveLength(2);
				vi.setSystemTime(new Date(RELEASE));
				release();
				await compact;
				await ui.flushCompactionQueue({ willRetry });
				if (willRetry) await harness.session.prompt("retry trigger");
				await vi.waitFor(() => expect(ui.compactionQueueTransfers).toBe(0));
				await harness.session.waitForIdle();
				const records = [
					diskRecord(harness, "steering received before release"),
					diskRecord(harness, "follow-up received before release"),
				];
				expect(records.map((record) => record?.receivedAt)).toEqual([RECEIPT, RECEIPT]);
				expect(admitted).toHaveLength(2);
				expect(records).toEqual(admitted);
				expect(records[0]?.turnId).toMatch(/^[0-9a-f-]{36}$/);
				expect(records[0]?.turnId).not.toBe(records[1]?.turnId);
				expect(records[0]?.channel).toBe("keyboard");
				expect(attest).toHaveBeenCalledWith({ text: "steering received before release", receivedAt: RECEIPT });
			} finally {
				release();
				await compact;
				await harness.session.waitForIdle();
				harness.cleanup();
			}
		},
	);

	it.each(["old draft", "edited manual submission"])(
		"automatic restoration preserves receipt, but typed dequeue/resubmit creates a new one (%s)",
		async (resubmitted) => {
			let entered = () => {};
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const harness = await createHarness({
				persistSession: true,
				inputAttestation: { attest: () => ({ principal: "paul" }) },
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							entered();
							await gate;
							return {
								compaction: {
									summary: "held",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			await harness.session.bindExtensions({ mode: "tui" });
			harness.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("ok")));
			await harness.session.prompt("seed");
			const ui = createUi(harness);
			const resolve = vi.spyOn(provenance, "resolveHostTurnProvenance");
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(RECEIPT));
			const compact = harness.session.compact();
			try {
				await started;
				await ui.defaultEditor.onSubmit!("automatic replay");
				await ui.defaultEditor.onSubmit!("old draft");
				const admitted = resolve.mock.results.map((result) => result.value as provenance.TurnProvenance);
				const original = [...ui.compactionQueuedMessages];
				vi.setSystemTime(new Date(RELEASE));
				release();
				await compact;
				// Rejected transfers exercise the TUI's automatic restoration before any session admission.
				const input = vi
					.spyOn(harness.session, "prompt")
					.mockRejectedValueOnce(new Error("temporary transfer rejection"));
				const followUp = vi
					.spyOn(harness.session, "steer")
					.mockRejectedValueOnce(new Error("temporary tail rejection"));
				await ui.flushCompactionQueue();
				await vi.waitFor(() => expect(ui.compactionQueueTransfers).toBe(0));
				input.mockRestore();
				followUp.mockRestore();
				expect(ui.compactionQueuedMessages).toEqual(original);
				expect(ui.compactionQueuedMessages[0]).toBe(original[0]);
				// Replay the first record automatically; explicitly return the other to the editor.
				const draft = ui.compactionQueuedMessages.pop()!;
				await ui.flushCompactionQueue();
				await vi.waitFor(() => expect(ui.compactionQueueTransfers).toBe(0));
				await harness.session.waitForIdle();
				ui.compactionQueuedMessages.push(draft);
				expect(ui.restoreQueuedMessagesToEditor()).toBe(1);
				expect(ui.editor.getText()).toBe("old draft");
				vi.setSystemTime(new Date(RESUBMIT));
				ui.editor.setText(resubmitted);
				// Keep the run-loop asleep so the real editor ingress stages the explicit resubmission.
				await ui.defaultEditor.onSubmit!(ui.editor.getText());
				const manualReceipt = resolve.mock.results.at(-1)?.value as provenance.TurnProvenance;
				// The automatic run-loop handoff happens later; this is still the explicit editor receipt.
				vi.setSystemTime(new Date("2026-09-30T19:03:00.000Z"));
				const stagedText = await ui.getUserInput();
				await harness.session.prompt(stagedText, ui.userInputReceipt);
				const automatic = diskRecord(harness, "automatic replay");
				const manual = diskRecord(harness, resubmitted);
				expect(automatic?.receivedAt).toBe(RECEIPT);
				expect(automatic).toEqual(admitted[0]);
				expect(manual?.receivedAt).toBe(RESUBMIT);
				expect(manual).toEqual(manualReceipt);
				expect(manual?.turnId).not.toBe(admitted[1]?.turnId);
				expect(manual?.channel).toBe("keyboard");
			} finally {
				release();
				await compact;
				await harness.session.waitForIdle();
				harness.cleanup();
			}
		},
	);
});
