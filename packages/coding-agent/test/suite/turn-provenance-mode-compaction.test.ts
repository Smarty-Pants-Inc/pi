import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { EditorComponent, Terminal } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { getInputReceipt, promptReceived, type ReceivedInput } from "../../src/core/received-input.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { receiptRecord } from "../../src/core/turn-receipts.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

type PrivateMode = {
	setupEditorSubmitHandler(): void;
	defaultEditor: EditorComponent;
	editor: EditorComponent;
	handleFollowUp(): Promise<void>;
	getReceivedUserInput(): Promise<ReceivedInput>;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	restoreQueuedMessagesToEditor(): number;
	compactionQueuedMessages: Array<{ input: ReceivedInput; mode: "steer" | "followUp" }>;
	compactionQueueTransfers: number;
};
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
});
function modeFor(h: Harness): PrivateMode {
	initTheme("dark");
	const terminal: Terminal = {
		columns: 100,
		rows: 30,
		kittyProtocolActive: false,
		start: () => {},
		stop: () => {},
		drainInput: async () => {},
		write: () => {},
		moveBy: () => {},
		hideCursor: () => {},
		showCursor: () => {},
		clearLine: () => {},
		clearFromCursor: () => {},
		clearScreen: () => {},
		setTitle: () => {},
		setProgress: () => {},
	};
	const runtime = new AgentSessionRuntime(
		h.session,
		{
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.session.modelRuntime,
			settingsManager: h.settingsManager,
			resourceLoader: h.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("No replacement requested");
		},
	);
	const mode = new InteractiveMode(runtime, { terminal });
	cleanups.push(() => {
		mode.stop();
		h.cleanup();
	});
	const privateMode = mode as unknown as PrivateMode;
	privateMode.setupEditorSubmitHandler();
	return privateMode;
}
// pi#95: all automatic compaction transfers retain admission, not flush time.
it.each([false, true])(
	"retains repeated steer/follow-up inputs through held compaction (retry: %s)",
	async (willRetry) => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const h = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						entered();
						await held;
						return {
							compaction: {
								summary: "summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		const mode = modeFor(h);
		await h.session.bindExtensions({});
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await h.session.prompt("seed one");
		await h.session.prompt("seed two");
		const compacting = h.session.compact();
		await started;
		await mode.defaultEditor.onSubmit?.("repeat");
		await mode.defaultEditor.onSubmit?.("repeat");
		mode.editor.setText("repeat");
		await mode.handleFollowUp();
		const admitted = mode.compactionQueuedMessages.map(({ input }) => receiptRecord(getInputReceipt(input)));
		expect(admitted).toHaveLength(3);
		expect(new Set(admitted.map((receipt) => receipt.turnId)).size).toBe(3);
		await new Promise((resolve) => setTimeout(resolve, 30));
		release();
		await compacting;
		h.setResponses([fauxAssistantMessage("three"), fauxAssistantMessage("four"), fauxAssistantMessage("five")]);
		await mode.flushCompactionQueue({ willRetry });
		if (willRetry) await h.session.prompt("resume");
		await vi.waitFor(() => {
			expect(mode.compactionQueueTransfers).toBe(0);
			expect(h.session.isIdle).toBe(true);
		});
		const receipts = SessionManager.open(h.sessionManager.getSessionFile()!)
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.map(getTurnProvenance)
			.filter((receipt) => admitted.some((candidate) => candidate.turnId === receipt?.turnId));
		expect(receipts).toEqual(admitted);
	},
);
// pi#95: failed automatic transfers retain receipts; restoring a draft discards the occurrence.
it("keeps a receipt after failed transfer but mints a fresh occurrence after editor restoration", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const h = await createHarness({
		persistSession: true,
		settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					entered();
					await held;
					return {
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		],
	});
	const mode = modeFor(h);
	await h.session.bindExtensions({});
	h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	await h.session.prompt("seed one");
	await h.session.prompt("seed two");
	const compacting = h.session.compact();
	await started;
	await mode.defaultEditor.onSubmit?.("retained");
	const input = mode.compactionQueuedMessages[0]!.input;
	const original = receiptRecord(getInputReceipt(input));
	release();
	await compacting;
	// A real missing-model preflight failure occurs before the transfer callback.
	const model = h.session.agent.state.model;
	Object.assign(h.session.agent.state, { model: undefined });
	await mode.flushCompactionQueue();
	await vi.waitFor(() => expect(mode.compactionQueueTransfers).toBe(0));
	expect(mode.compactionQueuedMessages[0]?.input).toBe(input);
	expect(receiptRecord(getInputReceipt(mode.compactionQueuedMessages[0]!.input))).toEqual(original);
	h.session.agent.state.model = model;
	h.setResponses([fauxAssistantMessage("retained response")]);
	await mode.flushCompactionQueue();
	await vi.waitFor(() => expect(mode.compactionQueueTransfers).toBe(0));
	expect(h.sessionManager.getEntries().map(getTurnProvenance)).toContainEqual(original);
	mode.compactionQueuedMessages.push({ input, mode: "steer" });
	expect(mode.restoreQueuedMessagesToEditor()).toBe(1);
	await new Promise((resolve) => setTimeout(resolve, 30));
	await mode.defaultEditor.onSubmit?.(mode.editor.getText());
	const resubmission = await mode.getReceivedUserInput();
	const fresh = receiptRecord(getInputReceipt(resubmission));
	expect(fresh.turnId).not.toBe(original.turnId);
	expect(Date.parse(fresh.receivedAt)).toBeGreaterThan(Date.parse(original.receivedAt));
	h.setResponses([fauxAssistantMessage("fresh response")]);
	await promptReceived(h.session, resubmission);
	const reopened = SessionManager.open(h.sessionManager.getSessionFile()!);
	expect(reopened.getEntries().map(getTurnProvenance)).toContainEqual(fresh);
});
