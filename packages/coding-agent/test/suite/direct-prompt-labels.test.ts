import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionFactory,
	InputEvent,
	InputSubmissionEvent,
	MessageStartEvent,
} from "../../src/core/extensions/index.ts";
import { type CustomEntry, SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function labels(harness: Harness): CustomEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === "direct-author");
}

function labeler(starts: MessageStartEvent[], capture: () => string | undefined): ExtensionFactory {
	return (pi) => {
		pi.on("input_submission", () => {
			const name = capture();
			return name ? { metadata: { author: name } } : undefined;
		});
		pi.on("message_start", (event) => {
			if (event.message.role !== "user") return;
			starts.push(event);
			if (event.input?.metadata?.author) pi.appendEntry("direct-author", event.input.metadata);
		});
	};
}

// pi#4078 / pi#3937: only directly submitted idle normal prompts have attribution.
// Queued and compaction-staged attribution is intentionally cut to smarty-dev#4979.
describe("direct prompt labels", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});
	async function make(extensionFactories: ExtensionFactory[], persistSession = false) {
		const harness = await createHarness({
			extensionFactories,
			persistSession,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } },
		});
		harnesses.push(harness);
		return harness;
	}

	it("captures before held input transforms, binds identical text to distinct authors, and never inherits", async () => {
		let author: string | undefined = "Alice";
		const starts: MessageStartEvent[] = [];
		const captures: InputSubmissionEvent[] = [];
		const entered = deferred();
		const release = deferred();
		const inputs: InputEvent[] = [];
		const harness = await make(
			[
				labeler(starts, () => author),
				(pi) => {
					pi.on("input_submission", (event) => {
						captures.push(event);
					});
					pi.on("input", async (event) => {
						inputs.push(event);
						if (inputs.length === 1) {
							entered.resolve();
							await release.promise;
						}
						return { action: "transform", text: "same transformed text" };
					});
				},
			],
			true,
		);
		const contexts: string[] = [];
		harness.setResponses(
			Array.from({ length: 3 }, () => (context) => {
				contexts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("reply");
			}),
		);
		const first = harness.session.prompt("same raw text");
		await entered.promise;
		author = "Bob";
		release.resolve();
		await first;
		await harness.session.prompt("same raw text");
		author = undefined;
		await harness.session.prompt("same raw text");
		expect(captures.map((event) => event.text)).toEqual(Array(3).fill("same raw text"));
		expect(starts.map((event) => event.input?.metadata?.author)).toEqual(["Alice", "Bob", undefined]);
		expect(inputs.map((event) => event.metadata?.author)).toEqual(["Alice", "Bob", undefined]);
		expect(getUserTexts(harness)).toEqual(Array(3).fill("same transformed text"));
		expect(labels(harness).map((entry) => entry.data)).toEqual([{ author: "Alice" }, { author: "Bob" }]);
		const users = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user");
		expect(labels(harness).map((entry) => entry.beforeMessageId)).toEqual(users.slice(0, 2).map((entry) => entry.id));
		expect(starts.slice(0, 2).map((event) => event.entryId)).toEqual(users.slice(0, 2).map((entry) => entry.id));
		for (const context of contexts) {
			expect(context).not.toContain("Alice");
			expect(context).not.toContain("Bob");
			expect(context).not.toContain("metadata");
		}
		const file = harness.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected persisted session");
		const reopened = SessionManager.open(file);
		expect(reopened.getEntries().filter((entry) => entry.type === "custom")).toEqual(labels(harness));
		expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("Alice");
	});

	it("accepts SDK metadata as detached data and merges capture results without changing model content", async () => {
		const starts: MessageStartEvent[] = [];
		const gate = deferred();
		const entered = deferred();
		const harness = await make([
			labeler(starts, () => undefined),
			(pi) => {
				pi.on("input_submission", async (event) => {
					expect(event.source).toBe("rpc");
					expect(event.metadata?.author).toBe("SDK Alice");
					entered.resolve();
					await gate.promise;
					return { metadata: { origin: "sdk" } };
				});
			},
		]);
		const metadata = { author: "SDK Alice", nested: { stable: true } };
		harness.setResponses([
			(context) => {
				expect(getMessageText(context.messages.at(-1))).toBe("unchanged");
				expect(JSON.stringify(context.messages)).not.toContain("SDK Alice");
				return fauxAssistantMessage("ok");
			},
		]);
		const prompt = harness.session.prompt("unchanged", { source: "rpc", metadata });
		await entered.promise;
		metadata.author = "late Bob";
		metadata.nested.stable = false;
		gate.resolve();
		await prompt;
		expect(starts[0]?.input).toEqual({
			source: "rpc",
			metadata: { author: "SDK Alice", nested: { stable: true }, origin: "sdk" },
		});
		expect(labels(harness)[0]?.beforeMessageId).toBe(starts[0]?.entryId);
	});

	it.each(["steer", "followUp"] as const)(
		"does not label actual streaming %s deliveries or recapture them",
		async (behavior) => {
			const starts: MessageStartEvent[] = [];
			const entered = deferred();
			const release = deferred();
			let captures = 0;
			const harness = await make([
				labeler(starts, () => {
					captures++;
					return "Alice";
				}),
			]);
			harness.setResponses([
				async () => {
					entered.resolve();
					await release.promise;
					return fauxAssistantMessage("first");
				},
				fauxAssistantMessage("queued"),
				fauxAssistantMessage("next"),
			]);
			const first = harness.session.prompt("direct");
			await entered.promise;
			await harness.session.prompt("same", { streamingBehavior: behavior, metadata: { author: "Wrong" } });
			await harness.session[behavior]("same");
			harness.session.setSteeringMode("all");
			harness.session.setFollowUpMode("all");
			release.resolve();
			await first;
			expect(getUserTexts(harness)).toEqual(["direct", "same", "same"]);
			expect(starts.map((event) => event.input?.metadata?.author)).toEqual(["Alice", undefined, undefined]);
			expect(captures).toBe(1);
			expect(labels(harness)).toHaveLength(1);
			await harness.session.prompt("next");
			expect(starts.at(-1)?.input?.metadata?.author).toBe("Alice");
			expect(captures).toBe(2);
		},
	);

	it.each(["steer", "followUp"] as const)(
		"excludes idle replay with explicit %s behavior",
		async (streamingBehavior) => {
			const starts: MessageStartEvent[] = [];
			const harness = await make([labeler(starts, () => "Wrong replay author")]);
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("first replay", { streamingBehavior, metadata: { author: "Wrong SDK" } });
			expect(getUserTexts(harness)).toEqual(["first replay"]);
			expect(starts[0]?.input).toBeUndefined();
			expect(labels(harness)).toEqual([]);
		},
	);

	it("excludes a queued overlapping preflight, even when the earlier input hook is held", async () => {
		const entered = deferred();
		const release = deferred();
		const starts: MessageStartEvent[] = [];
		const harness = await make([
			labeler(starts, () => "Alice"),
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text === "first") {
						entered.resolve();
						await release.promise;
					}
				});
			},
		]);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const first = harness.session.prompt("first");
		await entered.promise;
		await harness.session.prompt("second", { streamingBehavior: "followUp" });
		release.resolve();
		await first;
		expect(getUserTexts(harness)).toEqual(["first", "second"]);
		expect(starts.map((event) => event.input?.metadata?.author)).toEqual(["Alice", undefined]);
	});

	it("excludes settlement-deferred prompts at the real receiving reentry", async () => {
		const starts: MessageStartEvent[] = [];
		let sent = false;
		let api: ExtensionAPI | undefined;
		const harness = await make([
			labeler(starts, () => "Alice"),
			(pi) => {
				api = pi;
				pi.on("agent_settled", () => {
					if (!sent) {
						sent = true;
						pi.sendUserMessage("deferred");
					}
				});
			},
		]);
		expect(api).toBeDefined();
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		expect(getUserTexts(harness)).toEqual(["first", "deferred"]);
		expect(starts.map((event) => event.input?.metadata?.author)).toEqual(["Alice", undefined]);
	});

	it("idle extension-generated user messages are not directly submitted sender input", async () => {
		const starts: MessageStartEvent[] = [];
		let captures = 0;
		const harness = await make([
			labeler(starts, () => {
				captures++;
				return "Alice";
			}),
		]);
		harness.setResponses([fauxAssistantMessage("generated reply"), fauxAssistantMessage("direct reply")]);
		await harness.session.sendUserMessage("extension-generated");
		expect(getUserTexts(harness)).toEqual(["extension-generated"]);
		expect(starts[0]?.input).toBeUndefined();
		expect(captures).toBe(0);
		expect(labels(harness)).toEqual([]);
		await harness.session.prompt("direct next");
		expect(starts.at(-1)?.input?.metadata?.author).toBe("Alice");
		expect(captures).toBe(1);
	});

	it("handled input and throwing capture handlers cannot grant or leak metadata", async () => {
		const starts: MessageStartEvent[] = [];
		let author: string | undefined = "discarded";
		const harness = await make([
			labeler(starts, () => author),
			(pi) => {
				pi.on("input_submission", (event) => {
					event.metadata = { author: "mutation" };
					throw new Error("capture failed");
				});
				pi.on("input", (event) => (event.text === "handled" ? { action: "handled" } : undefined));
			},
		]);
		const errors: string[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		await harness.session.prompt("handled");
		author = undefined;
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("next");
		expect(getUserTexts(harness)).toEqual(["next"]);
		expect(starts[0]?.input?.metadata).toBeUndefined();
		expect(labels(harness)).toEqual([]);
		expect(errors).toEqual(["capture failed", "capture failed"]);
	});

	it("binds awaited appendEntry calls, including before a handler throws, but never detached late work", async () => {
		const detached = deferred();
		const appended = deferred();
		const starts: MessageStartEvent[] = [];
		const errors: string[] = [];
		let first = true;
		const harness = await make([
			labeler(starts, () => "Alice"),
			(pi) => {
				pi.on("message_start", async (event) => {
					if (event.message.role !== "user" || !first) return;
					first = false;
					void detached.promise.then(() => {
						pi.appendEntry("late", { author: "not bound" });
						appended.resolve();
					});
					await Promise.resolve();
					pi.appendEntry("before-throw", {});
					throw new Error("handler failed");
				});
			},
		]);
		harness.session.extensionRunner.onError((event) => errors.push(event.error));
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		detached.resolve();
		await appended.promise;
		await harness.session.prompt("second");
		const custom = harness.sessionManager.getEntries().filter((entry) => entry.type === "custom");
		expect(custom.find((entry) => entry.customType === "before-throw")?.beforeMessageId).toBe(starts[0]?.entryId);
		expect(custom.find((entry) => entry.customType === "late")?.beforeMessageId).toBeUndefined();
		expect(labels(harness).map((entry) => entry.beforeMessageId)).toEqual(starts.map((event) => event.entryId));
		expect(errors).toEqual(["handler failed"]);
	});
});
