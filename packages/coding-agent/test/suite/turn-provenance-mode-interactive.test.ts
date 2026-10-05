import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { EditorComponent, Terminal } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ReceivedInput } from "../../src/core/received-input.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

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
	const receipts = SessionManager.open(h.sessionManager.getSessionFile()!)
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "user")
		.map(getTurnProvenance);
	const physical = readFileSync(h.sessionManager.getSessionFile()!, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { type: string; message?: { role: string } })
		.filter((entry) => entry.type === "message" && entry.message?.role === "user")
		.map(getTurnProvenance);
	expect(physical).toEqual(receipts);
	expect(
		h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.map(getTurnProvenance),
	).toEqual(receipts);
	return receipts;
}

// pi#145 SR145-3: idle follow-up owns its receipt before custom-editor clearing.
it.each([
	["plain input", "follow-up", "follow-up"],
	["unregistered slash name", "/unregistered argument", "/unregistered argument"],
	["prompt template", "/receipt-template argument", "Template body argument"],
	["skill invocation", "/skill:receipt-skill argument", "Skill body"],
])("captures idle follow-up %s before a delayed editor clear", async (_kind, submitted, expectedText) => {
	const resourceLoader = createTestResourceLoader();
	const h = await createHarness({
		persistSession: true,
		settings: { compaction: { enabled: false } },
		resourceLoader,
	});
	const templatePath = join(h.tempDir, "receipt-template.md");
	const skillPath = join(h.tempDir, "SKILL.md");
	writeFileSync(templatePath, "Template body $ARGUMENTS");
	writeFileSync(skillPath, "---\nname: receipt-skill\ndescription: Receipt test\n---\nSkill body");
	resourceLoader.getPrompts = () => ({
		prompts: [
			{
				name: "receipt-template",
				description: "Receipt test",
				content: readFileSync(templatePath, "utf8"),
				filePath: templatePath,
				sourceInfo: createSyntheticSourceInfo(templatePath, { source: "test" }),
			},
		],
		diagnostics: [],
	});
	resourceLoader.getSkills = () => ({
		skills: [
			{
				name: "receipt-skill",
				description: "Receipt test",
				filePath: skillPath,
				baseDir: h.tempDir,
				disableModelInvocation: false,
				sourceInfo: createSyntheticSourceInfo(skillPath, { source: "test" }),
			},
		],
		diagnostics: [],
	});
	h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	const mode = modeFor(h);
	const internals = mode as unknown as {
		setupEditorSubmitHandler(): void;
		handleFollowUp(): Promise<void>;
		setCustomEditorComponent(factory: () => EditorComponent): void;
		editor: EditorComponent;
		getReceivedUserInput(): Promise<ReceivedInput>;
	};
	internals.setupEditorSubmitHandler();
	internals.editor.setText(submitted);
	let draft = submitted;
	internals.setCustomEditorComponent(() => ({
		getText: () => draft,
		setText: (text) => {
			if (text === "") vi.setSystemTime("2026-10-01T12:01:00.000Z");
			draft = text;
		},
		handleInput: () => {},
		render: () => [],
		invalidate: () => {},
	}));
	internals.editor.setText(submitted);
	vi.useFakeTimers({ toFake: ["Date"] });
	const first = "2026-10-01T12:00:00.000Z";
	vi.setSystemTime(first);
	try {
		await internals.handleFollowUp();
		internals.editor.setText(submitted);
		vi.setSystemTime(first);
		await internals.handleFollowUp();
		vi.spyOn(mode, "init").mockResolvedValue(undefined);
		const dequeue = internals.getReceivedUserInput.bind(mode);
		let count = 0;
		const end = new Error("test loop end");
		vi.spyOn(internals, "getReceivedUserInput").mockImplementation(() =>
			++count > 2 ? Promise.reject(end) : dequeue(),
		);
		await expect(mode.run()).rejects.toBe(end);
		const receipts = reopenedReceipts(h);
		expect(receipts).toHaveLength(2);
		expect(new Set(receipts.map((receipt) => receipt?.turnId)).size).toBe(2);
		for (const receipt of receipts) {
			expect(receipt).toMatchObject({ receivedAt: first, channel: "terminal", v: 1 });
			expect(Object.keys(receipt!).sort()).toEqual(["channel", "receivedAt", "turnId", "v"]);
		}
		const expected = submitted.startsWith("/skill:")
			? `<skill name="receipt-skill" location="${skillPath}">\nReferences are relative to ${h.tempDir}.\n\n${expectedText}\n</skill>\n\nargument`
			: expectedText;
		expect(getUserTexts(h)).toEqual([expected, expected]);
	} finally {
		vi.useRealTimers();
	}
});

