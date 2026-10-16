import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, streamSimple } from "@earendil-works/pi-ai/compat";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { AgentSessionRuntime, type AgentSessionServices } from "../../../src/core/agent-session-runtime.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { type ReceivedInput, receiveInput } from "../../../src/core/received-input.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { UNSENT_INPUT_TYPE, type UnsentInput } from "../../../src/core/unsent-input.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "../harness.ts";

function createUiFixture(harness: Harness) {
	const services: AgentSessionServices = {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.resourceLoader,
		diagnostics: [],
	};
	const runtime = new AgentSessionRuntime(harness.session, services, async () => {
		throw new Error("This fixture must not replace the session");
	});
	let draft = "existing editor draft";
	const editor = {
		getText: () => draft,
		getExpandedText: () => draft,
		setText: (text: string) => {
			draft = text;
		},
		addToHistory: vi.fn(),
		onEscape: (() => {}) as (() => void) | undefined,
		onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
	};
	const defaultEditor = editor;
	const warnings: string[] = [];
	const errors: string[] = [];
	const recoveredImages = new Map<string, ImageContent>();
	const stop = vi.fn();
	const drainInput = vi.fn(async () => {});
	initTheme("dark");
	// Only terminal/UI effects are fixtures. Admission, queues, exit and draft recovery use real code.
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: runtime,
		editor,
		defaultEditor,
		recoveredImages,
		isInitialized: true,
		confirmUnsentDiscard: false,
		operatorExitRequested: false,
		operatorExitInputsSaved: false,
		pendingUserInputs: [] as ReceivedInput[],
		userInputInFlight: false,
		compactionQueuedMessages: [] as Array<{ input: ReceivedInput; mode: "steer" | "followUp" }>,
		compactionTransferInputs: new Set<{ input: ReceivedInput; mode: "steer" | "followUp" }>(),
		compactionQueueTransfers: 0,
		compactionQueueWork: new Set<Promise<void>>(),
		pendingMessagesContainer: new Container(),
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		themeController: { disableAutoSync: vi.fn() },
		ui: { terminal: { drainInput, setProgress: vi.fn() }, requestRender: vi.fn() },
		uiHolds: new Set(),
		captureHerdrSubmit: () => undefined,
		createExtensionUIContext: () => createTestUiContext(),
		setupAutocompleteProvider: vi.fn(),
		setupExtensionShortcuts: vi.fn(),
		showLoadedResources: vi.fn(),
		showStartupNoticesIfNeeded: vi.fn(),
		getAppKeyDisplay: () => "dequeue",
		showStatus: vi.fn(),
		showStatusIndicator: (indicator: { dispose(): void }) => indicator.dispose(),
		clearStatusIndicator: vi.fn(),
		stop,
		showWarning: (message: string) => warnings.push(message),
		showError: (message: string) => errors.push(message),
	}) as InteractiveMode;
	const dispatch = Reflect.get(InteractiveMode.prototype, "dispatchEditorInput") as (
		this: InteractiveMode,
		input: ReceivedInput,
	) => Promise<void>;
	const restore = Reflect.get(InteractiveMode.prototype, "restoreUnsentInputDrafts") as (
		this: InteractiveMode,
	) => void;
	const bind = Reflect.get(InteractiveMode.prototype, "bindCurrentSessionExtensions") as (
		this: InteractiveMode,
	) => Promise<void>;
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: InteractiveMode,
		event: AgentSessionEvent,
	) => Promise<void>;
	return {
		mode,
		runtime,
		editor,
		defaultEditor,
		warnings,
		errors,
		recoveredImages,
		stop,
		drainInput,
		dispatch: (text: string) => dispatch.call(mode, receiveInput(text)),
		restore: () => restore.call(mode),
		bind: () => bind.call(mode),
		handleEvent: (event: AgentSessionEvent) => handleEvent.call(mode, event),
	};
}

function captureUnsentStderr(beforeWrite?: () => void): string[] {
	const blocks: string[] = [];
	const writeFileSync = fs.writeFileSync;
	vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
		if (file !== process.stderr.fd) return writeFileSync(file, data, options);
		beforeWrite?.();
		blocks.push(String(data));
	});
	// pi#262 / smarty-dev#3155: InteractiveMode uses node:fs namespace bindings, not the default object.
	syncBuiltinESMExports();
	return blocks;
}

