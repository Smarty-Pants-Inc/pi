import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import inputAuthor from "../../examples/extensions/input-author.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { ExtensionFactory, MessageStartEvent } from "../../src/core/extensions/index.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { InteractiveMode, type InteractiveModeOptions } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function author(name: string) {
	return { author: { name, source: "herdr-client", verified: false } };
}

interface EditorReceiver {
	onSubmit?: (text: string) => void | Promise<void>;
	getText(): string;
	setText(text: string): void;
	addToHistory(text: string): void;
	onEscape?: () => void;
}
interface ModeReceiver {
	runtimeHost: { session: Harness["session"] };
	options: InteractiveModeOptions;
	isInitialized: boolean;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	defaultEditor: EditorReceiver;
	editor: EditorReceiver;
	pendingUserInputs: string[];
	userInputInFlight: boolean;
	compactionQueuedMessages: { text: string; mode: "steer" | "followUp" }[];
	compactionQueueTransfers: number;
	userPublicationComponents: Map<string, Component[]>;
	getUserInput(): Promise<unknown>;
	run(): Promise<void>;
	setupEditorSubmitHandler(): void;
	handleFollowUp(): Promise<void>;
	handleEvent(event: AgentSessionEvent): Promise<void>;
	renderSessionEntries(entries: SessionEntry[]): void;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
}

// Use the real interactive receiver methods and real AgentSession/faux provider.
// Only terminal/startup effects are replaced; prompt, queues, compaction and renderers are not mocked.
function createMode(harness: Harness) {
	let text = "";
	const history: string[] = [];
	const errors: unknown[] = [];
	const editor: EditorReceiver = {
		getText: () => text,
		setText: (value) => {
			text = value;
		},
		addToHistory: (value) => {
			history.push(value);
		},
	};
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as ModeReceiver, {
		runtimeHost: { session: harness.session },
		isInitialized: true,
		options: {},
		init: async () => {},
		stagingAudit: () => {},
		chatContainer: new Container(),
		pendingMessagesContainer: new Container(),
		defaultEditor: editor,
		editor,
		pendingUserInputs: [],
		userInputInFlight: false,
		compactionQueuedMessages: [],
		compactionQueueTransfers: 0,
		userPublicationComponents: new Map<string, Component[]>(),
		entriesRenderedByBoundaryCompaction: new Set<string>(),
		pendingTools: new Map(),
		pendingBashComponents: [],
		outputPad: 1,
		hideThinkingBlock: false,
		toolOutputExpanded: false,
		footer: { invalidate: () => {} },
		ui: { requestRender: () => {}, terminal: { setProgress: () => {} } },
		getMarkdownTransformers: () => [],
		showWorkingStatusIndicator: () => {},
		clearStatusIndicator: () => {},
		showStatusIndicator: () => {},
		updateEditorBorderColor: () => {},
		showStatus: () => {},
		showError: (error: unknown) => {
			errors.push(error);
		},
		maybeWarnAboutAnthropicSubscriptionAuth: () => {},
		checkShutdownRequested: async () => {},
	});
	mode.setupEditorSubmitHandler();
	const unsubscribe = harness.session.subscribe((event) => {
		void mode.handleEvent(event).catch((error: unknown) => errors.push(error));
	});
	return { mode, history, errors, unsubscribe, output: () => stripAnsi(mode.chatContainer.render(100).join("\n")) };
}

