import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionMessageEntry } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI, SendUserMessageResult, UserMessageMetadata } from "../../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function gate(): { promise: Promise<void>; release: () => void } {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function metadataOf(entry: SessionMessageEntry): UserMessageMetadata | undefined {
	return entry.metadata;
}

function userEntries(harness: Harness): SessionMessageEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user");
}

function expectRootMetadata(harness: Harness, result: unknown, metadata: UserMessageMetadata): SessionMessageEntry {
	expect(result).toEqual({ status: "turnStarted", entryId: expect.any(String), metadata });
	const entryId = (result as { entryId: string }).entryId;
	const matches = userEntries(harness).filter((entry) => entry.id === entryId);
	expect(matches).toHaveLength(1);
	const entry = matches[0]!;
	if (entry.message.role !== "user") throw new Error("Receipt did not identify a user entry");
	expect(metadataOf(entry)).toEqual(metadata);
	expect(Object.isFrozen(metadataOf(entry))).toBe(true);
	expect(entry.message).not.toHaveProperty("metadata");
	if (Array.isArray(entry.message.content)) {
		for (const part of entry.message.content) expect(part).not.toHaveProperty("metadata");
	}
	return entry;
}

function onSettled(harness: Harness): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "agent_settled") {
				unsubscribe();
				resolve();
			}
		});
	});
}

