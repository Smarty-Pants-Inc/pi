import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { EditorComponent, Terminal } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { formatKeyText, keyText } from "../src/modes/interactive/components/keybinding-hints.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface QuitInternals {
	setupEditorSubmitHandler(): void;
	setupKeyHandlers(): void;
	defaultEditor: EditorComponent;
	editor: EditorComponent;
	shutdown(): Promise<void>;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function modeFor(h: Harness, agentDir = h.tempDir): { mode: InteractiveMode; internals: QuitInternals } {
	initTheme("dark");
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
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
		setProgramStatus: () => {},
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
	const internals = mode as unknown as QuitInternals;
	internals.setupEditorSubmitHandler();
	return { mode, internals };
}

function busyWarning(): string {
	return `A turn is running. Press ${keyText("app.interrupt").replaceAll("escape", "Esc")} to stop it, then /quit. To quit now: ${keyText("app.exit")}.`;
}

function heldWaitTool(): { tool: AgentTool; release: () => void } {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await held;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	return { tool, release };
}

function toolStarted(h: Harness): Promise<void> {
	return new Promise<void>((resolve) => {
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				unsubscribe();
				resolve();
			}
		});
	});
}

// Regression tests for #11043: /quit during a running turn must not tear the session down.
describe("InteractiveMode /quit command", () => {
	it("refuses to shut down while a long tool call runs, and the turn completes and persists", async () => {
		const { tool: waitTool, release } = heldWaitTool();
		const h = await createHarness({
			persistSession: true,
			tools: [waitTool],
			settings: { compaction: { enabled: false } },
		});
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const { mode, internals } = modeFor(h);
		const shutdown = vi.spyOn(internals, "shutdown").mockResolvedValue(undefined);
		const warn = vi.spyOn(mode, "showWarning");
		const started = toolStarted(h);

		const running = h.session.prompt("start");
		try {
			await started;
			expect(h.session.isStreaming).toBe(true);
			internals.editor.setText("/quit");
			await internals.defaultEditor.onSubmit?.("/quit");

			expect(shutdown).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith(busyWarning());
			expect(busyWarning()).toBe("A turn is running. Press Esc to stop it, then /quit. To quit now: ctrl+d.");
			expect(internals.editor.getText()).toBe("");
		} finally {
			release();
			await running;
		}

		expect(shutdown).not.toHaveBeenCalled();
		const persisted = readFileSync(h.sessionManager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; message?: { role: string; toolName?: string } });
		const waitResult = persisted.find((entry) => entry.message?.role === "toolResult");
		expect(waitResult?.message?.toolName).toBe("wait");
		expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant" });
	});

	it.each([
		["compaction", "isCompacting", true],
		["pending input admission", "inputAdmissionCount", 1],
	] as const)("refuses to shut down during %s", async (_kind, property, value) => {
		const h = await createHarness({ settings: { compaction: { enabled: false } } });
		const { mode, internals } = modeFor(h);
		const shutdown = vi.spyOn(internals, "shutdown").mockResolvedValue(undefined);
		const warn = vi.spyOn(mode, "showWarning");
		Object.defineProperty(h.session, property, { configurable: true, get: () => value });
		try {
			internals.editor.setText("/quit");
			await internals.defaultEditor.onSubmit?.("/quit");
		} finally {
			Reflect.deleteProperty(h.session, property);
		}

		expect(shutdown).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(busyWarning());
		expect(internals.editor.getText()).toBe("");
	});

	it("names remapped interrupt and exit keys, and the remapped interrupt aborts the busy turn", async () => {
		const { tool: waitTool, release } = heldWaitTool();
		const h = await createHarness({ tools: [waitTool], settings: { compaction: { enabled: false } } });
		const agentDir = join(h.tempDir, "keybindings-agent");
		mkdirSync(agentDir);
		writeFileSync(
			join(agentDir, "keybindings.json"),
			JSON.stringify({ "app.interrupt": "alt+k", "app.exit": "alt+x" }),
		);
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const { mode, internals } = modeFor(h, agentDir);
		internals.setupKeyHandlers();
		const shutdown = vi.spyOn(internals, "shutdown").mockResolvedValue(undefined);
		const warn = vi.spyOn(mode, "showWarning");
		const abort = vi.spyOn(h.session, "abort");
		const started = toolStarted(h);

		const running = h.session.prompt("start");
		try {
			await started;
			internals.editor.setText("/quit");
			await internals.defaultEditor.onSubmit?.("/quit");

			expect(keyText("app.interrupt")).toBe(formatKeyText("alt+k"));
			expect(keyText("app.exit")).toBe(formatKeyText("alt+x"));
			expect(warn).toHaveBeenCalledWith(busyWarning());
			expect(abort).not.toHaveBeenCalled();

			internals.defaultEditor.handleInput?.("\x1bk");
			expect(abort).toHaveBeenCalledOnce();
		} finally {
			release();
			await running;
		}

		expect(shutdown).not.toHaveBeenCalled();
		expect(h.session.isStreaming).toBe(false);
	});

	it("shuts down from the editor when idle", async () => {
		const h = await createHarness({ settings: { compaction: { enabled: false } } });
		const { mode, internals } = modeFor(h);
		const shutdown = vi.spyOn(internals, "shutdown").mockResolvedValue(undefined);
		const warn = vi.spyOn(mode, "showWarning");

		internals.editor.setText("/quit");
		await internals.defaultEditor.onSubmit?.("/quit");

		expect(shutdown).toHaveBeenCalledOnce();
		expect(warn).not.toHaveBeenCalled();
		expect(internals.editor.getText()).toBe("");
	});
});
