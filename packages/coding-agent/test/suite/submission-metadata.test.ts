import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import inputAuthor from "../../examples/extensions/input-author.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI, InputSubmission } from "../../src/index.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

type Author = { name: string; source: "herdr-client"; verified: false };
function renderNativeTranscript(harness: Harness): string {
	const chatContainer = new Container();
	const context = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		chatContainer,
		pendingTools: new Map(),
		toolOutputExpanded: false,
		outputPad: 0,
		hideThinkingBlock: false,
		getMarkdownTransformers: () => [],
		ui: { requestRender: () => {} },
	});
	const renderEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
		this: typeof context,
		entries: ReturnType<SessionManager["buildContextEntries"]>,
	) => void;
	renderEntries.call(context, harness.sessionManager.buildContextEntries());
	return stripAnsi(chatContainer.render(100).join("\n"));
}

function gate(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function author(name: string): Author {
	return { name, source: "herdr-client", verified: false };
}

// Regression coverage for Smarty-Pants-Inc/smarty-dev#4078.
describe("submission metadata", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()!.cleanup();
	});

	it("binds duplicate reverse-drained follow-up and steering authors to their own native messages", async () => {
		const toolStarted = gate();
		const toolRelease = gate();
		let currentAuthor: Author | undefined;
		const captured: Array<{ text: string; mode?: string; author?: unknown }> = [];
		const started: Array<{ text: string; input?: InputSubmission }> = [];
		const publication: string[] = [];
		const providerUsers: string[][] = [];
		const providerContexts: string[] = [];
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Hold the assistant turn for queued submissions",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted.release();
				await toolRelease.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("input_submission", (event) => {
						const submittedAuthor = event.source === "interactive" ? currentAuthor : undefined;
						captured.push({ text: event.text, mode: event.streamingBehavior, author: submittedAuthor });
						return { metadata: submittedAuthor ? { author: submittedAuthor } : undefined };
					});
					pi.on("message_start", (event) => {
						if (event.message.role !== "user") return;
						const input = event.input;
						started.push({ text: getMessageText(event.message), input });
						if (input?.metadata?.author) pi.appendEntry("input-author", { author: input.metadata.author });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (
				event.type === "entry_appended" &&
				event.entry.type === "custom" &&
				event.entry.customType === "input-author"
			) {
				const data = event.entry.data as { author: Author };
				publication.push(`author:${data.author.name}`);
			} else if (event.type === "message_start" && event.message.role === "user") {
				publication.push(`user:${getMessageText(event.message)}`);
			}
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				providerUsers.push(context.messages.filter((message) => message.role === "user").map(getMessageText));
				providerContexts.push(JSON.stringify(context));
				return fauxAssistantMessage("handled steering");
			},
			(context) => {
				providerUsers.push(context.messages.filter((message) => message.role === "user").map(getMessageText));
				providerContexts.push(JSON.stringify(context));
				return fauxAssistantMessage("handled follow-up");
			},
		]);
		const prompt = harness.session.prompt("start", { source: "interactive" });
		await toolStarted.promise;
		try {
			currentAuthor = author("Alice");
			await harness.session.followUp("same", undefined, { source: "interactive" });
			currentAuthor = author("Bob");
			await harness.session.steer("same", undefined, { source: "interactive" });
			currentAuthor = author("Later typist");
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
		} finally {
			toolRelease.release();
			await prompt;
		}

		expect(getUserTexts(harness)).toEqual(["start", "same", "same"]);
		expect(providerUsers).toEqual([
			["start", "same"],
			["start", "same", "same"],
		]);
		for (const context of providerContexts) {
			expect(context).not.toMatch(/Alice|Bob|Later typist|herdr-client|input-author|metadata|verified/);
		}
		expect.soft(captured).toEqual([
			{ text: "start", mode: undefined, author: undefined },
			{ text: "same", mode: "followUp", author: author("Alice") },
			{ text: "same", mode: "steer", author: author("Bob") },
		]);
		expect.soft(started.filter((item) => item.text === "same").map((item) => item.input)).toEqual([
			{ source: "interactive", metadata: { author: author("Bob") } },
			{ source: "interactive", metadata: { author: author("Alice") } },
		]);
		expect.soft(publication).toEqual(["user:start", "author:Bob", "user:same", "author:Alice", "user:same"]);
		const entries = harness.sessionManager.getEntries();
		const associatedAuthors = entries.flatMap((entry, index) => {
			if (entry.type !== "message" || entry.message.role !== "user" || getMessageText(entry.message) !== "same")
				return [];
			const previous = entries[index - 1];
			return [
				{
					type: previous?.type,
					customType: previous?.type === "custom" ? previous.customType : undefined,
					data: previous?.type === "custom" ? previous.data : undefined,
					parentId: entry.parentId,
					previousId: previous?.id,
				},
			];
		});
		expect.soft(associatedAuthors).toMatchObject([
			{ type: "custom", customType: "input-author", data: { author: author("Bob") } },
			{ type: "custom", customType: "input-author", data: { author: author("Alice") } },
		]);
		for (const associated of associatedAuthors) expect(associated.parentId).toBe(associated.previousId);
	});

	it("shallow-merges submission metadata and preserves it through chained input transformations", async () => {
		const observed: unknown[] = [];
		let startedInput: unknown;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input_submission", () => ({
						metadata: { author: author("Alice"), order: 1, nested: { first: true } },
					}));
					pi.on("input_submission", (event) => {
						observed.push(event.metadata);
						return { metadata: { order: 2, nested: { last: true }, retained: "submission-only" } };
					});
					pi.on("input", (event) => {
						observed.push({ text: event.text, metadata: event.metadata });
						return { action: "transform", text: `first:${event.text}` };
					});
					pi.on("input", (event) => {
						observed.push({ text: event.text, metadata: event.metadata });
						return { action: "transform", text: `second:${event.text}` };
					});
					pi.on("message_start", (event) => {
						if (event.message.role === "user") startedInput = event.input;
					});
				},
				inputAuthor,
			],
		});
		harnesses.push(harness);
		let providerContext = "";
		harness.setResponses([
			(context) => {
				providerContext = JSON.stringify(context);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("original", { source: "interactive" });
		const merged = { author: author("Alice"), order: 2, nested: { last: true }, retained: "submission-only" };
		expect(observed).toEqual([
			{ author: author("Alice"), order: 1, nested: { first: true } },
			{ text: "original", metadata: merged },
			{ text: "first:original", metadata: merged },
		]);
		expect(startedInput).toEqual({ source: "interactive", metadata: merged });
		expect(getUserTexts(harness)).toEqual(["second:first:original"]);
		expect(providerContext).toContain("second:first:original");
		expect(providerContext).not.toMatch(/Alice|herdr-client|submission-only|metadata|verified/);
		const entries = harness.sessionManager.getEntries();
		const userIndex = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
		expect(entries[userIndex - 1]).toMatchObject({
			type: "custom",
			customType: "input-author",
			data: { author: author("Alice") },
		});
	});

	it.each(["prompt", "steer", "followUp"] as const)(
		"drops handled %s attribution before a matching extension message",
		async (route) => {
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", (event) =>
							event.source === "interactive" ? { metadata: { author: author("Alice") } } : undefined,
						);
						pi.on("input", (event) => (event.source === "interactive" ? { action: "handled" } : undefined));
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			if (route === "prompt") await harness.session.prompt("same", { source: "interactive" });
			else await harness.session[route]("same", undefined, { source: "interactive" });
			expect(harness.session.messages).toEqual([]);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
			harness.setResponses([fauxAssistantMessage("extension response")]);
			await harness.session.sendUserMessage("same");
			expect(getUserTexts(harness)).toEqual(["same"]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
		},
	);

	it("discards cleared queue authors without attributing a later identical RPC input", async () => {
		let currentAuthor = author("Alice");
		const harness = await createHarness({
			extensionFactories: [
				(pi) =>
					pi.on("input_submission", (event) =>
						event.source === "interactive" ? { metadata: { author: currentAuthor } } : undefined,
					),
				inputAuthor,
			],
		});
		harnesses.push(harness);
		await harness.session.followUp("same", undefined, { source: "interactive" });
		currentAuthor = author("Bob");
		await harness.session.steer("same", undefined, { source: "interactive" });
		expect(harness.session.clearQueue()).toEqual({ steering: ["same"], followUp: ["same"] });
		harness.setResponses([fauxAssistantMessage("RPC response")]);
		await harness.session.prompt("same", { source: "rpc" });
		expect(getUserTexts(harness)).toEqual(["same"]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
	});

	it("keeps RPC, extension, anonymous and unknown agent-origin inputs unattributed", async () => {
		const responseStarted = gate();
		const responseRelease = gate();
		const starts: unknown[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input_submission", (event) =>
						event.source === "interactive" && event.text === "named"
							? { metadata: { author: author("Alice") } }
							: undefined,
					);
					pi.on("message_start", (event) => {
						if (event.message.role === "user")
							starts.push({ text: getMessageText(event.message), input: event.input });
					});
				},
				inputAuthor,
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				responseStarted.release();
				await responseRelease.promise;
				return fauxAssistantMessage("initial response");
			},
			fauxAssistantMessage("unknown response"),
			fauxAssistantMessage("RPC response"),
			fauxAssistantMessage("extension response"),
			fauxAssistantMessage("anonymous response"),
		]);
		const prompt = harness.session.prompt("named", { source: "interactive" });
		await responseStarted.promise;
		try {
			harness.session.agent.steer({ role: "user", content: "same", timestamp: Date.now() });
		} finally {
			responseRelease.release();
			await prompt;
		}
		await harness.session.prompt("same", { source: "rpc" });
		await harness.session.sendUserMessage("same");
		await harness.session.prompt("same", { source: "interactive" });
		expect(starts).toMatchObject([
			{ text: "named", input: { source: "interactive", metadata: { author: author("Alice") } } },
			{ text: "same", input: undefined },
			{ text: "same", input: { source: "rpc" } },
			{ text: "same", input: { source: "extension" } },
			{ text: "same", input: { source: "interactive" } },
		]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toMatchObject([
			{ customType: "input-author", data: { author: author("Alice") } },
		]);
	});

	it("does not reattribute an unknown low-level insertion that reuses a previously named native message object", async () => {
		const responseStarted = gate();
		const responseRelease = gate();
		const starts: Array<InputSubmission | undefined> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input_submission", (event) =>
						event.source === "interactive" ? { metadata: { author: author("Alice") } } : undefined,
					);
					pi.on("message_start", (event) => {
						if (event.message.role === "user" && getMessageText(event.message) === "named")
							starts.push(event.input);
					});
				},
				inputAuthor,
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("named response"),
			async () => {
				responseStarted.release();
				await responseRelease.promise;
				return fauxAssistantMessage("RPC response");
			},
			fauxAssistantMessage("unknown insertion response"),
		]);
		await harness.session.prompt("named", { source: "interactive" });
		const namedUser = harness.session.messages.find(
			(message) => message.role === "user" && getMessageText(message) === "named",
		);
		if (!namedUser) throw new Error("Expected previously accepted native user object");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(1);
		const running = harness.session.prompt("later RPC prompt", { source: "rpc" });
		await responseStarted.promise;
		try {
			harness.session.agent.steer(namedUser);
		} finally {
			responseRelease.release();
			await running;
		}
		expect(starts).toEqual([{ source: "interactive", metadata: { author: author("Alice") } }, undefined]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(1);
	});

	it("reserves prompt preflight while asynchronous submission capture is held", async () => {
		const captureStarted = gate();
		const captureRelease = gate();
		let pendingAtCapture: boolean | undefined;
		let pendingAtInput: boolean | undefined;
		let api!: ExtensionAPI;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("input_submission", async (_event, ctx) => {
						pendingAtCapture = ctx.isPromptPending();
						captureStarted.release();
						await captureRelease.promise;
						return { metadata: { author: author("Alice") } };
					});
					pi.on("input", (_event, ctx) => {
						pendingAtInput = ctx.isPromptPending();
					});
				},
				inputAuthor,
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("user response"), fauxAssistantMessage("wake response")]);
		const prompt = harness.session.prompt("native prompt", { source: "interactive" });
		await captureStarted.promise;
		try {
			expect(harness.session.isPromptPending).toBe(true);
			api.sendMessage(
				{ customType: "wake", content: "wake", display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			captureRelease.release();
			await prompt;
		}
		await harness.session.waitForIdle();
		expect(pendingAtCapture).toBe(true);
		expect(pendingAtInput).toBe(true);
		expect(harness.session.getLastAssistantText()).toBe("wake response");
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["native prompt"]);
	});

	it("captures authors before compaction-held input is replayed without recapturing", async () => {
		const compactStarted = gate();
		const compactRelease = gate();
		let currentAuthor = author("Alice");
		const captures: string[] = [];
		const inputs: unknown[] = [];
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("input_submission", (event) => {
						captures.push(event.text);
						return { metadata: { author: currentAuthor } };
					});
					pi.on("input", (event) => {
						inputs.push(event.metadata);
					});
					pi.on("session_before_compact", async (event) => {
						compactStarted.release();
						await compactRelease.promise;
						return {
							compaction: {
								summary: "compacted history",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
				inputAuthor,
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "old question", timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("old response"));
		harness.session.refreshContext();
		const compacting = harness.session.compact();
		await compactStarted.promise;
		const submission = await harness.session.captureInputSubmission("same", {
			source: "interactive",
			streamingBehavior: "followUp",
		});
		try {
			expect(harness.session.isCompacting).toBe(true);
			expect(submission).toEqual({ source: "interactive", metadata: { author: author("Alice") } });
			expect(inputs).toEqual([]);
			currentAuthor = author("Bob");
		} finally {
			compactRelease.release();
			await compacting;
		}
		let contextText = "";
		harness.setResponses([
			(context) => {
				contextText = JSON.stringify(context);
				return fauxAssistantMessage("replayed response");
			},
		]);
		await harness.session.prompt("same", { source: "interactive", submission });
		expect(captures).toEqual(["same"]);
		expect(inputs).toEqual([{ author: author("Alice") }]);
		expect(contextText).not.toMatch(/Alice|Bob|herdr-client|metadata|verified/);
		const entries = harness.sessionManager.getEntries();
		const userIndex = entries.findIndex(
			(entry) =>
				entry.type === "message" && entry.message.role === "user" && getMessageText(entry.message) === "same",
		);
		expect(entries[userIndex - 1]).toMatchObject({
			type: "custom",
			customType: "input-author",
			data: { author: author("Alice") },
		});
	});

	it.each(["steer", "followUp"] as const)(
		"forwards a pre-captured %s submission once and preserves its source over conflicting options",
		async (route) => {
			let currentAuthor = author("Alice");
			let captures = 0;
			const starts: InputSubmission[] = [];
			const contexts: string[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", (event) => {
							if (event.source !== "interactive") return;
							captures++;
							return { metadata: { author: currentAuthor } };
						});
						pi.on("message_start", (event) => {
							if (event.message.role === "user" && getMessageText(event.message) === "same" && event.input)
								starts.push(event.input);
						});
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			const submission = await harness.session.captureInputSubmission("same", {
				source: "interactive",
				streamingBehavior: route,
			});
			currentAuthor = author("Bob");
			await harness.session[route]("same", undefined, { source: "rpc", submission });
			harness.setResponses(
				Array.from({ length: 2 }, () => (context) => {
					contexts.push(JSON.stringify(context));
					return fauxAssistantMessage("done");
				}),
			);
			await harness.session.prompt("start", { source: "rpc" });
			expect(captures).toBe(1);
			expect(starts).toEqual([{ source: "interactive", metadata: { author: author("Alice") } }]);
			const entries = harness.sessionManager.getEntries();
			const index = entries.findIndex(
				(entry) =>
					entry.type === "message" && entry.message.role === "user" && getMessageText(entry.message) === "same",
			);
			expect(entries[index - 1]).toMatchObject({
				type: "custom",
				customType: "input-author",
				data: { author: author("Alice") },
			});
			for (const context of contexts) expect(context).not.toMatch(/Alice|Bob|herdr-client|metadata|verified/);
		},
	);

	it("excludes durable author metadata from the actual faux compaction summary provider request", async () => {
		let currentAuthor = author("AUTHOR_A");
		const summaries: string[] = [];
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("input_submission", () => ({ metadata: { author: currentAuthor } }));
				},
				inputAuthor,
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);
		await harness.session.prompt("first native input", { source: "interactive" });
		currentAuthor = author("AUTHOR_B");
		await harness.session.prompt("second native input", { source: "interactive" });
		const nativeBefore = harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [entry.message] : []));
		harness.setResponses(
			Array.from({ length: 3 }, () => (context) => {
				summaries.push(JSON.stringify(context));
				return fauxAssistantMessage("actual faux summary");
			}),
		);
		const result = await harness.session.compact();
		expect(result.summary).toContain("actual faux summary");
		expect(summaries.length).toBeGreaterThan(0);
		expect(summaries.join("\n")).toContain("first native input");
		for (const summary of summaries)
			expect(summary).not.toMatch(/AUTHOR_A|AUTHOR_B|herdr-client|input-author|metadata|beforeMessageId|verified/);
		expect(
			harness.sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [entry.message] : [])),
		).toEqual(nativeBefore);
		expect(nativeBefore.map(getMessageText)).toEqual(["first native input", "second native input"]);
		for (const message of nativeBefore) expect(Object.keys(message).sort()).toEqual(["content", "role", "timestamp"]);
	});

	it("replays and forks persisted author entries without adding metadata to model context", async () => {
		let currentAuthor = author("Alice");
		const contexts: string[] = [];
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) =>
					pi.on("input_submission", (event) =>
						event.source === "interactive" ? { metadata: { author: currentAuthor } } : undefined,
					),
				inputAuthor,
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first response"),
			fauxAssistantMessage("second response"),
			(context) => {
				contexts.push(JSON.stringify(context));
				return fauxAssistantMessage("fork response");
			},
		]);
		await harness.session.prompt("first", { source: "interactive" });
		const firstLeaf = harness.sessionManager.getLeafId();
		if (!firstLeaf) throw new Error("Expected first assistant entry");
		currentAuthor = author("Bob");
		await harness.session.prompt("second", { source: "interactive" });
		const file = harness.session.sessionFile;
		if (!file) throw new Error("Expected persisted session");
		const reopened = SessionManager.open(file, harness.tempDir);
		expect(reopened.getEntries()).toEqual(harness.sessionManager.getEntries());
		expect(reopened.getEntries().filter((entry) => entry.type === "custom")).toMatchObject([
			{ customType: "input-author", data: { author: author("Alice") } },
			{ customType: "input-author", data: { author: author("Bob") } },
		]);
		expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toMatch(
			/Alice|Bob|herdr-client|metadata|verified/,
		);
		const forkFile = harness.sessionManager.createBranchedSession(firstLeaf);
		if (!forkFile) throw new Error("Expected persisted fork");
		harness.session.refreshContext();
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toMatchObject([
			{ customType: "input-author", data: { author: author("Alice") } },
		]);
		const fork = SessionManager.open(forkFile, harness.tempDir);
		expect(fork.getEntries()).toEqual(harness.sessionManager.getEntries());
		await harness.session.prompt("same", { source: "rpc" });
		expect(contexts).toHaveLength(1);
		expect(contexts[0]).toContain("first");
		expect(contexts[0]).not.toMatch(/second response|Alice|Bob|herdr-client|metadata|verified/);
		expect(contexts[0]).not.toContain('"text":"second"');
	});

	it("uses the actual input-author example renderer above the unchanged native message", async () => {
		initTheme("dark");
		let providerText = "";
		const harness = await createHarness({
			extensionFactories: [
				(pi) =>
					pi.on("input_submission", () => ({
						metadata: { author: { ...author("Alice"), extra: "do not persist" } },
					})),
				inputAuthor,
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				providerText = JSON.stringify(context);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("unchanged native input", { source: "interactive" });
		const entries = harness.sessionManager.getEntries();
		const userIndex = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
		const entry = entries[userIndex - 1];
		if (entry?.type !== "custom") throw new Error("Expected author immediately before native input");
		expect(entry.customType).toBe("input-author");
		expect(entry.data).toEqual({ author: author("Alice") });
		const renderer = harness.session.extensionRunner.getEntryRenderer("input-author");
		if (!renderer) throw new Error("Expected registered input-author renderer");
		const component = renderer(entry, { expanded: false }, theme);
		expect(component).toBeDefined();
		expect(stripAnsi(component!.render(80).join("\n")).trimEnd()).toBe("Alice:");
		expect(getUserTexts(harness)).toEqual(["unchanged native input"]);
		expect(providerText).toContain("unchanged native input");
		expect(providerText).not.toMatch(/Alice|herdr-client|input-author|metadata|verified|do not persist/);
	});

	it.each(["fork-before-user", "re-edit-before-user"] as const)(
		"hides orphaned Alice author rendering after %s and Bob resubmission",
		async (route) => {
			initTheme("dark");
			let currentAuthor = author("Alice");
			const harness = await createHarness({
				persistSession: true,
				extensionFactories: [
					(pi) => pi.on("input_submission", () => ({ metadata: { author: currentAuthor } })),
					inputAuthor,
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("Alice response"), fauxAssistantMessage("Bob response")]);
			await harness.session.prompt("Alice original", { source: "interactive" });
			const user = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!user?.parentId) throw new Error("Expected author's custom entry before original user");
			const precedingAuthor = harness.sessionManager.getEntry(user.parentId);
			if (precedingAuthor?.type !== "custom") throw new Error("Expected native user's parent to be author entry");
			const renderer = harness.session.extensionRunner.getEntryRenderer("input-author");
			if (!renderer) throw new Error("Expected actual example renderer");
			const renderAuthors = () => renderNativeTranscript(harness);
			expect(renderAuthors()).toContain("Alice:");
			if (route === "fork-before-user") harness.sessionManager.createBranchedSession(precedingAuthor.id);
			else harness.sessionManager.branch(precedingAuthor.id);
			harness.session.refreshContext();
			expect
				.soft(renderAuthors(), "the abandoned user's author must render nothing before re-edit")
				.not.toContain("Alice:");
			currentAuthor = author("Bob");
			await harness.session.prompt("Bob replacement", { source: "interactive" });
			const rendered = renderAuthors();
			expect.soft(rendered, "Alice must never label Bob's replacement message").not.toContain("Alice:");
			expect(rendered).toContain("Bob:");
			expect(getUserTexts(harness)).toEqual(["Bob replacement"]);
		},
	);

	it("uses the live user boundary to place its author after streaming output while unbound entries retain old placement", async () => {
		initTheme("dark");
		const responseStarted = gate();
		const responseRelease = gate();
		let api!: ExtensionAPI;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("input_submission", (event) =>
						event.source === "interactive" ? { metadata: { author: author("Alice") } } : undefined,
					);
				},
				inputAuthor,
			],
		});
		harnesses.push(harness);
		const chatContainer = new Container();
		const streamingComponent = new Text("existing streaming assistant", 0, 0);
		chatContainer.addChild(streamingComponent);
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session: harness.session },
			chatContainer,
			streamingComponent,
			toolOutputExpanded: false,
			outputPad: 0,
			getMarkdownTransformers: () => [],
		});
		const addEntry = Reflect.get(InteractiveMode.prototype, "addCustomEntryToChat") as (
			this: typeof context,
			entry: Extract<ReturnType<SessionManager["getEntries"]>[number], { type: "custom" }>,
			beforeMessage?: Parameters<Harness["session"]["agent"]["steer"]>[0],
		) => void;
		const addMessage = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
			this: typeof context,
			message: Parameters<Harness["session"]["agent"]["steer"]>[0],
		) => void;
		const boundPublications: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "custom") {
				addEntry.call(context, event.entry, event.beforeMessage);
				if (event.entry.customType === "input-author" && event.beforeMessage)
					boundPublications.push({ text: getMessageText(event.beforeMessage), id: event.entry.beforeMessageId });
			} else if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "unchanged queued input"
			) {
				addMessage.call(context, event.message);
			}
		});
		harness.setResponses([
			async () => {
				responseStarted.release();
				await responseRelease.promise;
				return fauxAssistantMessage("initial response");
			},
			fauxAssistantMessage("steer response"),
		]);
		const running = harness.session.prompt("start", { source: "rpc" });
		await responseStarted.promise;
		try {
			api.appendEntry("input-author", { author: author("Unbound") });
			await harness.session.steer("unchanged queued input", undefined, { source: "interactive" });
		} finally {
			responseRelease.release();
			await running;
		}
		const output = stripAnsi(chatContainer.render(100).join("\n"));
		expect(output.indexOf("Unbound:")).toBeLessThan(output.indexOf("existing streaming assistant"));
		expect(output.indexOf("existing streaming assistant")).toBeLessThan(output.indexOf("Alice:"));
		expect(output.indexOf("Alice:")).toBeLessThan(output.indexOf("unchanged queued input"));
		expect(boundPublications).toMatchObject([{ text: "unchanged queued input", id: expect.any(String) }]);
	});

	it("does not let an asynchronous append after a user hook returns borrow a later user boundary", async () => {
		const lateRelease = gate();
		const latePublished = gate();
		const secondStarted = gate();
		const secondRelease = gate();
		const lateEntries: unknown[] = [];
		let lateAppend: Promise<void> | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_start", async (event) => {
						if (event.message.role !== "user") return;
						if (getMessageText(event.message) === "first") {
							lateAppend = lateRelease.promise.then(() => {
								pi.appendEntry("late-state", { value: 1 });
								latePublished.release();
							});
						} else {
							secondStarted.release();
							await secondRelease.promise;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (
				event.type === "entry_appended" &&
				event.entry.type === "custom" &&
				event.entry.customType === "late-state"
			)
				lateEntries.push({ beforeMessage: event.beforeMessage, beforeMessageId: event.entry.beforeMessageId });
		});
		harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);
		await harness.session.prompt("first", { source: "rpc" });
		const second = harness.session.prompt("second", { source: "rpc" });
		await secondStarted.promise;
		try {
			lateRelease.release();
			await latePublished.promise;
			expect(lateEntries).toEqual([{ beforeMessage: undefined, beforeMessageId: undefined }]);
		} finally {
			lateRelease.release();
			secondRelease.release();
			await Promise.all([lateAppend, second]);
		}
	});

	it("renders claimed names on one visible line without terminal controls", async () => {
		initTheme("dark");
		const harness = await createHarness({
			extensionFactories: [
				(pi) => pi.on("input_submission", () => ({ metadata: { author: author("Alice\n\u001b[31m") } })),
				inputAuthor,
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("native input", { source: "interactive" });
		const entry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "input-author");
		const renderer = harness.session.extensionRunner.getEntryRenderer("input-author");
		if (entry?.type !== "custom" || !renderer) throw new Error("Expected actual author renderer");
		const component = renderer(entry, { expanded: false }, theme);
		if (!component) throw new Error("Expected safe author text");
		const lines = component.render(100).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Alice");
		expect(lines[0]).toContain(":");
		expect(lines[0]).not.toMatch(/[\n\r\u001b]/);
	});

	it.each(["rpc", "extension"] as const)(
		"never renders a claimed author from a noninteractive %s origin",
		async (source) => {
			const harness = await createHarness({
				extensionFactories: [
					(pi) => pi.on("input_submission", () => ({ metadata: { author: author("Alice") } })),
					inputAuthor,
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("native input", { source });
			expect(getUserTexts(harness)).toEqual(["native input"]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
			expect(renderNativeTranscript(harness)).not.toContain("Alice:");
		},
	);

	it.each(["input_submission", "input"] as const)(
		"does not publish author metadata after terminal cancellation during %s",
		async (phase) => {
			const held = gate();
			const release = gate();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input_submission", async () => {
							if (phase === "input_submission") {
								held.release();
								await release.promise;
							}
							return { metadata: { author: author("Alice") } };
						});
						pi.on("input", async () => {
							if (phase === "input") {
								held.release();
								await release.promise;
							}
							return { action: "continue" };
						});
					},
					inputAuthor,
				],
			});
			harnesses.push(harness);
			const prompt = harness.session.prompt("same", { source: "interactive" }).then(
				() => undefined,
				(error: unknown) => error,
			);
			await held.promise;
			try {
				harness.session.cancelForShutdown();
				expect(await prompt).toMatchObject({ name: "AbortError" });
			} finally {
				release.release();
				await prompt;
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(harness.session.messages).toEqual([]);
			expect(harness.sessionManager.getEntries()).toEqual([]);
			expect(harness.faux.state.callCount).toBe(0);
		},
	);

	it("captures a settlement-deferred prompt before the current hook returns and author changes", async () => {
		const settled = gate();
		const release = gate();
		const captured = gate();
		let firstSettlement = true;
		let currentAuthor = author("Alice");
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input_submission", (event) => {
						if (event.source !== "interactive") return;
						const metadata = { author: currentAuthor };
						captured.release();
						return { metadata };
					});
					pi.on("agent_settled", async () => {
						if (!firstSettlement) return;
						firstSettlement = false;
						settled.release();
						await release.promise;
					});
				},
				inputAuthor,
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("initial response"), fauxAssistantMessage("deferred response")]);
		const initial = harness.session.prompt("initial", { source: "rpc" });
		await settled.promise;
		const deferred = harness.session.prompt("same", { source: "interactive" });
		try {
			await captured.promise;
			currentAuthor = author("Bob");
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			release.release();
			await Promise.all([initial, deferred]);
		}
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toMatchObject([
			{ customType: "input-author", data: { author: author("Alice") } },
		]);
	});

	it.each([
		undefined,
		null,
		"Alice",
		{},
		{ name: "", source: "herdr-client", verified: false },
		{ name: "   ", source: "herdr-client", verified: false },
		{ name: 1, source: "herdr-client", verified: false },
		{ name: "Alice", source: "rpc", verified: false },
		{ name: "Alice", source: "herdr-client", verified: true },
		{ name: "Alice", source: "herdr-client" },
	])("does not persist invalid or unsupported author proposals %j", async (proposal) => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => pi.on("input_submission", () => ({ metadata: { author: proposal } })),
				inputAuthor,
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("native input", { source: "interactive" });
		expect(getUserTexts(harness)).toEqual(["native input"]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
	});
});
