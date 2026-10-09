import { setImmediate } from "node:timers/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { SessionMessageEntry } from "../../../src/core/session-manager.ts";
import type { SendUserMessageResult } from "../../../src/core/user-message-metadata.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} still pending after 500 ms`)), 500);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function userEntries(harness: Harness): SessionMessageEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user");
}

function observeReceipt(receipt: Promise<SendUserMessageResult>) {
	const outcomes: unknown[] = [];
	const settled = receipt.then(
		(result) => {
			outcomes.push(result);
			return result;
		},
		(error: unknown) => {
			outcomes.push(error);
			return error;
		},
	);
	return { outcomes, settled };
}

describe("#7883 metadata receipt lifecycle boundaries", () => {
	const harnesses: Harness[] = [];
	const releases: Array<() => void> = [];

	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		for (const harness of harnesses.splice(0).reverse()) {
			await harness.session.abort();
			harness.cleanup();
		}
	});

	function runtimeFor(harness: Harness) {
		return new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("Unexpected receiving-session construction");
			},
		);
	}

	async function retainedInputs(deliverAs: "steer" | "followUp") {
		const entered = gate();
		const held = gate();
		releases.push(held.release);
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("input", async (event) => {
						if (event.text === "retained 1") {
							entered.release();
							await held.promise;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setSteeringMode("all");
		harness.session.setFollowUpMode("all");
		const model = harness.getModel();
		harness.sessionManager.appendMessage({ role: "user", content: "seed input", timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("seed reply", { timestamp: Date.now() - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 10_001,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 10_001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		harness.session.refreshContext();
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" })]);
		const metadata = [1, 2, 3].map((sequence) => ({ privateRequest: `retained-private-7883-${sequence}`, sequence }));
		const receipts = [
			observeReceipt(harness.session.sendUserMessage("retained 1", { metadata: metadata[0]!, deliverAs })),
		];
		await within(entered.promise, "input preflight");
		for (let index = 1; index < 3; index++) {
			receipts.push(
				observeReceipt(
					harness.session.sendUserMessage(`retained ${index + 1}`, { metadata: metadata[index]!, deliverAs }),
				),
			);
		}
		await setImmediate();
		expect(harness.session.agent.getQueuedMessages()).toHaveLength(2);
		held.release();
		await within(harness.session.waitForIdle(), "failed pre-prompt compaction");
		await setImmediate();
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				result: undefined,
				aborted: false,
				errorMessage: expect.stringContaining("insufficient_quota"),
			}),
		]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_start")).toEqual([]);
		expect(receipts.map((receipt) => receipt.outcomes.length)).toEqual([0, 0, 0]);
		const queued = harness.session.agent.getQueuedMessages();
		expect(queued).toHaveLength(3);
		expect(userEntries(harness)).toHaveLength(1);
		return { harness, receipts, metadata, queued, api: api! };
	}

	// #7883 / pi#187 round 2: released admissions no longer cover busy queue receipts.
	it.each(["steer", "followUp"] as const)(
		"abort settles every busy %s receipt once without losing recoverable metadata",
		async (deliverAs) => {
			const entered = gate();
			const held = gate();
			releases.push(held.release);
			const harness = await createHarness({ settings: { compaction: { enabled: false } } });
			harnesses.push(harness);
			harness.session.setSteeringMode("all");
			harness.session.setFollowUpMode("all");
			harness.setResponses([
				async () => {
					entered.release();
					await held.promise;
					return fauxAssistantMessage("aborted reply");
				},
			]);
			const running = harness.session.prompt("active input");
			await within(entered.promise, "active provider");
			const metadata = [1, 2, 3].map((sequence) => ({ privateRequest: `abort-private-7883-${sequence}`, sequence }));
			const receipts = metadata.map((item) =>
				observeReceipt(harness.session.sendUserMessage("same queued text", { metadata: item, deliverAs })),
			);
			await setImmediate();
			const queued = harness.session.agent.getQueuedMessages();
			expect(queued).toHaveLength(3);
			expect(receipts.map((receipt) => receipt.outcomes.length)).toEqual([0, 0, 0]);
			const aborting = harness.session.abort();
			held.release();
			await within(aborting, "agent abort");
			await running;
			const outcomes = await within(Promise.all(receipts.map((receipt) => receipt.settled)), "busy abort receipts");
			expect(outcomes).toEqual(
				metadata.map(() =>
					expect.objectContaining({ name: "InputAdmissionError", code: "INPUT_ADMISSION_ABORTED" }),
				),
			);
			expect(harness.session.agent.getQueuedMessages()).toEqual(queued);
			await harness.session.abort();
			let providerPayload = "";
			harness.setResponses([
				(context) => {
					providerPayload = JSON.stringify(context.messages);
					return fauxAssistantMessage("recovered reply");
				},
				fauxAssistantMessage("follow-up reply"),
			]);
			await harness.session.prompt("explicit recovery");
			expect(
				userEntries(harness)
					.filter((entry) => entry.metadata !== undefined)
					.map((entry) => entry.metadata),
			).toEqual(metadata);
			expect(providerPayload).not.toContain("abort-private-7883");
			expect(providerPayload).not.toContain('"metadata"');
			harness.session.clearQueue();
			harness.session.dispose();
			expect(receipts.map((receipt) => receipt.outcomes.length)).toEqual([1, 1, 1]);
			expect(receipts.map((receipt) => receipt.outcomes[0])).toEqual(outcomes);
		},
	);

	// #7883 / pi#187 round 2: /reload shares this session method and invalidates the old extension runtime.
	it.each(["steer", "followUp"] as const)("reload settles every retained %s receipt once", async (deliverAs) => {
		const { harness, receipts, queued } = await retainedInputs(deliverAs);
		const oldRunner = harness.session.extensionRunner;
		await within(harness.session.reload(), "session reload");
		expect(harness.session.extensionRunner).not.toBe(oldRunner);
		const outcomes = await within(Promise.all(receipts.map((receipt) => receipt.settled)), "reload receipts");
		expect(outcomes).toEqual(
			receipts.map(() => expect.objectContaining({ name: "InputAdmissionError", code: "INPUT_ADMISSION_ABORTED" })),
		);
		expect(harness.session.agent.getQueuedMessages()).toEqual(queued);
		harness.session.clearQueue();
		await harness.session.abort();
		harness.session.dispose();
		expect(receipts.map((receipt) => receipt.outcomes.length)).toEqual([1, 1, 1]);
		expect(userEntries(harness)).toHaveLength(1);
	});

	// #7883 / pi#187 round 2: shutdown-hook submissions cannot outlive their originating extension runtime.
	it.each(["steer", "followUp"] as const)(
		"reload settles every %s receipt created by shutdown hooks",
		async (deliverAs) => {
			const { harness, receipts, api } = await retainedInputs(deliverAs);
			const held = gate();
			releases.push(held.release);
			const shutdownReceipts: ReturnType<typeof observeReceipt>[] = [];
			api.on("input", async (event) => {
				if (event.text.startsWith("shutdown input")) await held.promise;
			});
			api.on("session_shutdown", () => {
				for (let index = 0; index < 3; index++)
					shutdownReceipts.push(
						observeReceipt(api.sendUserMessage(`shutdown input ${index}`, { metadata: { index }, deliverAs })),
					);
			});
			await within(harness.session.reload(), "reload with shutdown input");
			expect(shutdownReceipts).toHaveLength(3);
			const allReceipts = [...receipts, ...shutdownReceipts];
			const outcomes = await within(
				Promise.all(allReceipts.map((receipt) => receipt.settled)),
				"shutdown hook receipts",
			);
			expect(outcomes).toEqual(allReceipts.map(() => expect.objectContaining({ code: "INPUT_ADMISSION_ABORTED" })));
			await within(harness.session.abort(), "shutdown input cancellation");
			held.release();
			harness.session.clearQueue();
			harness.session.dispose();
			expect(allReceipts.map((receipt) => receipt.outcomes.length)).toEqual(Array(6).fill(1));
		},
	);

	// #7883 / pi#187 round 2: compaction retention is not completion; each explicit terminal boundary is bounded.
	it.each(
		(["steer", "followUp"] as const).flatMap((deliverAs) =>
			(["clearQueue", "abort", "session-end"] as const).map((boundary) => [deliverAs, boundary] as const),
		),
	)("unrecovered compaction %s receipts settle once at %s", async (deliverAs, boundary) => {
		const { harness, receipts, queued } = await retainedInputs(deliverAs);
		if (boundary === "clearQueue") {
			const cleared = harness.session.clearQueue();
			expect([...cleared.steering, ...cleared.followUp]).toEqual(queued.map(getMessageText));
		} else if (boundary === "abort") {
			await within(harness.session.abort(), "abort retained input");
			expect(harness.session.agent.getQueuedMessages()).toEqual(queued);
		} else {
			const rejectedInput = vi.fn();
			await within(runtimeFor(harness).dispose({ terminal: true, rejectQueuedInput: rejectedInput }), "session end");
			expect(rejectedInput).toHaveBeenCalledExactlyOnceWith(queued, harness.session);
			expect(harness.session.isDisposed).toBe(true);
		}
		const outcomes = await within(
			Promise.all(receipts.map((receipt) => receipt.settled)),
			`${boundary} compaction receipts`,
		);
		expect(outcomes).toEqual(
			receipts.map(() => expect.objectContaining({ name: "InputAdmissionError", code: "INPUT_ADMISSION_ABORTED" })),
		);
		harness.session.clearQueue();
		await harness.session.abort();
		harness.session.dispose();
		expect(receipts.map((receipt) => receipt.outcomes.length)).toEqual([1, 1, 1]);
		expect(receipts.map((receipt) => receipt.outcomes[0])).toEqual(outcomes);
		expect(userEntries(harness)).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(1);
	});

	// #7883: preserve intentional replacement/disposal refusal until the host recovers the queues.
	it("replacement and direct disposal refuse retained input, then clear settles all receipts before replacement", async () => {
		const { harness, receipts, queued } = await retainedInputs("followUp");
		const runtime = runtimeFor(harness);
		await expect(runtime.newSession()).rejects.toMatchObject({ code: "INPUT_ADMISSION_BUSY" });
		expect(() => harness.session.dispose()).toThrow("INPUT_ADMISSION_BUSY");
		expect(harness.session.agent.getQueuedMessages()).toEqual(queued);
		expect(receipts.map((receipt) => receipt.outcomes.length)).toEqual([0, 0, 0]);
		harness.session.clearQueue();
		await within(Promise.all(receipts.map((receipt) => receipt.settled)), "cleared replacement receipts");
		// This factory intentionally stops at construction: outgoing disposal has already completed.
		await expect(runtime.newSession()).rejects.toThrow("Unexpected receiving-session construction");
		expect(harness.session.isDisposed).toBe(true);
		expect(receipts.map((receipt) => receipt.outcomes.length)).toEqual([1, 1, 1]);
	});

	// #7883: a recovery before a cancellation/clear boundary still resolves the original admission receipt.
	it.each(["steer", "followUp"] as const)(
		"recovery persists retained %s metadata and resolves every receipt",
		async (deliverAs) => {
			const { harness, receipts, metadata } = await retainedInputs(deliverAs);
			harness.session.setAutoCompactionEnabled(false);
			harness.setResponses([fauxAssistantMessage("recovered response"), fauxAssistantMessage("follow-up response")]);
			await harness.session.prompt("explicit recovery");
			const outcomes = await within(
				Promise.all(receipts.map((receipt) => receipt.settled)),
				"recovered compaction receipts",
			);
			for (const [index, outcome] of outcomes.entries()) {
				expect(outcome).toMatchObject({
					status: "turnStarted",
					entryId: expect.any(String),
					metadata: metadata[index],
				});
				const entry = userEntries(harness).find((entry) => entry.id === (outcome as SendUserMessageResult).entryId);
				expect(entry?.metadata).toEqual(metadata[index]);
			}
			expect(receipts.map((receipt) => receipt.outcomes.length)).toEqual([1, 1, 1]);
			expect(harness.session.agent.getQueuedMessages()).toEqual([]);
		},
	);

	// #7883 / pi#187 round 2: exercise Pi's default history AND split-turn summaries, not an extension substitute.
	it("excludes metadata keys and values from compaction preparation, summarizer requests and provider messages", async () => {
		const marker = "never-summarize-private-7883-r2";
		const metadataKey = "opaqueAdmissionKey7883";
		const preparationMessages: AgentMessage[][] = [];
		const summaryRequests: string[] = [];
		const providerRequests: string[] = [];
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						preparationMessages.push(structuredClone(event.preparation.messagesToSummarize));
						preparationMessages.push(structuredClone(event.preparation.turnPrefixMessages));
						// The raw branch still owns metadata; only the summarizer messages exclude it.
						expect(JSON.stringify(event.branchEntries)).toContain(marker);
					});
				},
			],
		});
		harnesses.push(harness);
		const providerResponse: FauxResponseFactory = (context) => {
			providerRequests.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("ordinary response");
		};
		harness.setResponses([providerResponse, providerResponse]);
		for (const text of ["first input to summarize", "second input to summarize"]) {
			await harness.session.sendUserMessage(text, { metadata: { [metadataKey]: marker } });
			await harness.session.waitForIdle();
		}
		const summaryResponse: FauxResponseFactory = (context) => {
			summaryRequests.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("safe generated summary");
		};
		harness.setResponses([summaryResponse, summaryResponse]);
		await harness.session.compact();
		expect(preparationMessages).toHaveLength(2);
		expect(preparationMessages.every((messages) => messages.length > 0)).toBe(true);
		expect(preparationMessages[0]!.map(getMessageText)).toContain("first input to summarize");
		expect(preparationMessages[1]!.map(getMessageText)).toContain("second input to summarize");
		expect(summaryRequests).toHaveLength(2);
		expect(summaryRequests[0]).toContain("first input to summarize");
		expect(summaryRequests[1]).toContain("second input to summarize");
		harness.setResponses([providerResponse]);
		await harness.session.prompt("continue after compaction");
		expect(providerRequests).toHaveLength(3);
		for (const payload of [JSON.stringify(preparationMessages), ...summaryRequests, ...providerRequests]) {
			expect(payload).not.toContain(marker);
			expect(payload).not.toContain(metadataKey);
			expect(payload).not.toContain('"metadata"');
			expect(payload).not.toContain('"metadataSource"');
		}
		expect(userEntries(harness).filter((entry) => entry.metadata?.[metadataKey] === marker)).toHaveLength(2);
	});
});
