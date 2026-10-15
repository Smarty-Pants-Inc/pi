import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime, type AgentSessionServices } from "../../../src/core/agent-session-runtime.ts";
import { receiveInput } from "../../../src/core/received-input.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { UNSENT_INPUT_TYPE, type UnsentInput } from "../../../src/core/unsent-input.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

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
	};
	const warnings: string[] = [];
	const errors: string[] = [];
	const recoveredImages = new Map<string, ImageContent>();
	const stop = vi.fn();
	const drainInput = vi.fn(async () => {});
	// Only terminal/UI effects are fixtures. Admission, queues, exit and draft recovery use real code.
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: runtime,
		editor,
		recoveredImages,
		confirmUnsentDiscard: false,
		compactionQueueWork: new Set<Promise<void>>(),
		themeController: { disableAutoSync: vi.fn() },
		ui: { terminal: { drainInput }, requestRender: vi.fn() },
		uiHolds: new Set(),
		stagingAudit: () => {},
		stop,
		showWarning: (message: string) => warnings.push(message),
		showError: (message: string) => errors.push(message),
	}) as InteractiveMode;
	const dispatch = Reflect.get(InteractiveMode.prototype, "dispatchEditorInput") as (
		this: InteractiveMode,
		input: ReturnType<typeof receiveInput>,
	) => Promise<void>;
	const restore = Reflect.get(InteractiveMode.prototype, "restoreUnsentInputDrafts") as (
		this: InteractiveMode,
	) => void;
	return {
		mode,
		runtime,
		editor,
		warnings,
		errors,
		recoveredImages,
		stop,
		drainInput,
		dispatch: (text: string) => dispatch.call(mode, receiveInput(text)),
		restore: () => restore.call(mode),
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
	// smarty-dev#13156: InteractiveMode uses node:fs namespace bindings, not the default object.
	syncBuiltinESMExports();
	return blocks;
}

// smarty-dev#13108 / #QUITBUSY: data safety and foreign-input trust boundaries need real-session coverage.
describe("interactive unsent-input consent and draft recovery", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

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

	// smarty-dev#13156 / pi#262: the explicit discard receipt covers every pending source and occurrence.
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

	// smarty-dev#13156 / pi#262: headless disposal still writes before discarding any input.
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

	// smarty-dev#13156 / pi#262: deferred stderr failure is not a recoverable pre-stop refusal.
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

	// smarty-dev#13156 / pi#262: a signal may upgrade disposal while the TUI is still draining input.
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

	// smarty-dev#13156 / pi#262: preparation publication can fail after buffering but before beforeShutdown.
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
});