// pi#145 controls: the shared dispatcher must still consume built-in and bash commands.
it.each(["enter", "follow-up"])("preserves handled commands on idle %s", async (action) => {
	const h = await createHarness({ settings: { compaction: { enabled: false } } });
	const mode = modeFor(h);
	const internals = mode as unknown as {
		setupEditorSubmitHandler(): void;
		handleFollowUp(): Promise<void>;
		handleBashCommand(command: string, excluded: boolean): Promise<void>;
		editor: EditorComponent;
		pendingUserInputs: ReceivedInput[];
	};
	internals.setupEditorSubmitHandler();
	const bash = vi.spyOn(internals, "handleBashCommand").mockResolvedValue(undefined);
	for (const command of ["/name receipt-control", "!echo receipt-control", "!!echo excluded"]) {
		internals.editor.setText(command);
		if (action === "follow-up") await internals.handleFollowUp();
		else await internals.editor.onSubmit?.(command);
	}
	expect(h.sessionManager.getSessionName()).toBe("receipt-control");
	expect(bash.mock.calls).toEqual([
		["echo receipt-control", false],
		["echo excluded", true],
	]);
	expect(internals.pendingUserInputs).toEqual([]);
	expect(getUserTexts(h)).toEqual([]);
});

// pi#145 control: registered extension slash commands must not fall through as user turns.
it("preserves an idle follow-up extension command", async () => {
	const handled = vi.fn();
	const h = await createHarness({
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			(api) => {
				api.registerCommand("receipt-command", { description: "Receipt control", handler: handled });
			},
		],
	});
	const mode = modeFor(h);
	const internals = mode as unknown as {
		setupEditorSubmitHandler(): void;
		handleFollowUp(): Promise<void>;
		editor: EditorComponent;
		getReceivedUserInput(): Promise<ReceivedInput>;
	};
	internals.setupEditorSubmitHandler();
	internals.editor.setText("/receipt-command argument");
	await internals.handleFollowUp();
	vi.spyOn(mode, "init").mockResolvedValue(undefined);
	const dequeue = internals.getReceivedUserInput.bind(mode);
	let count = 0;
	const end = new Error("test loop end");
	vi.spyOn(internals, "getReceivedUserInput").mockImplementation(() =>
		++count > 1 ? Promise.reject(end) : dequeue(),
	);
	await expect(mode.run()).rejects.toBe(end);
	expect(handled).toHaveBeenCalledOnce();
	expect(handled.mock.calls[0][0]).toBe("argument");
	expect(getUserTexts(h)).toEqual([]);
});

// pi#145 control: streaming follow-up already captures before custom-editor effects.
it("retains streaming follow-up before a delayed custom-editor clear", async () => {
	let release!: () => void;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let requests = 0;
	const h = await createHarness({
		persistSession: true,
		settings: { compaction: { enabled: false } },
		prepareRequest: async () => {
			if (++requests === 1) {
				entered();
				await held;
			}
		},
	});
	h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	const mode = modeFor(h);
	const internals = mode as unknown as {
		setupEditorSubmitHandler(): void;
		handleFollowUp(): Promise<void>;
		setCustomEditorComponent(factory: () => EditorComponent): void;
		editor: EditorComponent;
	};
	internals.setupEditorSubmitHandler();
	internals.editor.setText("streaming-follow-up");
	let draft = "";
	internals.setCustomEditorComponent(() => ({
		getText: () => draft,
		setText: (text) => {
			if (text === "") vi.setSystemTime("2026-10-01T12:01:00.000Z");
			draft = text;
		},
		handleInput: () => {},
		render: () => [],
		invalidate: () => {},
	}));
	const running = h.session.prompt("start");
	try {
		await started;
		expect(h.session.isStreaming).toBe(true);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime("2026-10-01T12:00:00.000Z");
		await internals.handleFollowUp();
	} finally {
		release();
		await running;
		vi.useRealTimers();
	}
	expect(reopenedReceipts(h)[1]).toMatchObject({ receivedAt: "2026-10-01T12:00:00.000Z", channel: "terminal" });
});

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
