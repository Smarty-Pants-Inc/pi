import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import inputAuthor from "../../examples/extensions/input-author.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { ExtensionFactory, InputSubmissionEvent, MessageStartEvent } from "../../src/core/extensions/index.ts";
import { type CustomEntry, type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

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
	getUserInput(): Promise<string>;
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

// pi#4078 / pi#3937; the queued/staged feature is deliberately excluded (smarty-dev#4979).
describe("direct labels at interactive receivers", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});
	async function make(extensionFactories: ExtensionFactory[], persistSession = false) {
		const harness = await createHarness({
			extensionFactories: [...extensionFactories, inputAuthor],
			persistSession,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } },
		});
		harnesses.push(harness);
		initTheme("dark");
		return harness;
	}

	it("runs idle onSubmit -> getUserInput -> run -> prompt with visible authors and unchanged content", async () => {
		let name: string | undefined = "Alice";
		const captures: InputSubmissionEvent[] = [];
		const harness = await make([
			(pi) => {
				pi.on("input_submission", (event) => {
					captures.push(event);
					return name ? { metadata: author(name) } : undefined;
				});
			},
		]);
		const view = createMode(harness);
		harness.setResponses([
			fauxAssistantMessage("reply one"),
			fauxAssistantMessage("reply two"),
			fauxAssistantMessage("reply three"),
		]);
		const stop = new Error("bounded interactive loop finished");
		const settled = deferred();
		let reads = 0;
		const originalGet = view.mode.getUserInput.bind(view.mode);
		view.mode.getUserInput = () => {
			if (++reads === 4) {
				settled.resolve();
				return Promise.reject(stop);
			}
			return originalGet();
		};
		const run = view.mode.run().catch((error: unknown) => {
			expect(error).toBe(stop);
		});
		await vi.waitFor(() => expect(reads).toBe(1));
		await view.mode.defaultEditor.onSubmit?.("same");
		await vi.waitFor(() => expect(reads).toBe(2));
		name = "Bob";
		await view.mode.defaultEditor.onSubmit?.("same");
		await vi.waitFor(() => expect(reads).toBe(3));
		name = undefined;
		await view.mode.defaultEditor.onSubmit?.("anonymous");
		await settled.promise;
		await run;
		expect(getUserTexts(harness)).toEqual(["same", "same", "anonymous"]);
		expect(captures.map((event) => event.text)).toEqual(["same", "same", "anonymous"]);
		expect(view.output()).toMatch(
			/Alice:[\s\S]*same[\s\S]*reply one[\s\S]*Bob:[\s\S]*same[\s\S]*reply two[\s\S]*anonymous/,
		);
		expect(view.output().match(/Alice:|Bob:/g)).toEqual(["Alice:", "Bob:"]);
		expect(JSON.stringify(harness.session.messages)).not.toMatch(/Alice|Bob|metadata/);
		expect(view.errors).toEqual([]);
		view.unsubscribe();
	});

	// smarty-dev#4979: normal Enter accepted during held preflight is buffered, not a fresh idle submission.
	it("run excludes buffered normal Enter from capture while preserving Alice and the next fresh Carol", async () => {
		let name = "Alice";
		const captures: string[] = [];
		const starts: MessageStartEvent[] = [];
		const inputs: { text: string; source: string; metadata: unknown; idle: boolean }[] = [];
		const entered = deferred();
		const release = deferred();
		const harness = await make([
			(pi) => {
				pi.on("input_submission", (event) => {
					captures.push(event.text);
					return { metadata: author(name) };
				});
				pi.on("input", async (event, ctx) => {
					inputs.push({ text: event.text, source: event.source, metadata: event.metadata, idle: ctx.isIdle() });
					if (event.text === "alice direct") {
						entered.resolve();
						await release.promise;
					}
				});
				pi.on("message_start", (event) => {
					if (event.message.role === "user") starts.push(event);
				});
			},
		]);
		const view = createMode(harness);
		harness.setResponses([
			fauxAssistantMessage("alice reply"),
			fauxAssistantMessage("bob reply"),
			fauxAssistantMessage("carol reply"),
		]);
		const stop = new Error("bounded buffered interactive loop finished");
		let reads = 0;
		const originalGet = view.mode.getUserInput.bind(view.mode);
		view.mode.getUserInput = () => (++reads === 4 ? Promise.reject(stop) : originalGet());
		const run = view.mode.run().catch((error: unknown) => {
			expect(error).toBe(stop);
		});
		try {
			await vi.waitFor(() => expect(reads).toBe(1));
			await view.mode.defaultEditor.onSubmit?.("alice direct");
			await entered.promise;
			expect(harness.session.isStreaming).toBe(false);
			expect(harness.session.isPromptPending).toBe(true);
			name = "Bob";
			await view.mode.defaultEditor.onSubmit?.("buffered bob");
			expect(view.mode.pendingUserInputs).toEqual(["buffered bob"]);
			expect(captures).toEqual(["alice direct"]);
			name = "Carol";
		} finally {
			release.resolve();
		}
		await vi.waitFor(() => expect(reads).toBe(3));
		expect(view.mode.pendingUserInputs).toEqual([]);
		await view.mode.defaultEditor.onSubmit?.("fresh carol");
		await run;
		expect(getUserTexts(harness)).toEqual(["alice direct", "buffered bob", "fresh carol"]);
		expect(captures).toEqual(["alice direct", "fresh carol"]);
		expect(starts.map((event) => event.input?.metadata)).toEqual([author("Alice"), undefined, author("Carol")]);
		expect(starts[1]?.entryId).toBeUndefined();
		expect(inputs).toEqual([
			{ text: "alice direct", source: "interactive", metadata: author("Alice"), idle: true },
			{ text: "buffered bob", source: "interactive", metadata: undefined, idle: true },
			{ text: "fresh carol", source: "interactive", metadata: author("Carol"), idle: true },
		]);
		expect(view.output()).toMatch(/Alice:[\s\S]*alice direct[\s\S]*buffered bob[\s\S]*Carol:[\s\S]*fresh carol/);
		expect(view.output().match(/Alice:|Bob:|Carol:/g)).toEqual(["Alice:", "Carol:"]);
		expect(view.history).toEqual(["alice direct", "buffered bob", "fresh carol"]);
		expect(JSON.stringify(harness.session.messages)).not.toMatch(/Alice|Bob|Carol|metadata/);
		expect(view.errors).toEqual([]);
		view.unsubscribe();
	});

	// smarty-dev#4979: the same pending string queue can already contain input before run starts.
	it("run excludes pending startup input and clears the exclusion for a fresh waiting callback", async () => {
		const captures: string[] = [];
		const starts: MessageStartEvent[] = [];
		const harness = await make([
			(pi) => {
				pi.on("input_submission", (event) => {
					captures.push(event.text);
					return { metadata: author("Fresh Alice") };
				});
				pi.on("message_start", (event) => {
					if (event.message.role === "user") starts.push(event);
				});
			},
		]);
		const view = createMode(harness);
		harness.setResponses([fauxAssistantMessage("startup reply"), fauxAssistantMessage("fresh reply")]);
		await view.mode.defaultEditor.onSubmit?.("pending startup");
		expect(view.mode.pendingUserInputs).toEqual(["pending startup"]);
		expect(captures).toEqual([]);
		const stop = new Error("bounded startup interactive loop finished");
		let reads = 0;
		const originalGet = view.mode.getUserInput.bind(view.mode);
		view.mode.getUserInput = () => (++reads === 3 ? Promise.reject(stop) : originalGet());
		const run = view.mode.run().catch((error: unknown) => {
			expect(error).toBe(stop);
		});
		await vi.waitFor(() => expect(reads).toBe(2));
		await view.mode.defaultEditor.onSubmit?.("fresh direct");
		await run;
		expect(getUserTexts(harness)).toEqual(["pending startup", "fresh direct"]);
		expect(captures).toEqual(["fresh direct"]);
		expect(starts.map((event) => event.input?.metadata)).toEqual([undefined, author("Fresh Alice")]);
		expect(starts[0]?.entryId).toBeUndefined();
		expect(view.output().match(/Fresh Alice:/g)).toEqual(["Fresh Alice:"]);
		expect(view.errors).toEqual([]);
		view.unsubscribe();
	});

	// smarty-dev#4979: the buffered-delivery option suppresses explicit metadata as well as the capture hook.
	it("suppression ignores explicit metadata without changing input source or ordinary input handlers", async () => {
		const captures: string[] = [];
		const inputs: { source: string; metadata: unknown }[] = [];
		const starts: MessageStartEvent[] = [];
		const harness = await make([
			(pi) => {
				pi.on("input_submission", (event) => {
					captures.push(event.text);
					return { metadata: author("Hook Alice") };
				});
				pi.on("input", (event) => {
					inputs.push({ source: event.source, metadata: event.metadata });
				});
				pi.on("message_start", (event) => {
					if (event.message.role === "user") starts.push(event);
				});
			},
		]);
		const view = createMode(harness);
		harness.setResponses([fauxAssistantMessage("buffered reply"), fauxAssistantMessage("direct reply")]);
		await harness.session.prompt("buffered", {
			source: "rpc",
			metadata: author("Explicit Bob"),
			suppressInputMetadata: true,
		});
		await harness.session.prompt("direct", { source: "rpc", metadata: author("Explicit Carol") });
		expect(captures).toEqual(["direct"]);
		expect(inputs).toEqual([
			{ source: "rpc", metadata: undefined },
			{ source: "rpc", metadata: author("Hook Alice") },
		]);
		expect(starts[0]?.input).toBeUndefined();
		expect(starts[0]?.entryId).toBeUndefined();
		expect(starts[1]?.input?.source).toBe("rpc");
		expect(view.output().match(/Explicit Bob:|Explicit Carol:|Hook Alice:/g)).toEqual(["Hook Alice:"]);
		expect(view.errors).toEqual([]);
		view.unsubscribe();
	});

	it("manual successful compaction flushes its FIRST idle prompt and siblings without labels, then a direct prompt labels", async () => {
		let name: string | undefined;
		const captures: string[] = [];
		const starts: MessageStartEvent[] = [];
		const entered = deferred();
		const release = deferred();
		const harness = await make(
			[
				(pi) => {
					pi.on("input_submission", (event) => {
						captures.push(event.text);
						return name ? { metadata: author(name) } : undefined;
					});
					pi.on("message_start", (event) => {
						if (event.message.role === "user") starts.push(event);
					});
				},
			],
			true,
		);
		const view = createMode(harness);
		harness.setResponses([fauxAssistantMessage("seed reply")]);
		await harness.session.prompt("seed");
		captures.length = 0;
		starts.length = 0;
		name = "Wrong latest author";
		harness.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("manual summary");
			},
			fauxAssistantMessage("first staged reply"),
			fauxAssistantMessage("tail staged reply"),
			fauxAssistantMessage("direct reply"),
		]);
		const compact = harness.session.compact();
		await entered.promise;
		expect(harness.session.isCompacting).toBe(true);
		await view.mode.defaultEditor.onSubmit?.("first staged");
		view.mode.editor.setText("tail staged");
		await view.mode.handleFollowUp();
		expect(view.mode.compactionQueuedMessages.map((entry) => entry.text)).toEqual(["first staged", "tail staged"]);
		release.resolve();
		const result = await compact;
		expect(result.summary).toContain("manual summary");
		await vi.waitFor(() => {
			expect(view.mode.compactionQueueTransfers).toBe(0);
			expect(harness.session.isIdle).toBe(true);
		});
		expect(starts.map((event) => event.input)).toEqual([undefined, undefined]);
		expect(getUserTexts(harness)).toContain("first staged");
		expect(getUserTexts(harness)).toContain("tail staged");
		expect(captures).toEqual([]);
		expect(view.output()).not.toContain("Wrong latest author:");
		name = "Direct Alice";
		await harness.session.prompt("direct next");
		expect(captures).toEqual(["direct next"]);
		expect(view.output()).toContain("Direct Alice:");
		expect(view.errors).toEqual([]);
		view.unsubscribe();
	});

	it.each([false, true])("real staged flush receiver leaves no label with willRetry=%s", async (willRetry) => {
		const captures: string[] = [];
		const starts: MessageStartEvent[] = [];
		const harness = await make([
			(pi) => {
				pi.on("input_submission", (event) => {
					captures.push(event.text);
					return { metadata: author("Alice") };
				});
				pi.on("message_start", (event) => {
					if (event.message.role === "user") starts.push(event);
				});
			},
		]);
		const view = createMode(harness);
		if (willRetry) {
			const entered = deferred();
			const release = deferred();
			harness.setResponses([
				async () => {
					entered.resolve();
					await release.promise;
					return fauxAssistantMessage("one");
				},
				fauxAssistantMessage("two"),
			]);
			const run = harness.session.prompt("direct");
			await entered.promise;
			view.mode.compactionQueuedMessages.push({ text: "queued first", mode: "steer" });
			await view.mode.flushCompactionQueue({ willRetry });
			release.resolve();
			await run;
			expect(starts.map((event) => event.input?.metadata?.author)).toEqual([author("Alice").author, undefined]);
			expect(captures).toEqual(["direct"]);
		} else {
			harness.setResponses([fauxAssistantMessage("one")]);
			view.mode.compactionQueuedMessages.push({ text: "queued first", mode: "steer" });
			await view.mode.flushCompactionQueue({ willRetry });
			await vi.waitFor(() => expect(view.mode.compactionQueueTransfers).toBe(0));
			expect(starts[0]?.input).toBeUndefined();
			expect(captures).toEqual([]);
		}
		expect(getUserTexts(harness)).toContain("queued first");
		expect(view.errors).toEqual([]);
		view.unsubscribe();
	});

	it("replays only bound targets after reload, branch selection and fork; never a forward orphan", async () => {
		const harness = await make([], true);
		const view = createMode(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await harness.session.prompt("same", { metadata: author("Alice") });
		const firstLeaf = harness.sessionManager.getLeafId();
		if (!firstLeaf) throw new Error("Expected first leaf");
		await harness.session.prompt("same", { metadata: author("Bob") });
		const file = harness.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected file");
		const replay = SessionManager.open(file);
		view.mode.chatContainer.clear();
		view.mode.renderSessionEntries(replay.buildContextEntries());
		expect(view.output().match(/Alice:|Bob:/g)).toEqual(["Alice:", "Bob:"]);
		replay.branch(firstLeaf);
		view.mode.chatContainer.clear();
		view.mode.renderSessionEntries(replay.buildContextEntries());
		expect(view.output()).toContain("Alice:");
		expect(view.output()).not.toContain("Bob:");
		const bobEntry = harness.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "input-author" &&
					(entry.data as { author: { name: string } }).author.name === "Bob",
			);
		if (!bobEntry) throw new Error("Expected bound Bob entry");
		replay.branch(bobEntry.id);
		view.mode.chatContainer.clear();
		view.mode.renderSessionEntries(replay.buildContextEntries());
		expect(view.output()).not.toContain("Bob:");
		replay.createBranchedSession(bobEntry.id);
		view.mode.chatContainer.clear();
		view.mode.renderSessionEntries(replay.buildContextEntries());
		expect(view.output()).not.toContain("Bob:");
		const replacement = replay.appendMessage({ role: "user", content: "same", timestamp: Date.now() });
		expect(replacement).not.toBe((bobEntry as CustomEntry).beforeMessageId);
		view.mode.chatContainer.clear();
		view.mode.renderSessionEntries(replay.buildContextEntries());
		expect(view.output()).not.toContain("Bob:");
		expect(view.errors).toEqual([]);
		view.unsubscribe();
	});

	it.each(["before", "after"] as const)(
		"rolls back labels when a %s-UI publication observer throws; next input cannot inherit",
		async (order) => {
			const harness = await make([]);
			let failed = false;
			const listener = (event: AgentSessionEvent) => {
				if (event.type === "message_start" && event.message.role === "user" && !failed) {
					failed = true;
					throw new Error("publication failed");
				}
			};
			const before = order === "before" ? harness.session.subscribe(listener) : undefined;
			const view = createMode(harness);
			const after = order === "after" ? harness.session.subscribe(listener) : undefined;
			// Native Agent converts observer failures into a finalized error assistant message.
			await harness.session.prompt("failed", { metadata: author("Never inherit") });
			expect(
				harness.session.messages.some(
					(message) => message.role === "assistant" && message.errorMessage === "publication failed",
				),
			).toBe(true);
			expect(view.output()).not.toContain("Never inherit:");
			before?.();
			after?.();
			harness.setResponses([fauxAssistantMessage("next reply")]);
			await harness.session.prompt("next");
			view.mode.chatContainer.clear();
			view.mode.renderSessionEntries(harness.sessionManager.buildContextEntries());
			expect(view.output()).not.toContain("Never inherit:");
			expect(view.output()).toContain("next");
			expect(view.errors).toEqual([]);
			view.unsubscribe();
		},
	);

	it("a retained direct user keeps its label across compaction, without retaining labels for summarized users", async () => {
		const harness = await make([], true);
		const view = createMode(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("summarized user", { metadata: author("Alice") });
		await harness.session.prompt("kept user", { metadata: author("Bob") });
		const kept = harness.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					getMessageText(entry.message) === "kept user",
			);
		if (!kept) throw new Error("Expected retained native user entry");
		harness.sessionManager.appendCompaction("summary", kept.id, 100);
		view.mode.chatContainer.clear();
		view.mode.renderSessionEntries(harness.sessionManager.buildContextEntries());
		expect(view.output()).toContain("Bob:");
		expect(view.output()).not.toContain("Alice:");
		expect(JSON.stringify(harness.sessionManager.buildSessionContext())).not.toMatch(/Alice|Bob/);
		view.unsubscribe();
	});

	it("observer edits cannot redirect a later renderer's bound identity or sender data", async () => {
		const harness = await make([]);
		const observed: MessageStartEvent[] = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "message_start" || event.message.role !== "user") return;
			event.entryId = "earlier-entry";
			if (event.input?.metadata) event.input.metadata.author = author("Wrong author").author;
		});
		const view = createMode(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") observed.push(event);
		});
		harness.setResponses([fauxAssistantMessage("reply")]);
		await harness.session.prompt("direct", { metadata: author("Alice") });
		expect(view.output()).toContain("Alice:");
		expect(view.output()).not.toContain("Wrong author:");
		expect(observed[0]?.entryId).not.toBe("earlier-entry");
		expect(observed[0]?.input?.metadata).toEqual(author("Alice"));
		unsubscribe();
		view.unsubscribe();
	});

	it("failed publication's exact message object can be redelivered without inheriting the orphan label", async () => {
		const harness = await make([]);
		let original: MessageStartEvent["message"] | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user" && !original) {
				original = event.message;
				throw new Error("failed original");
			}
		});
		const view = createMode(harness);
		await harness.session.prompt("same", { metadata: author("Never inherit") });
		unsubscribe();
		if (!original) throw new Error("Expected original native message object");
		harness.setResponses([fauxAssistantMessage("redelivered")]);
		await harness.session.agent.prompt(original);
		view.mode.chatContainer.clear();
		view.mode.renderSessionEntries(harness.sessionManager.buildContextEntries());
		expect(view.output()).toContain("same");
		expect(view.output()).not.toContain("Never inherit:");
		expect(view.errors).toEqual([]);
		view.unsubscribe();
	});

	it("example rejects unsupported metadata and sanitizes controls both at ingestion and replay", async () => {
		const harness = await make([]);
		const renderer = harness.session.extensionRunner.getEntryRenderer("input-author");
		if (!renderer) throw new Error("Expected renderer");
		const invalid = [
			undefined,
			null,
			[],
			{},
			{ author: null },
			{ author: [] },
			{ author: { name: 1 } },
			{ author: { name: "Mallory", source: "unknown", verified: false } },
			{ author: { name: "Mallory", source: "herdr-client", verified: true } },
			author("\u001b\u0000\n\r\u202e"),
		];
		const entry = (data: unknown): CustomEntry => ({
			type: "custom",
			customType: "input-author",
			id: "label",
			parentId: null,
			timestamp: new Date().toISOString(),
			data,
		});
		for (const data of invalid) expect(renderer(entry(data), { expanded: false }, theme)).toBeUndefined();
		const hostile = "Alice\u001b[2J\u0007\n\r\u009b\u202e\u2028Bob";
		const rendered = renderer(entry(author(hostile)), { expanded: false }, theme)
			?.render(100)
			.join("\n");
		expect(stripAnsi(rendered ?? "")).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
		const view = createMode(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("safe", { source: "rpc", metadata: author(hostile) });
		const custom = harness.sessionManager.getEntries().find((value) => value.type === "custom");
		expect(JSON.stringify(custom)).not.toContain("\\u001b");
		expect(view.errors).toEqual([]);
		view.unsubscribe();
	});
});