// pi#4078 / pi#3937: regressions for independent review F1–F3. Buffered input stays excluded (#4979).
describe("direct-prompt-labels review repairs", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});
	async function make(factories: ExtensionFactory[]) {
		const harness = await createHarness({
			extensionFactories: [...factories, inputAuthor],
			persistSession: true,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(harness);
		initTheme("dark");
		return harness;
	}
	function boundedRun(mode: ModeReceiver, count: number) {
		let reads = 0;
		const stop = new Error("bounded receiver finished");
		const original = mode.getUserInput.bind(mode);
		mode.getUserInput = () => (++reads > count ? Promise.reject(stop) : original());
		const run = mode.run().catch((error: unknown) => expect(error).toBe(stop));
		return { run, reads: () => reads };
	}

	it.each([false, true])(
		"F1 freezes the actual waiting callback before two same-dispatch submits (earlier async observer=%s)",
		async (observer) => {
			let latest = "Alice";
			const captures: string[] = [];
			const entered = deferred();
			const release = deferred();
			const finished = deferred();
			const harness = await make([
				(pi) => {
					if (observer)
						pi.on("input_submission", async () => {
							entered.resolve();
							await release.promise;
							finished.resolve();
						});
					pi.on("input_submission", (event) => {
						captures.push(event.text);
						return { metadata: author(latest) };
					});
					pi.on("input", (event) => ({ action: "transform", text: `${event.text} transformed` }));
				},
			]);
			const view = createMode(harness);
			harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			const loop = boundedRun(view.mode, 2);
			await vi.waitFor(() => expect(loop.reads()).toBe(1));
			// No await between the accepts: run() has not resumed from getUserInput().
			const alice = view.mode.defaultEditor.onSubmit?.("alice accepted");
			latest = "Bob";
			const bob = view.mode.defaultEditor.onSubmit?.("bob buffered");
			expect(view.mode.pendingUserInputs).toEqual(["bob buffered"]);
			if (observer) await entered.promise;
			release.resolve();
			await alice;
			await bob;
			await loop.run;
			if (observer) await finished.promise;
			const starts = harness.eventsOfType("message_start").filter((event) => event.message.role === "user");
			console.info(
				"F1 waiting trace",
				JSON.stringify({
					observer,
					captures,
					authors: starts.map((event) => event.input?.metadata?.author ?? null),
					texts: getUserTexts(harness),
				}),
			);
			expect(starts.map((event) => event.input?.metadata)).toEqual([author("Alice"), undefined]);
			expect(captures).toEqual(["alice accepted"]);
			expect(getUserTexts(harness)).toEqual(["alice accepted transformed", "bob buffered transformed"]);
			expect(view.output().match(/Alice:|Bob:/g)).toEqual(["Alice:"]);
			expect(JSON.stringify(harness.session.messages)).not.toMatch(/Alice|Bob|metadata/);
			expect(view.errors).toEqual([]);
			view.unsubscribe();
		},
	);

	it("F1 invokes the later synchronous SDK reader before an earlier held observer and detaches explicit metadata at entry", async () => {
		let latest = "Alice";
		const entered = deferred();
		const release = deferred();
		const finished = deferred();
		const harness = await make([
			(pi) => {
				pi.on("input_submission", async () => {
					entered.resolve();
					await release.promise;
					finished.resolve();
				});
				pi.on("input_submission", () => ({ metadata: author(latest) }));
				pi.on("input", async () => {
					await release.promise;
				});
			},
		]);
		const metadata = { stable: { value: "SDK explicit" } };
		harness.setResponses([fauxAssistantMessage("reply")]);
		const prompt = harness.session.prompt("sdk", { source: "rpc", metadata });
		await entered.promise;
		latest = "Bob";
		metadata.stable.value = "mutated";
		release.resolve();
		await finished.promise;
		await prompt;
		const start = harness.eventsOfType("message_start").find((event) => event.message.role === "user");
		expect(start?.input).toEqual({
			source: "rpc",
			metadata: { stable: { value: "SDK explicit" }, ...author("Alice") },
		});
	});

	it("F1 detaches explicit SDK metadata before an unknown slash command lookup yields", async () => {
		const harness = await make([]);
		const metadata = author("SDK Alice");
		harness.setResponses([fauxAssistantMessage("reply")]);
		const prompt = harness.session.prompt("/unknown-template text", { source: "rpc", metadata });
		metadata.author.name = "Late Bob";
		await prompt;
		const start = harness.eventsOfType("message_start").find((event) => event.message.role === "user");
		expect(start?.input?.metadata).toEqual(author("SDK Alice"));
		expect(getUserTexts(harness)).toEqual(["/unknown-template text"]);
	});

	it("F1 fails closed for asynchronous latest-author results and observes rejection", async () => {
		let latest = "Alice";
		const release = deferred();
		const finished = deferred();
		const harness = await make([
			(pi) => {
				pi.on("input_submission", async () => {
					await release.promise;
					finished.resolve();
					return { metadata: author(latest) };
				});
				pi.on("input_submission", () => Promise.reject(new Error("lookup rejected")));
				pi.on("input", async () => {
					await release.promise;
				});
			},
		]);
		const errors: string[] = [];
		harness.session.extensionRunner.onError((event) => errors.push(event.error));
		harness.setResponses([fauxAssistantMessage("reply")]);
		const prompt = harness.session.prompt("sdk", { source: "rpc", metadata: author("Explicit SDK") });
		latest = "Bob";
		release.resolve();
		await finished.promise;
		await prompt;
		expect(
			harness.eventsOfType("message_start").find((event) => event.message.role === "user")?.input?.metadata,
		).toEqual(author("Explicit SDK"));
		expect(errors).toEqual(["lookup rejected"]);
	});

	it.each(["start", "end", "persistence"] as const)(
		"F2 expires a failed %s ID before the original native object is queued and replayed",
		async (failure) => {
			const harness = await make([]);
			let original: MessageStartEvent["message"] | undefined;
			let reserved: string | undefined;
			let failed = false;
			let rollbackCapableAtEnd: boolean | undefined;
			const originalError = new Error(`${failure} refused`);
			const rollback: string[] = [];
			// A throwing rollback observer must not block any later observer or either live view.
			const offFirst = harness.session.subscribe((event) => {
				if (event.type === "user_message_publication_failed") throw new Error("rollback observer refused");
			});
			const view = createMode(harness);
			const otherView = createMode(harness);
			const off = harness.session.subscribe((event) => {
				if (event.type === "message_start" && event.message.role === "user" && !original) {
					original = event.message;
					reserved = event.entryId;
				}
				if (event.type === "message_end" && event.message.role === "user" && !failed) {
					// End publication is not successful persistence. Components must still be rollback-capable.
					rollbackCapableAtEnd = view.mode.userPublicationComponents.has(reserved ?? "");
				}
				if (!failed && event.type === `message_${failure}` && "message" in event && event.message.role === "user") {
					failed = true;
					throw originalError;
				}
			});
			const offRollback = harness.session.subscribe((event) => {
				if (event.type === "user_message_publication_failed") rollback.push(event.entryId);
			});
			const append = harness.sessionManager.appendMessage.bind(harness.sessionManager);
			const spy =
				failure === "persistence"
					? vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message, id) => {
							if (!failed && message === original) {
								failed = true;
								throw originalError;
							}
							return append(message, id);
						})
					: undefined;
			await harness.session.prompt("failed same", { metadata: author("Orphan Alice") });
			spy?.mockRestore();
			off();
			offFirst();
			if (!original || !reserved) throw new Error("Expected exact direct object and ID");
			const errorPreserved = harness.session.messages.some(
				(message) => message.role === "assistant" && message.errorMessage === originalError.message,
			);
			const liveOrphan = view.output().includes("Orphan Alice:");
			const otherLiveOrphan = otherView.output().includes("Orphan Alice:");
			const pendingComponents = view.mode.userPublicationComponents.size;
			const persistedUser = harness.sessionManager.getEntry(reserved) !== undefined;
			const file = harness.sessionManager.getSessionFile();
			if (!file) throw new Error("Expected durable JSONL");
			view.mode.chatContainer.clear();
			view.mode.renderSessionEntries(SessionManager.open(file).buildContextEntries());
			const replayOrphan = view.output().includes("Orphan Alice:");
			harness.session.agent.steer(original);
			harness.setResponses([fauxAssistantMessage("fresh reply"), fauxAssistantMessage("redelivered reply")]);
			await harness.session.prompt("fresh direct", { metadata: author("Fresh Carol") });
			const users = harness.eventsOfType("message_start").filter((event) => event.message.role === "user");
			view.mode.chatContainer.clear();
			view.mode.renderSessionEntries(SessionManager.open(file).buildContextEntries());
			const queuedReplayOrphan = view.output().includes("Orphan Alice:");
			console.info(
				"F2 terminal trace",
				JSON.stringify({
					failure,
					errorPreserved,
					liveOrphan,
					otherLiveOrphan,
					replayOrphan,
					persistedUser,
					rollbackCount: rollback.length,
					rollbackCapableAtEnd,
					exactObject: users.at(-1)?.message === original,
					queuedInput: users.at(-1)?.input ?? null,
					queuedReplayOrphan,
				}),
			);
			expect(users.at(-1)?.message).toBe(original);
			expect(users.at(-1)?.input).toBeUndefined();
			expect(queuedReplayOrphan).toBe(false);
			expect(harness.sessionManager.getEntry(reserved)).toBeUndefined();
			expect(errorPreserved).toBe(true);
			expect(rollback).toEqual([reserved]);
			if (failure !== "start") expect(rollbackCapableAtEnd).toBe(true);
			expect(liveOrphan).toBe(false);
			expect(otherLiveOrphan).toBe(false);
			expect(replayOrphan).toBe(false);
			expect(persistedUser).toBe(false);
			expect(pendingComponents).toBe(0);
			expect(view.output()).not.toContain("Orphan Alice:");
			expect(view.output()).toContain("Fresh Carol:");
			expect(view.mode.userPublicationComponents.size).toBe(0);
			expect(view.errors).toEqual([]);
			expect(otherView.errors).toEqual([]);
			offRollback();
			view.unsubscribe();
			otherView.unsubscribe();
		},
	);

	it("F3 excludes CLI initialMessage and initialMessages, preserves startup buffering and labels the next waiting callback", async () => {
		let latest = "Startup Bob";
		const captures: string[] = [];
		const inputs: { text: string; source: string; metadata: unknown }[] = [];
		const harness = await make([
			(pi) => {
				pi.on("input_submission", (event) => {
					captures.push(event.text);
					return { metadata: author(latest) };
				});
				pi.on("input", (event) => {
					inputs.push({ text: event.text, source: event.source, metadata: event.metadata });
				});
			},
		]);
		const view = createMode(harness);
		view.mode.options = { initialMessage: "CLI initial", initialMessages: ["CLI second", "CLI third"] };
		await view.mode.defaultEditor.onSubmit?.("Bob during startup");
		harness.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("reply")));
		const loop = boundedRun(view.mode, 2);
		await vi.waitFor(() => expect(loop.reads()).toBe(2));
		latest = "Fresh Alice";
		await view.mode.defaultEditor.onSubmit?.("fresh accepted");
		await loop.run;
		expect(getUserTexts(harness)).toEqual([
			"CLI initial",
			"CLI second",
			"CLI third",
			"Bob during startup",
			"fresh accepted",
		]);
		console.info(
			"F3 startup trace",
			JSON.stringify({
				captures,
				authors: inputs.map((input) => input.metadata ?? null),
				sources: inputs.map((input) => input.source),
				texts: getUserTexts(harness),
			}),
		);
		expect(captures).toEqual(["fresh accepted"]);
		expect(inputs.map((input) => input.source)).toEqual(Array(5).fill("interactive"));
		expect(inputs.map((input) => input.metadata)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			author("Fresh Alice"),
		]);
		expect(view.output().match(/Startup Bob:|Fresh Alice:/g)).toEqual(["Fresh Alice:"]);
		expect(JSON.stringify(harness.session.messages)).not.toMatch(/Startup Bob|Fresh Alice|metadata/);
		expect(view.errors).toEqual([]);
		view.unsubscribe();
	});
});