describe("#7883 sendUserMessage metadata receipts", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// #7883: the receipt identifies the persisted user occurrence, not an equal-text older entry or agent completion.
	it("settles an idle metadata send at user persistence and keeps metadata outside provider content", async () => {
		const entered = gate();
		const release = gate();
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("old reply")]);
		await harness.session.prompt("same text");
		const oldId = userEntries(harness)[0]!.id;
		const metadata = { request: "idle-private-7883", nested: { values: [1, { enabled: true }] } };
		let providerPayload = "";
		let providerUserTexts: string[] = [];
		harness.setResponses([
			async (context) => {
				providerPayload = JSON.stringify(context);
				providerUserTexts = context.messages.filter((message) => message.role === "user").map(getMessageText);
				entered.release();
				await release.promise;
				return fauxAssistantMessage("new reply");
			},
		]);
		const finished = onSettled(harness);
		const options = { metadata, expandPromptTemplates: false };
		const delivery = harness.session.sendUserMessage("same text", options);
		const results: unknown[] = [];
		void delivery.then((result) => results.push(result));
		try {
			await entered.promise;
			// Drain asynchronous preflight/persistence continuations while the provider cannot finish.
			await setImmediate();
			expect(results).toHaveLength(1);
			const entry = expectRootMetadata(harness, results[0], metadata);
			expect(entry.id).not.toBe(oldId);
			expect(metadataOf(userEntries(harness)[0]!)).toBeUndefined();
			expect(userEntries(harness).filter((candidate) => metadataOf(candidate) !== undefined)).toHaveLength(1);
			expect(providerUserTexts).toEqual(["same text", "same text"]);
			expect(providerPayload).not.toContain("idle-private-7883");
			expect(providerPayload).not.toContain('"metadata"');
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		} finally {
			release.release();
			await delivery;
			await finished;
		}
		expect(results).toHaveLength(1);
		const file = harness.sessionManager.getSessionFile();
		expect(file).toBeDefined();
		const records: unknown[] = readFileSync(file!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.filter((record) => JSON.stringify(record).includes("idle-private-7883"))).toHaveLength(1);
	});

	// #7883: three identical queued texts require per-occurrence FIFO receipts, never text-based lookup.
	it.each(["steer", "followUp"] as const)(
		"keeps three busy %s receipts pending until their own user entries persist",
		async (deliverAs) => {
			const entered = Array.from({ length: 4 }, () => gate());
			const release = Array.from({ length: 4 }, () => gate());
			const harness = await createHarness();
			harnesses.push(harness);
			harness.session.setSteeringMode("one-at-a-time");
			harness.session.setFollowUpMode("one-at-a-time");
			const providerPayloads: string[] = [];
			harness.setResponses(
				entered.map((checkpoint, index) => async (context) => {
					providerPayloads.push(JSON.stringify(context));
					checkpoint.release();
					await release[index]!.promise;
					return fauxAssistantMessage(`reply ${index}`);
				}),
			);
			const running = harness.session.prompt("same text");
			await entered[0]!.promise;
			expect(harness.session.isStreaming).toBe(true);
			expect(harness.session.isPromptPending).toBe(false);
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			const metadata = [1, 2, 3].map((sequence) => ({ request: `queue-private-7883-${sequence}`, sequence }));
			const results: unknown[][] = [[], [], []];
			const deliveries = metadata.map((item, index) => {
				const options = { metadata: item, deliverAs };
				const delivery = harness.session.sendUserMessage("same text", options);
				void delivery.then((result) => results[index]!.push(result));
				return delivery;
			});
			try {
				await setImmediate();
				expect(harness.session.pendingMessageCount).toBe(3);
				expect(results.map((values) => values.length)).toEqual([0, 0, 0]);
				for (let index = 0; index < 3; index++) {
					release[index]!.release();
					await entered[index + 1]!.promise;
					await setImmediate();
					expect(results.map((values) => values.length)).toEqual([0, 1, 2].map((slot) => (slot <= index ? 1 : 0)));
					expectRootMetadata(harness, results[index]![0], metadata[index]!);
					expect(userEntries(harness).filter((entry) => metadataOf(entry) !== undefined)).toHaveLength(index + 1);
				}
			} finally {
				for (const checkpoint of release) checkpoint.release();
				await running;
				await Promise.all(deliveries);
			}
			expect(results.map((values) => values.length)).toEqual([1, 1, 1]);
			const entries = userEntries(harness);
			expect(entries.map((entry) => getMessageText(entry.message))).toEqual(Array(4).fill("same text"));
			expect(entries.map(metadataOf)).toEqual([undefined, ...metadata]);
			expect(new Set(results.map((values) => (values[0] as { entryId: string }).entryId)).size).toBe(3);
			for (const payload of providerPayloads) {
				expect(payload).not.toContain("queue-private-7883");
				expect(payload).not.toContain('"metadata"');
			}
		},
	);

	// #7883: three inputs in one held preflight slot must retain separate metadata and receipts.
	it.each(["steer", "followUp"] as const)("preserves three %s inputs queued behind preflight", async (deliverAs) => {
		const entered = gate();
		const release = gate();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						entered.release();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setSteeringMode("one-at-a-time");
		harness.session.setFollowUpMode("one-at-a-time");
		harness.setResponses([0, 1, 2, 3].map((index) => fauxAssistantMessage(`reply ${index}`)));
		const running = harness.session.prompt("same text");
		await entered.promise;
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isPromptPending).toBe(true);
		const metadata = [1, 2, 3].map((sequence) => ({ request: "preflight-private-7883", sequence }));
		const observations = [0, 0, 0];
		const deliveries = metadata.map((item, index) =>
			harness.session.sendUserMessage("same text", { metadata: item, deliverAs }).then((result) => {
				observations[index]++;
				return result;
			}),
		);
		try {
			await setImmediate();
			expect(observations).toEqual([0, 0, 0]);
			expect(userEntries(harness)).toEqual([]);
		} finally {
			release.release();
			await running;
		}
		const results = await Promise.all(deliveries);
		for (const [index, result] of results.entries()) expectRootMetadata(harness, result, metadata[index]!);
		expect(observations).toEqual([1, 1, 1]);
		expect(new Set(results.map((result) => result.entryId)).size).toBe(3);
		expect(userEntries(harness).map(metadataOf)).toEqual([undefined, ...metadata]);
		// Steering can join the initial request; each input still owns its separate persisted entry.
		expect(harness.faux.state.callCount).toBe(deliverAs === "steer" ? 3 : 4);
	});

	// #7883: removing queued input must reject its receipt, not strand it or persist its metadata later.
	it.each(["steer", "followUp"] as const)("rejects a cleared %s metadata receipt exactly once", async (deliverAs) => {
		const entered = gate();
		const release = gate();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				entered.release();
				await release.promise;
				return fauxAssistantMessage("original reply");
			},
		]);
		const running = harness.session.prompt("same text");
		await entered.promise;
		const options = { metadata: { request: "cleared-private-7883" }, deliverAs };
		const delivery = harness.session.sendUserMessage("same text", options);
		let rejections = 0;
		const rejected = delivery.catch((error: unknown) => {
			rejections++;
			return error;
		});
		try {
			await setImmediate();
			expect(harness.session.isStreaming).toBe(true);
			expect(harness.session.pendingMessageCount).toBe(1);
			expect(rejections).toBe(0);
			expect(harness.session.clearQueue()).toEqual({
				steering: deliverAs === "steer" ? ["same text"] : [],
				followUp: deliverAs === "followUp" ? ["same text"] : [],
			});
			expect(await rejected).toMatchObject({ code: "INPUT_ADMISSION_ABORTED" });
			expect(rejections).toBe(1);
			expect(harness.session.pendingMessageCount).toBe(0);
		} finally {
			harness.session.clearQueue();
			release.release();
			await running;
			await rejected;
		}
		expect(rejections).toBe(1);
		expect(userEntries(harness)).toHaveLength(1);
		expect(userEntries(harness).map(metadataOf)).toEqual([undefined]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	// #7883: handled input resolves once, creates no user entry, and stops later handlers and the model.
	it("returns a handled receipt from the first input handler without calling later handlers", async () => {
		let laterInput = 0;
		let beforeStart = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "handled" }));
				},
				(pi) => {
					pi.on("input", () => {
						laterInput++;
					});
					pi.on("before_agent_start", () => {
						beforeStart++;
					});
				},
			],
		});
		harnesses.push(harness);
		const metadata = { request: "handled-private-7883", nested: { values: ["original"] } };
		const options = { metadata, expandPromptTemplates: false };
		let observations = 0;
		const result = await harness.session.sendUserMessage("handled", options).then((value) => {
			observations++;
			return value;
		});
		expect(result).toEqual({ status: "handled", entryId: null, metadata });
		expect(observations).toBe(1);
		expect(Object.isFrozen(result.metadata)).toBe(true);
		expect(laterInput).toBe(0);
		expect(beforeStart).toBe(0);
		expect(userEntries(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("agent_start")).toEqual([]);
	});

	// #7883: snapshotting after awaiting input handlers is too late; caller changes must never reach storage.
	it("deeply snapshots and freezes metadata before asynchronous input preflight", async () => {
		const preflightEntered = gate();
		const preflightRelease = gate();
		const providerEntered = gate();
		const providerRelease = gate();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						preflightEntered.release();
						await preflightRelease.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				providerEntered.release();
				await providerRelease.promise;
				return fauxAssistantMessage("done");
			},
		]);
		const metadata = { request: "snapshot-private-7883", nested: { values: [1, { label: "original" }] } };
		const expected = structuredClone(metadata);
		const finished = onSettled(harness);
		const options = { metadata, expandPromptTemplates: false };
		const delivery = harness.session.sendUserMessage("unchanged content", options);
		metadata.request = "mutated immediately after call";
		const results: unknown[] = [];
		void delivery.then((result) => results.push(result));
		try {
			await preflightEntered.promise;
			metadata.request = "mutated";
			metadata.nested.values[1] = { label: "changed" };
			metadata.nested.values.push(99);
			expect(Object.isFrozen(metadata)).toBe(false);
			expect(results).toEqual([]);
			preflightRelease.release();
			await providerEntered.promise;
			await setImmediate();
			expect(results).toHaveLength(1);
			const entry = expectRootMetadata(harness, results[0], expected);
			for (const snapshot of [metadataOf(entry), (results[0] as SendUserMessageResult).metadata]) {
				expect(snapshot).not.toBe(metadata);
				const nested = snapshot!.nested as { values: unknown[] };
				expect(Object.isFrozen(snapshot)).toBe(true);
				expect(Object.isFrozen(nested)).toBe(true);
				expect(Object.isFrozen(nested.values)).toBe(true);
				expect(Object.isFrozen(nested.values[1])).toBe(true);
				expect(() => {
					nested.values.push("forbidden");
				}).toThrow(TypeError);
			}
		} finally {
			preflightRelease.release();
			providerRelease.release();
			await delivery;
			await finished;
		}
		expect(results).toHaveLength(1);
	});

	// #7883: real pre-prompt compaction must keep the receipt attached to the new user, never the summary or seed.
	it("preserves metadata through real pre-prompt compaction and settles before the answer", async () => {
		const compactEntered = gate();
		const compactRelease = gate();
		const providerEntered = gate();
		const providerRelease = gate();
		let compactions = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactions++;
						compactEntered.release();
						await compactRelease.promise;
						return {
							compaction: {
								summary: "#7883 pre-prompt summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.sessionManager.appendMessage({ role: "user", content: "same text", timestamp: Date.now() - 2 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("large seed ".repeat(4_000)),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		// A short latest turn lets the real retention boundary discard the oversized older turn.
		harness.sessionManager.appendMessage({ role: "user", content: "retained seed", timestamp: Date.now() - 1 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("short seed reply"),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		let providerPayload = "";
		harness.setResponses([
			async (context) => {
				providerPayload = JSON.stringify(context);
				providerEntered.release();
				await providerRelease.promise;
				return fauxAssistantMessage("answer");
			},
		]);
		const metadata = { request: "compact-private-7883" };
		const options = { metadata, expandPromptTemplates: false };
		const finished = onSettled(harness);
		const delivery = harness.session.sendUserMessage("same text", options);
		const results: unknown[] = [];
		void delivery.then((result) => results.push(result));
		try {
			await compactEntered.promise;
			expect(results).toEqual([]);
			expect(userEntries(harness).filter((entry) => metadataOf(entry) !== undefined)).toEqual([]);
			compactRelease.release();
			await providerEntered.promise;
			await setImmediate();
			expect(results).toHaveLength(1);
			const entry = expectRootMetadata(harness, results[0], metadata);
			expect(entry.id).not.toBe(userEntries(harness)[0]!.id);
			expect(compactions).toBe(1);
			expect(
				harness.sessionManager.getEntries().filter((candidate) => candidate.type === "compaction"),
			).toHaveLength(1);
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			expect(providerPayload).toContain("#7883 pre-prompt summary");
			expect(providerPayload).not.toContain("compact-private-7883");
			expect(providerPayload).not.toContain('"metadata"');
		} finally {
			compactRelease.release();
			providerRelease.release();
			await delivery;
			await finished;
		}
		expect(results).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(userEntries(harness).filter((entry) => metadataOf(entry) !== undefined)).toHaveLength(1);
	});

	// #7883: the real extension loader and session action must both return, rather than discard, the promise.
	it("returns a metadata promise through the extension API wrapper end to end", async () => {
		let api: ExtensionAPI | undefined;
		const entered = gate();
		const release = gate();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				entered.release();
				await release.promise;
				return fauxAssistantMessage("extension reply");
			},
		]);
		if (!api) throw new Error("Extension API was not loaded");
		const metadata = { request: "extension-private-7883" };
		const options = { metadata, expandPromptTemplates: false };
		const finished = onSettled(harness);
		const delivery: Promise<SendUserMessageResult> = api.sendUserMessage("from extension", options);
		const results: SendUserMessageResult[] = [];
		try {
			expect(delivery).toBeInstanceOf(Promise);
			void Promise.resolve(delivery).then((result) => results.push(result));
			await entered.promise;
			await setImmediate();
			expect(results).toHaveLength(1);
			expectRootMetadata(harness, results[0], metadata);
			expect(harness.eventsOfType("agent_settled")).toEqual([]);
		} finally {
			release.release();
			await finished;
		}
		expect(results).toHaveLength(1);
	});

	// #7883: no-options and explicit default-options core sends retain Promise<void> and wait for the answer.
	it.each([undefined, {}])("preserves legacy core sends with options %j", async (options) => {
		const entered = gate();
		const release = gate();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				entered.release();
				await release.promise;
				return fauxAssistantMessage("legacy reply");
			},
		]);
		const results: unknown[] = [];
		const delivery = harness.session.sendUserMessage("legacy", options);
		void delivery.then((result) => results.push(result));
		try {
			await entered.promise;
			await setImmediate();
			expect(results).toEqual([]);
		} finally {
			release.release();
			await delivery;
		}
		expect(results).toEqual([undefined]);
		expect(userEntries(harness).map(metadataOf)).toEqual([undefined]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	// #7883: extension calls without metadata remain synchronous fire-and-forget calls.
	it("preserves the undefined legacy extension return", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		if (!api) throw new Error("Extension API was not loaded");
		let finished = onSettled(harness);
		expect(api.sendUserMessage("legacy no options")).toBeUndefined();
		await finished;
		finished = onSettled(harness);
		expect(api.sendUserMessage("legacy default options", {})).toBeUndefined();
		await finished;
		expect(userEntries(harness).map(metadataOf)).toEqual([undefined, undefined]);
	});
});
