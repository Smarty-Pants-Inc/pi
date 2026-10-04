import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { EditorComponent, Terminal } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ReceivedInput } from "../../src/core/received-input.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function modeFor(h: Harness, initialMessages: string[] = []): InteractiveMode {
	initTheme("dark");
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("PI_SKIP_VERSION_CHECK", "1");
	vi.stubEnv("TMUX", "");
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
	const mode = new InteractiveMode(runtime, {
		initialMessage: initialMessages[0],
		initialMessages: initialMessages.slice(1),
		terminal,
	});
	cleanups.push(() => {
		mode.stop();
		h.cleanup();
	});
	return mode;
}

function reopenedReceipts(h: Harness) {
	return SessionManager.open(h.sessionManager.getSessionFile()!)
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "user")
		.map(getTurnProvenance);
}

// pi#95: direct interactive initial batches must precede init and all previous batch turns.
it("captures repeated initial inputs before held interactive startup", async () => {
	const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
	h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
	const mode = modeFor(h, ["same", "same", "same"]);
	const admittedBy = Date.now();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.spyOn(mode, "init").mockImplementation(() => held);
	const end = new Error("test loop end");
	const dequeue = mode as unknown as { getReceivedUserInput(): Promise<ReceivedInput> };
	vi.spyOn(dequeue, "getReceivedUserInput").mockRejectedValue(end);
	const running = mode.run();
	const outcome = expect(running).rejects.toBe(end);
	await new Promise((resolve) => setTimeout(resolve, 30));
	release();
	await outcome;
	const receipts = reopenedReceipts(h);
	expect(receipts).toHaveLength(3);
	expect(new Set(receipts.map((receipt) => receipt?.turnId)).size).toBe(3);
	for (const receipt of receipts) {
		expect(Object.keys(receipt!).sort()).toEqual(["channel", "receivedAt", "turnId", "v"]);
		expect(receipt?.channel).toBe("terminal");
		expect(Date.parse(receipt!.receivedAt)).toBeLessThanOrEqual(admittedBy);
	}
});

// pi#95: ordinary editor staging is an admitted occurrence, not an editor-history/text key.
it("retains repeated queued ordinary inputs before dequeue and preserves public string input", async () => {
	const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
	h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	const mode = modeFor(h);
	const internals = mode as unknown as {
		setupEditorSubmitHandler(): void;
		defaultEditor: EditorComponent;
		getReceivedUserInput(): Promise<ReceivedInput>;
	};
	internals.setupEditorSubmitHandler();
	await internals.defaultEditor.onSubmit?.(" same ");
	await internals.defaultEditor.onSubmit?.("same");
	const admittedBy = Date.now();
	await new Promise((resolve) => setTimeout(resolve, 30));
	vi.spyOn(mode, "init").mockResolvedValue(undefined);
	const dequeue = internals.getReceivedUserInput.bind(mode);
	let count = 0;
	const end = new Error("test loop end");
	vi.spyOn(internals, "getReceivedUserInput").mockImplementation(() => {
		if (++count > 2) return Promise.reject(end);
		return dequeue();
	});
	await expect(mode.run()).rejects.toBe(end);
	const receipts = reopenedReceipts(h);
	expect(receipts).toHaveLength(2);
	expect(receipts[0]?.turnId).not.toBe(receipts[1]?.turnId);
	for (const receipt of receipts) expect(Date.parse(receipt!.receivedAt)).toBeLessThanOrEqual(admittedBy);
	vi.restoreAllMocks();
	await internals.defaultEditor.onSubmit?.("public string");
	await expect(mode.getUserInput()).resolves.toBe("public string");
});