// pi#262 / smarty-dev#3155: data safety and foreign-input trust boundaries need real-session coverage.
describe("interactive unsent-input consent and draft recovery", () => {
	const harnesses: Harness[] = [];
	const extraSessions: AgentSession[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		for (const session of extraSessions.splice(0)) {
			if (session.isDisposed) continue;
			session.cancelForShutdown();
			await session.abort();
			session.clearQueue();
			session.dispose();
		}
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	// pi#262 / smarty-dev#3155: a queue revision invalidates the operator's previous discard consent.
	it.each([false, true])("requires fresh consent after a custom nextTurn enqueue: changed=%s", async (changed) => {
		let enqueueNextTurn: (() => void) | undefined;
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					enqueueNextTurn = () =>
						pi.sendMessage(
							{ customType: "late-extension-input", content: "third queued input", display: true },
							{ deliverAs: "nextTurn" },
						);
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		await harness.session.steer("first queued input");
		await harness.session.followUp("second queued input");
		const fixture = createUiFixture(harness);
		const order: string[] = [];
		fixture.stop.mockImplementation(() => {
			expect(blocks).toEqual([]);
			order.push("stop");
		});
		const blocks = captureUnsentStderr(() => {
			expect(harness.session.isDisposed).toBe(true);
			expect(fixture.stop).toHaveBeenCalledTimes(1);
			order.push("stderr");
		});
		// Returning instead of throwing prevents the production catch from treating the spy as an error.
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			order.push("exit");
			return undefined as never;
		});
		await fixture.dispatch("/quit");
		expect(fixture.warnings).toHaveLength(1);
		expect(fixture.warnings[0]).toBe(
			"2 queued messages are not saved (no session file). /quit again to discard them and exit.",
		);
		expect(blocks).toEqual([]);
		expect(exit).not.toHaveBeenCalled();
		expect(fixture.stop).not.toHaveBeenCalled();
		expect(harness.session.shutdownSignal.aborted).toBe(false);
		const warnedRevision = harness.session.queuedInputRevision;

		if (changed) {
			if (!enqueueNextTurn) throw new Error("Extension did not initialize");
			// No editor command or UI queue_update reset: this is the extension's real API.
			enqueueNextTurn();
			expect(harness.session.queuedInputRevision).toBeGreaterThan(warnedRevision);
		}
		await fixture.dispatch("/quit");
		if (changed) {
			expect(fixture.warnings).toHaveLength(2);
			expect(fixture.warnings[1]).toContain("3 queued messages are not saved");
			expect(exit).not.toHaveBeenCalled();
			expect(fixture.stop).not.toHaveBeenCalled();
			expect(harness.session.isDisposed).toBe(false);
			expect(harness.session.shutdownSignal.aborted).toBe(false);
			expect(blocks).toEqual([]);
			await fixture.dispatch("/quit");
		}
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(0);
		expect(fixture.stop).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["stop", "stderr", "exit"]);
		expect(fixture.warnings).toHaveLength(changed ? 2 : 1);
		expect(blocks).toEqual([
			`Unsent input (not saved; --no-session):\nfirst queued input\nsecond queued input\n${changed ? "third queued input\n" : ""}`,
		]);
		expect(harness.session.isDisposed).toBe(true);
		expect(harness.session.agent.getQueuedMessages()).toEqual([]);
		expect(harness.sessionManager.getSessionFile()).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(0);
	});

	// pi#262 / smarty-dev#3155: the explicit discard receipt covers every pending source and occurrence.
	it("prints the full no-session backlog once after terminal stop", async () => {
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "held admission") {
							enter();
							await held;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		let modePending = true;
		const staged = receiveInput("mode queued");
		await harness.session.bindExtensions({
			hasPendingInput: () => modePending,
			getPendingInputs: () => (modePending ? [{ input: staged, mode: "followUp" }] : []),
			clearPendingInputs: () => {
				modePending = false;
			},
		});
		await harness.session.steer("session steer");
		const repeated = { role: "user" as const, content: "same raw user", timestamp: 1 };
		harness.session.agent.followUp(repeated);
		harness.session.agent.followUp(repeated);
		await harness.session.sendCustomMessage(
			{ customType: "aside", content: "next-turn aside", display: true },
			{ deliverAs: "nextTurn" },
		);
		harness.session.agent.steer({
			role: "custom",
			customType: "pi-fabric-agent-message",
			content: [{ type: "text", text: "raw custom" }],
			display: true,
			timestamp: 1,
		});
		const imageOnly = {
			role: "custom" as const,
			customType: "image-only",
			content: [{ type: "image" as const, mimeType: "image/png", data: "original-bytes" }],
			display: true,
			timestamp: 1,
		};
		harness.session.agent.followUp(imageOnly);
		const admission = harness.session.followUp("held admission");
		void admission.catch(() => {});
		try {
			await entered;
			const fixture = createUiFixture(harness);
			const blocks = captureUnsentStderr(() => {
				expect(modePending).toBe(false);
				expect(harness.session.inputAdmissionCount).toBe(0);
				expect(harness.session.agent.getQueuedMessageOccurrences()).toEqual([]);
				expect(harness.session.isDisposed).toBe(true);
				expect(fixture.stop).toHaveBeenCalledTimes(1);
			});
			const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
			await fixture.dispatch("/quit");
			expect(fixture.warnings).toEqual([
				"8 queued messages are not saved (no session file). /quit again to discard them and exit.",
			]);
			expect(blocks).toEqual([]);
			await fixture.dispatch("/quit");
			expect(blocks).toEqual([
				`Unsent input (not saved; --no-session):\nsession steer\nsame raw user\nsame raw user\nnext-turn aside\nraw custom\n${JSON.stringify(imageOnly)}\nheld admission\nmode queued\n`,
			]);
			expect(modePending).toBe(false);
			expect(harness.session.isDisposed).toBe(true);
			expect(harness.session.agent.getQueuedMessages()).toEqual([]);
			expect(harness.sessionManager.getSessionFile()).toBeUndefined();
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
			).toEqual([]);
			expect(harness.faux.state.callCount).toBe(0);
			expect(exit).toHaveBeenCalledWith(0);
			await expect(admission).rejects.toThrow("INPUT_ADMISSION_ABORTED");
		} finally {
			release();
			await admission.catch(() => {});
		}
	});

	// pi#262 / smarty-dev#3155: headless disposal still writes before discarding any input.
	it("retains headless input when synchronous stderr printing fails", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		await harness.session.followUp("keep after stderr failure");
		const fixture = createUiFixture(harness);
		let fail = true;
		const blocks = captureUnsentStderr(() => {
			expect(harness.session.isDisposed).toBe(false);
			expect(harness.session.agent.getQueuedMessages()).toHaveLength(1);
			if (fail) throw new Error("stderr unavailable");
		});
		const queued = harness.session.agent.getQueuedMessageOccurrences();
		await expect(fixture.runtime.dispose({ operatorExit: true, discardUnsentInput: true })).rejects.toThrow(
			"INPUT_ADMISSION_BUSY: unsent input could not be printed to stderr; input was not discarded",
		);
		expect(blocks).toEqual([]);
		expect(harness.session.agent.getQueuedMessageOccurrences()).toEqual(queued);
		expect(harness.session.isDisposed).toBe(false);
		expect(harness.session.inputsFenced).toBe(false);
		expect(harness.session.shutdownSignal.aborted).toBe(false);
		expect(fixture.stop).not.toHaveBeenCalled();
		fail = false;
		await fixture.runtime.dispose({ operatorExit: true, discardUnsentInput: true });
		expect(blocks).toEqual(["Unsent input (not saved; --no-session):\nkeep after stderr failure\n"]);
		expect(harness.session.isDisposed).toBe(true);
		expect(harness.sessionManager.getSessionFile()).toBeUndefined();
	});

	// pi#262 / smarty-dev#3155: deferred stderr failure is not a recoverable pre-stop refusal.
	it("reports a post-stop stderr failure without claiming successful exit", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		await harness.session.followUp("visible after stop");
		const fixture = createUiFixture(harness);
		const blocks = captureUnsentStderr(() => {
			expect(fixture.stop).toHaveBeenCalledTimes(1);
			throw new Error("stderr unavailable after stop");
		});
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		await fixture.dispatch("/quit");
		await expect(fixture.dispatch("/quit")).rejects.toThrow("stderr unavailable after stop");
		expect(blocks).toEqual([]);
		expect(harness.session.isDisposed).toBe(true);
		expect(fixture.errors).toEqual([]);
		expect(exit).not.toHaveBeenCalled();
	});

	// pi#262 / smarty-dev#3155: a signal may upgrade disposal while the TUI is still draining input.
	it("keeps the buffered block through a signal upgrade and prints it once after stop", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		await harness.session.steer("first upgraded text");
		await harness.session.followUp("second upgraded text");
		const fixture = createUiFixture(harness);
		fixture.editor.setText("");
		const blocks = captureUnsentStderr(() => {
			expect(fixture.stop).toHaveBeenCalledTimes(1);
		});
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		await fixture.dispatch("/quit");
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		fixture.drainInput.mockImplementationOnce(async () => {
			enter();
			await held;
		});
		const quitting = fixture.dispatch("/quit");
		const shutdown = Reflect.get(InteractiveMode.prototype, "shutdown") as (
			this: InteractiveMode,
			options: { fromSignal: boolean },
		) => Promise<void>;
		try {
			await entered;
			expect(blocks).toEqual([]);
			expect(fixture.stop).not.toHaveBeenCalled();
			const upgraded = shutdown.call(fixture.mode, { fromSignal: true });
			release();
			await Promise.all([quitting, upgraded]);
			expect(blocks).toEqual([
				"Unsent input (not saved; --no-session):\nfirst upgraded text\nsecond upgraded text\n",
			]);
			expect(fixture.stop).toHaveBeenCalledTimes(1);
			expect(exit).toHaveBeenCalledTimes(1);
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			release();
			await quitting;
		}
	});

	// pi#262 / smarty-dev#3155: preparation publication can fail after buffering but before beforeShutdown.
	it("stops before flushing the retained block when disposal throws before terminal cleanup", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		await harness.session.steer("first retained text");
		await harness.session.followUp("second retained text");
		const fixture = createUiFixture(harness);
		const blocks = captureUnsentStderr(() => {
			expect(fixture.stop).toHaveBeenCalledTimes(1);
		});
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		await fixture.dispatch("/quit");
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "queue_update") throw new Error("queue publication failed");
		});
		try {
			await expect(fixture.dispatch("/quit")).rejects.toThrow("queue publication failed");
			expect(blocks).toEqual([
				"Unsent input (not saved; --no-session):\nfirst retained text\nsecond retained text\n",
			]);
			expect(fixture.stop).toHaveBeenCalledTimes(1);
			expect(exit).not.toHaveBeenCalled();
			expect(fixture.errors).toEqual([]);
		} finally {
			unsubscribe();
		}
	});

	// pi#262 / smarty-dev#3155: foreign input never acquires local replay authority or stale identity.
	it("merges unstamped user/custom text and images into one unsent draft, then submits as fresh input", async () => {
		const manager = SessionManager.inMemory();
		const userImage: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
		};
		const customImage: ImageContent = { ...userImage };
		const provenance = {
			v: 1 as const,
			channel: "fabric" as const,
			turnId: "12345678-1234-4234-8234-123456789abc",
			receivedAt: "2026-01-01T00:00:00.000Z",
			sender: { id: "foreign-agent", kind: "agent" as const, verified: "mesh" as const },
		};
		manager.appendCustomEntry(UNSENT_INPUT_TYPE, {
			message: { role: "user", content: [{ type: "text", text: "foreign user text" }, userImage], timestamp: 1 },
			mode: "steer",
			metadata: { foreignSecret: "must-not-survive" },
			metadataSource: { kind: "extension", extensionPath: "foreign-extension.ts" },
			provenance,
		} satisfies UnsentInput);
		manager.appendCustomEntry(UNSENT_INPUT_TYPE, {
			message: {
				role: "custom",
				customType: "foreign-custom",
				content: [{ type: "text", text: "foreign custom text" }, customImage],
				display: false,
				details: { foreignSecret: "must-not-survive" },
				timestamp: 2,
			},
			mode: "nextTurn",
			provenance,
		} satisfies UnsentInput);
		const harness = await createHarness({
			sessionManager: manager,
			settings: { compaction: { enabled: false }, images: { autoResize: false } },
		});
		harnesses.push(harness);
		const fixture = createUiFixture(harness);
		expect(harness.session.agent.getQueuedMessages()).toEqual([]);
		fixture.restore();
		const draft = fixture.editor.getText();
		expect(draft).toMatch(/^existing editor draft\nforeign user text\n\[recovered image /);
		expect(draft).toContain("foreign custom text");
		expect([...fixture.recoveredImages.values()]).toEqual([userImage, customImage]);
		expect(fixture.warnings).toHaveLength(1);
		expect(fixture.warnings[0]).toMatch(/foreign.*unsent.*restored as draft.*not sent/i);
		expect(harness.session.agent.getQueuedMessages()).toEqual([]);
		await harness.session.resumeUnsentInputs();
		expect(harness.faux.state.callCount).toBe(0);
		expect(
			harness.session.messages.filter((message) => message.role === "user" || message.role === "custom"),
		).toEqual([]);
		fixture.restore();
		expect(fixture.editor.getText()).toBe(draft);
		expect(fixture.warnings).toHaveLength(1);

		// A deliberate operator submission creates a fresh received envelope; no outbox identity crosses it.
		harness.setResponses([fauxAssistantMessage("draft received")]);
		await (
			Reflect.get(InteractiveMode.prototype, "promptWithRecoveredImages") as (
				this: InteractiveMode,
				input: ReturnType<typeof receiveInput>,
			) => Promise<void>
		).call(fixture.mode, receiveInput(draft));
		expect(harness.faux.state.callCount).toBe(1);
		const submitted = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(submitted?.type).toBe("message");
		if (submitted?.type !== "message" || submitted.message.role !== "user")
			throw new Error("Missing fresh user message");
		const submittedText = getMessageText(submitted.message);
		expect(submittedText).toContain("existing editor draft");
		expect(submittedText).toContain("foreign user text");
		expect(submittedText).toContain("foreign custom text");
		expect(submittedText).not.toContain("[recovered image");
		expect(
			Array.isArray(submitted.message.content)
				? submitted.message.content.filter((part) => part.type === "image")
				: [],
		).toEqual([userImage, customImage]);
		expect(submitted.unsentInputId).toBeUndefined();
		expect(submitted.metadata).toBeUndefined();
		expect(submitted.metadataSource).toBeUndefined();
		expect(submitted.provenance?.channel).toBe("terminal");
		expect(submitted.provenance?.turnId).not.toBe(provenance.turnId);
		expect(JSON.stringify(submitted)).not.toContain("foreignSecret");
		expect(fixture.recoveredImages.size).toBe(0);
	});

	// pi#262 / smarty-dev#3155: distinguish a too-small fixture from a cancellation failure.
	it("refuses tiny compaction before entering a hook with the default retained-tail budget", async () => {
		const beforeCompact = vi.fn();
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", beforeCompact);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("original reply")]);
		await harness.session.prompt("already persisted input");
		const entries = harness.sessionManager.getEntries();
		await expect(harness.session.compact()).rejects.toThrow("Nothing to compact (session too small)");
		expect(beforeCompact).not.toHaveBeenCalled();
		expect(harness.sessionManager.getEntries()).toEqual(entries);
		expect(harness.session.agent.getQueuedMessages()).toEqual([]);
	});

	// pi#262 / smarty-dev#3155: actual editor submission -> compaction Escape -> durable quit -> bound replay.
	it("saves input staged during compaction after Escape, then replays once after fresh binding", async () => {
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, images: { autoResize: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						enter();
						await held;
					});
				},
			],
		});
		harnesses.push(harness);
		const fixture = createUiFixture(harness);
		await fixture.bind();
		(Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: InteractiveMode) => void).call(
			fixture.mode,
		);
		const order: string[] = [];
		fixture.stop.mockImplementation(() => order.push("stop"));
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			expect(order).toEqual(["stop"]);
			order.push("exit");
			return undefined as never;
		});
		harness.setResponses([fauxAssistantMessage("original reply")]);
		await harness.session.prompt("already persisted input");
		const file = harness.sessionManager.getSessionFile()!;
		const idleEscape = fixture.defaultEditor.onEscape;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "compaction_start" || event.type === "compaction_end") return fixture.handleEvent(event);
		});
		const compacting = harness.session.compact().catch((error: unknown) => error);
		try {
			await entered;
			expect(harness.session.isCompacting).toBe(true);
			const image: ImageContent = {
				type: "image",
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
			};
			// Model an OS image already recovered into the editor; use the real marker/attachment conversion.
			const stagedText = (
				Reflect.get(InteractiveMode.prototype, "recoveryText") as (
					this: InteractiveMode,
					messages: Array<{ role: "user"; content: ImageContent[]; timestamp: number }>,
				) => string
			).call(fixture.mode, [{ role: "user", content: [image], timestamp: 1 }]);
			if (!fixture.defaultEditor.onSubmit) throw new Error("Editor submit was not installed");
			await fixture.defaultEditor.onSubmit(`staged during compaction\n${stagedText}`);
			fixture.editor.setText("follow-up during compaction");
			await (
				Reflect.get(InteractiveMode.prototype, "handleFollowUp") as (this: InteractiveMode) => Promise<void>
			).call(fixture.mode);
			const staged = Reflect.get(fixture.mode, "compactionQueuedMessages") as Array<{
				input: ReceivedInput;
				mode: "steer" | "followUp";
			}>;
			expect(staged.map(({ input, mode }) => [input.text, mode])).toEqual([
				[`staged during compaction\n${stagedText}`, "steer"],
				["follow-up during compaction", "followUp"],
			]);
			expect(fixture.defaultEditor.onEscape).toBeTypeOf("function");
			expect(fixture.defaultEditor.onEscape).not.toBe(idleEscape);
			fixture.defaultEditor.onEscape?.();
			await compacting;
			await harness.session.waitForIdle();
			expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
			expect(harness.session.isIdle).toBe(true);
			expect(fixture.defaultEditor.onEscape).toBe(idleEscape);
			fixture.editor.setText("existing editor draft");
			const cancelForShutdown = harness.session.cancelForShutdown.bind(harness.session);
			const cancel = vi.spyOn(harness.session, "cancelForShutdown").mockImplementation(() => {
				// Disk visibility, not just an in-memory append, must precede the real cancellation.
				expect(harness.session.shutdownSignal.aborted).toBe(false);
				const readable = SessionManager.open(file);
				expect(
					readable
						.getEntries()
						.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
				).toMatchObject([
					{
						data: {
							message: { content: [{ type: "text", text: "staged during compaction\n" }, image] },
							mode: "steer",
						},
					},
					{
						data: {
							message: { content: [{ type: "text", text: "follow-up during compaction" }] },
							mode: "followUp",
						},
					},
				]);
				expect(readable.getEntries().filter((entry) => entry.unsentInputId)).toEqual([]);
				cancelForShutdown();
			});
			const blocks = captureUnsentStderr();
			await fixture.dispatch("/quit");
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(exit).toHaveBeenCalledWith(0);
			expect(order).toEqual(["stop", "exit"]);
			expect(fixture.stop).toHaveBeenCalledTimes(1);
			expect(blocks).toEqual([]);
			expect(fixture.editor.getText()).toBe("existing editor draft");
			expect(harness.faux.state.callCount).toBe(1);
			const saved = SessionManager.open(file);
			const outboxes = saved
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
			expect(outboxes).toHaveLength(2);
			expect(JSON.stringify(outboxes)).not.toContain("[recovered image");
			expect(JSON.stringify(outboxes)).not.toContain("existing editor draft");
			expect(JSON.stringify(outboxes)).not.toContain("already persisted input");
			expect(saved.getEntries().filter((entry) => entry.unsentInputId)).toEqual([]);
			const resumed = new AgentSession({
				agent: new Agent({
					streamFn: streamSimple,
					convertToLlm,
					initialState: { model: harness.getModel(), tools: [] },
				}),
				sessionManager: saved,
				settingsManager: harness.settingsManager,
				modelRuntime: harness.modelRuntime,
				resourceLoader: harness.resourceLoader,
				cwd: harness.tempDir,
			});
			extraSessions.push(resumed);
			await resumed.bindExtensions({});
			let enterReplay!: () => void;
			const replayEntered = new Promise<void>((resolve) => {
				enterReplay = resolve;
			});
			let releaseReplay!: () => void;
			const replayHeld = new Promise<void>((resolve) => {
				releaseReplay = resolve;
			});
			let firstReplay = true;
			const observeReplay = resumed.agent.subscribe(async (event) => {
				if (event.type !== "message_start" || event.message.role !== "user" || !firstReplay) return;
				firstReplay = false;
				enterReplay();
				await replayHeld;
			});
			harness.setResponses([fauxAssistantMessage("replayed steer"), fauxAssistantMessage("replayed follow-up")]);
			const replaying = resumed.resumeUnsentInputs();
			try {
				await replayEntered;
				expect(
					SessionManager.open(file)
						.getEntries()
						.filter((entry) => entry.unsentInputId),
				).toEqual([]);
				expect(harness.faux.state.callCount).toBe(1);
			} finally {
				releaseReplay();
				await replaying;
				observeReplay();
			}
			for (const outbox of outboxes)
				expect(saved.getEntries().filter((entry) => entry.unsentInputId === outbox.id)).toHaveLength(1);
			expect(
				saved
					.getEntries()
					.filter((entry) => entry.unsentInputId)
					.map((entry) => entry.unsentInputId),
			).toEqual(outboxes.map((entry) => entry.id));
			resumed.dispose();
			const reopened = SessionManager.open(file);
			const second = new AgentSession({
				agent: new Agent({
					streamFn: streamSimple,
					convertToLlm,
					initialState: { model: harness.getModel(), tools: [] },
				}),
				sessionManager: reopened,
				settingsManager: harness.settingsManager,
				modelRuntime: harness.modelRuntime,
				resourceLoader: harness.resourceLoader,
				cwd: harness.tempDir,
			});
			extraSessions.push(second);
			await second.bindExtensions({});
			const calls = harness.faux.state.callCount;
			const count = reopened.getEntryCount();
			await second.resumeUnsentInputs();
			expect(reopened.getEntryCount()).toBe(count);
			expect(harness.faux.state.callCount).toBe(calls);
			expect(second.agent.getQueuedMessages()).toEqual([]);
		} finally {
			unsubscribe();
			release();
			await compacting;
		}
	});

	// pi#262 / smarty-dev#3155: equal revisions in another session do not carry discard authority.
	it("requires new discard consent after the receiving session changes at the same revision", async () => {
		const first = await createHarness({ settings: { compaction: { enabled: false } } });
		const second = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(first, second);
		await first.session.followUp("first session input");
		await second.session.followUp("second session input");
		const fixture = createUiFixture(first);
		const receiver = createUiFixture(second);
		const blocks = captureUnsentStderr();
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		await fixture.dispatch("/quit");
		expect(first.session.queuedInputRevision).toBe(second.session.queuedInputRevision);
		// Change the fixture's real receiver, without changing its consent or either session's queue.
		Reflect.set(fixture.mode, "runtimeHost", receiver.runtime);
		await fixture.dispatch("/quit");
		expect(fixture.warnings).toHaveLength(2);
		expect(blocks).toEqual([]);
		expect(exit).not.toHaveBeenCalled();
		expect(fixture.stop).not.toHaveBeenCalled();
		expect(second.session.shutdownSignal.aborted).toBe(false);
		await fixture.dispatch("/quit");
		expect(blocks).toEqual(["Unsent input (not saved; --no-session):\nsecond session input\n"]);
		expect(exit).toHaveBeenCalledWith(0);
		expect(first.session.agent.getQueuedMessages()).toHaveLength(1);
		expect(first.session.shutdownSignal.aborted).toBe(false);
	});

	// pi#262 / smarty-dev#3155: dequeued input remains owned until admission, including recovered attachments.
	it("saves dequeued and pending envelopes in order without saving the ordinary editor draft", async () => {
		const harness = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		const fixture = createUiFixture(harness);
		await fixture.bind();
		const marker = "[recovered image fixture image/png]";
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "complete-original-bytes" };
		fixture.recoveredImages.set(marker, image);
		const inputs = [receiveInput(`first input ${marker}`), receiveInput("second input")];
		Reflect.set(fixture.mode, "pendingUserInputs", [...inputs]);
		const getReceivedUserInput = Reflect.get(InteractiveMode.prototype, "getReceivedUserInput") as (
			this: InteractiveMode,
		) => Promise<ReceivedInput>;
		expect(await getReceivedUserInput.call(fixture.mode)).toBe(inputs[0]);
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		await fixture.dispatch("/quit");
		const outboxes = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
		expect(outboxes).toHaveLength(2);
		expect(outboxes).toMatchObject([
			{ data: { message: { content: [{ type: "text", text: "first input " }, image] }, mode: "steer" } },
			{ data: { message: { content: [{ type: "text", text: "second input" }] }, mode: "steer" } },
		]);
		expect(JSON.stringify(outboxes)).not.toContain(marker);
		expect(JSON.stringify(outboxes)).not.toContain("existing editor draft");
		expect(Reflect.get(fixture.mode, "pendingUserInputs")).toEqual([]);
		expect(Reflect.get(fixture.mode, "inFlightUserInput")).toBeUndefined();
		expect(exit).toHaveBeenCalledWith(0);
		expect(harness.faux.state.callCount).toBe(0);
	});

	// pi#262 / smarty-dev#3155: outer-flush settlement must not erase a still-admitted detached prompt.
	it("snapshots a detached compaction transfer once alongside its accepted tail and new staging", async () => {
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "detached first") {
							enter();
							await held;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		const fixture = createUiFixture(harness);
		await fixture.bind();
		Reflect.set(fixture.mode, "compactionQueuedMessages", [
			{ input: receiveInput("detached first"), mode: "steer" },
			{ input: receiveInput("accepted tail"), mode: "followUp" },
		]);
		const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: InteractiveMode,
		) => Promise<void>;
		const flushing = flush.call(fixture.mode);
		try {
			await entered;
			await flushing;
			expect(Reflect.get(fixture.mode, "compactionTransferInputs").size).toBe(1);
			const queue = Reflect.get(InteractiveMode.prototype, "queueCompactionMessage") as (
				this: InteractiveMode,
				input: ReceivedInput,
				mode: "steer" | "followUp",
			) => void;
			queue.call(fixture.mode, receiveInput("new staging"), "followUp");
			const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
			await fixture.dispatch("/quit");
			const outboxes = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE);
			expect(outboxes).toHaveLength(3);
			for (const [text, mode] of [
				["detached first", "steer"],
				["accepted tail", "followUp"],
				["new staging", "followUp"],
			]) {
				expect(
					outboxes.filter(
						(entry) => entry.type === "custom" && getMessageText((entry.data as UnsentInput).message) === text,
					),
				).toMatchObject([{ data: { mode } }]);
			}
			expect(Reflect.get(fixture.mode, "compactionTransferInputs").size).toBe(0);
			expect(Reflect.get(fixture.mode, "compactionQueuedMessages")).toEqual([]);
			expect(fixture.errors).toEqual([]);
			expect(exit).toHaveBeenCalledWith(0);
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			release();
			await flushing;
			await Promise.allSettled([...Reflect.get(fixture.mode, "compactionQueueWork")]);
		}
	});

	// pi#262 / smarty-dev#3155: failed persistence must leave both native and mode ownership intact.
	it("refuses quit on save failure without cancelling or clearing input, then permits retry", async () => {
		const harness = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		const fixture = createUiFixture(harness);
		await fixture.bind();
		await harness.session.followUp("native input survives");
		Reflect.set(fixture.mode, "compactionQueuedMessages", [
			{ input: receiveInput("mode input survives"), mode: "steer" },
		]);
		const queued = harness.session.agent.getQueuedMessageOccurrences();
		const entries = harness.sessionManager.getEntries();
		const save = vi.spyOn(harness.sessionManager, "appendCustomEntry").mockImplementation(() => {
			throw new Error("session save unavailable");
		});
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		await fixture.dispatch("/quit");
		expect(fixture.errors).toHaveLength(1);
		expect(fixture.errors[0]).toContain("session save unavailable");
		expect(harness.session.agent.getQueuedMessageOccurrences()).toEqual(queued);
		expect(harness.sessionManager.getEntries()).toEqual(entries);
		expect(Reflect.get(fixture.mode, "compactionQueuedMessages")).toHaveLength(1);
		expect(Reflect.get(fixture.mode, "operatorExitRequested")).toBe(false);
		expect(Reflect.get(fixture.mode, "isShuttingDown")).toBe(false);
		expect(harness.session.shutdownSignal.aborted).toBe(false);
		expect(harness.session.inputsFenced).toBe(false);
		expect(fixture.stop).not.toHaveBeenCalled();
		expect(fixture.drainInput).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
		save.mockRestore();
		await fixture.dispatch("/quit");
		expect(exit).toHaveBeenCalledWith(0);
		expect(harness.session.isDisposed).toBe(true);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === UNSENT_INPUT_TYPE),
		).toHaveLength(2);
	});

	// pi#262 / smarty-dev#3155: an idle quit is not a queued-input refusal or a draft submission.
	it("allows idle quit without retaining the ordinary editor draft", async () => {
		const harness = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		const fixture = createUiFixture(harness);
		await fixture.bind();
		const blocks = captureUnsentStderr();
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		await fixture.dispatch("/quit");
		expect(exit).toHaveBeenCalledWith(0);
		expect(fixture.stop).toHaveBeenCalledTimes(1);
		expect(fixture.warnings).toEqual([]);
		expect(fixture.errors).toEqual([]);
		expect(blocks).toEqual([]);
		expect(harness.session.isDisposed).toBe(true);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});
});
