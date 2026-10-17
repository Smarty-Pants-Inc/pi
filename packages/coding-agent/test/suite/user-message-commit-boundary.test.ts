import {
	fauxAssistantMessage,
	type ImageContent,
	recordThrottledLimitWait,
	THROTTLED_LIMIT_WAIT_MESSAGE,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptDisposition } from "../../src/core/agent-session.ts";
import { followUpReceived, promptReceived, receiveInput, steerReceived } from "../../src/core/received-input.ts";
import type { SessionEntry, SessionMessageEntry } from "../../src/core/session-manager.ts";
import { captureKeyboardTurnReceipt, receiptRecord } from "../../src/core/turn-receipts.ts";
import type { SendUserMessageResult } from "../../src/core/user-message-metadata.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const image: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
};

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

type UserEntry = SessionMessageEntry & { message: UserMessage };

function userEntries(harness: Harness): UserEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry): entry is UserEntry => entry.type === "message" && entry.message.role === "user");
}

describe("user-message public subscriber commit boundaries", () => {
	const harnesses: Harness[] = [];
	const releases: Array<() => void> = [];

	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0).reverse()) await harness.cleanup();
	});

	async function seededHarness(options: HarnessOptions = {}): Promise<Harness> {
		const harness = await createHarness({
			...options,
			tools: [],
			settings: {
				compaction: { enabled: false },
				retry: { enabled: false },
				images: { autoResize: false },
				...options.settings,
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed reply")]);
		await harness.session.prompt("seed");
		return harness;
	}

	// #3155: real Session subscription, awaited extension dispatch, native queue custody and faux continuation.
	it.each(["steer", "followUp"] as const)(
		"keeps an image-bearing %s visible after a failed awaited start, then commits it exactly once",
		async (behavior) => {
			const entered = gate();
			const held = gate();
			releases.push(held.release);
			let hold = true;
			const harness = await seededHarness({
				extensionFactories: [
					(pi) => {
						pi.on("message_start", async (event) => {
							if (event.message.role !== "user" || getMessageText(event.message) !== "queued image" || !hold)
								return;
							hold = false;
							entered.release();
							await held.promise;
						});
					},
				],
			});
			const receipt = captureKeyboardTurnReceipt("paul", "a".repeat(32), "2026-10-16T06:40:00.000Z");
			const input = receiveInput("queued image", [image], receipt);
			if (behavior === "steer") await steerReceived(harness.session, input);
			else await followUpReceived(harness.session, input);
			const [queued] = harness.session.agent.getQueuedMessages();
			let fail = true;
			harness.session.subscribe((event) => {
				if (event.type === "message_start" && event.message === queued && fail) {
					fail = false;
					throw new Error("public start failed");
				}
			});
			const running = harness.session.agent.continue({ fromQueuedMessages: true });
			await entered.promise;
			expect(harness.session.agent.getQueuedMessages()[0]).toBe(queued);
			held.release();
			await running;
			expect(harness.session.agent.getQueuedMessages()).toEqual([queued]);
			expect([...harness.session.getSteeringMessages(), ...harness.session.getFollowUpMessages()]).toEqual([
				"queued image",
			]);
			expect(harness.session.pendingMessageCount).toBe(1);
			expect(userEntries(harness).map((entry) => getMessageText(entry.message))).toEqual(["seed"]);
			expect(harness.session.state.errorMessage).toBe("public start failed");
			expect(harness.faux.state.callCount).toBe(1);

			harness.setResponses([
				(context) => {
					expect(
						context.messages.filter(
							(message) => message.role === "user" && getMessageText(message) === "queued image",
						),
					).toHaveLength(1);
					return fauxAssistantMessage("recovered");
				},
			]);
			await harness.session.agent.continue({ fromQueuedMessages: true });
			const committed = userEntries(harness).filter((entry) => getMessageText(entry.message) === "queued image");
			expect(committed).toHaveLength(1);
			expect(committed[0]?.message.content).toEqual([{ type: "text", text: "queued image" }, image]);
			expect(committed[0]?.provenance).toEqual(receiptRecord(receipt));
			expect(harness.session.agent.getQueuedMessages()).toEqual([]);
			expect(harness.session.pendingMessageCount).toBe(0);
			await expect(harness.session.agent.continue({ fromQueuedMessages: true })).rejects.toThrow(
				"No queued messages",
			);
			expect(userEntries(harness)).toHaveLength(2);
		},
	);

	// #3155: a failed start rejects its receipt as before, but recovery keeps occurrence-local metadata.
	it("retains queued metadata after a public start failure and appends it on explicit continuation", async () => {
		const entered = gate();
		const held = gate();
		const enqueued = gate();
		releases.push(held.release);
		const harness = await seededHarness();
		harness.setResponses([
			async () => {
				entered.release();
				await held.promise;
				return fauxAssistantMessage("active complete");
			},
		]);
		const running = harness.session.prompt("active").then(
			() => undefined,
			(error: unknown) => error,
		);
		await entered.promise;
		harness.session.subscribe((event) => {
			if (event.type === "queue_update" && event.steering.length === 1) enqueued.release();
		});
		const metadata = { request: "retained-metadata-3155" };
		const submitted = harness.session
			.sendUserMessage([{ type: "text", text: "queued metadata" }, image], { deliverAs: "steer", metadata })
			.then(
				(value) => value,
				(error: unknown) => error,
			);
		await enqueued.promise;
		const [queued] = harness.session.agent.getQueuedMessages();
		const unsubscribePublic = harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message === queued) throw new Error("queued start failed");
		});
		// Let the native failure reach the caller rather than Session's ordinary post-run drain.
		const unsubscribeNative = harness.session.agent.subscribe((event) => {
			if (
				event.type === "agent_end" &&
				event.messages.some(
					(message) => message.role === "assistant" && message.errorMessage === "queued start failed",
				)
			)
				throw new Error("end after failed start");
		});
		held.release();
		expect(await running).toMatchObject({ message: "end after failed start" });
		expect(await submitted).toMatchObject({ message: "queued start failed" });
		expect(harness.session.agent.getQueuedMessages()).toEqual([queued]);
		expect(harness.session.getSteeringMessages()).toEqual(["queued metadata"]);
		unsubscribePublic();
		unsubscribeNative();
		harness.setResponses([fauxAssistantMessage("recovered")]);
		await harness.session.agent.continue({ fromQueuedMessages: true });
		const entries = userEntries(harness).filter((entry) => getMessageText(entry.message) === "queued metadata");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ metadata, metadataSource: { kind: "sdk" } });
		expect(entries[0]?.message.content).toEqual([{ type: "text", text: "queued metadata" }, image]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	// #3155: matching display text must not consume a different queued occurrence or queue kind.
	it("does not hide equal-text queued inputs when a different direct input fails to start", async () => {
		const harness = await seededHarness();
		await harness.session.steer("equal", [image]);
		await harness.session.followUp("equal");
		const queued = harness.session.agent.getQueuedMessages();
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user" && !queued.includes(event.message)) {
				expect(harness.session.getSteeringMessages()).toEqual(["equal"]);
				expect(harness.session.getFollowUpMessages()).toEqual(["equal"]);
				throw new Error("different occurrence failed");
			}
		});
		await harness.session.agent.prompt("equal");
		expect(harness.session.agent.getQueuedMessages()).toEqual(queued);
		expect(harness.session.getSteeringMessages()).toEqual(["equal"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["equal"]);
		harness.setResponses([fauxAssistantMessage("steer reply"), fauxAssistantMessage("follow-up reply")]);
		await harness.session.agent.continue({ fromQueuedMessages: true });
		expect(userEntries(harness).map((entry) => getMessageText(entry.message))).toEqual(["seed", "equal", "equal"]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	// #3155: rollback cannot revive withdrawn input, a cleared queue, or an equal-text replacement.
	it.each(["withdraw", "clear", "clear-alias", "abort-clear"] as const)("no revival after %s", async (action) => {
		const entered = gate();
		const held = gate();
		releases.push(held.release);
		const harness = await seededHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_start", async (event) => {
						if (event.message.role !== "user" || getMessageText(event.message) !== "same") return;
						entered.release();
						await held.promise;
					});
				},
			],
		});
		await harness.session.steer("same", [image]);
		const [original] = harness.session.agent.getQueuedMessages();
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message === original)
				throw new Error("start failed after withdrawal");
		});
		const running = harness.session.agent.continue({ fromQueuedMessages: true });
		await entered.promise;
		let aborting: Promise<void> | undefined;
		if (action === "withdraw") harness.session.agent.removeQueuedMessages((message) => message === original);
		else {
			if (action === "abort-clear") aborting = harness.session.abort();
			harness.session.clearQueue();
		}
		await harness.session.steer("same");
		const [replacement] = harness.session.agent.getQueuedMessages();
		expect(replacement).not.toBe(original);
		// A new native slot may explicitly alias the cleared object; it is not the old display occurrence.
		if (action === "clear-alias") harness.session.agent.steer(original!);
		held.release();
		await running;
		await aborting;
		expect(harness.session.agent.getQueuedMessages()).toEqual(
			action === "clear-alias" ? [replacement, original] : [replacement],
		);
		expect(harness.session.getSteeringMessages()).toEqual(["same"]);
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(userEntries(harness)).toHaveLength(1);
	});

	// #3155: queue_update is fallible too, including the compensating notification.
	it.each([false, true])("restores display after queue_update fails (restore throws=%s)", async (failRestore) => {
		const harness = await seededHarness();
		await harness.session.steer("queued");
		const queued = harness.session.agent.getQueuedMessages();
		let armed = true;
		harness.session.subscribe((event) => {
			if (armed && event.type === "queue_update" && (event.steering.length === 0 || failRestore)) {
				throw new Error(event.steering.length === 0 ? "queue removal failed" : "queue restoration failed");
			}
		});
		await harness.session.agent.continue({ fromQueuedMessages: true });
		expect(harness.session.state.errorMessage).toBe("queue removal failed");
		expect(harness.session.agent.getQueuedMessages()).toEqual(queued);
		expect(harness.session.getSteeringMessages()).toEqual(["queued"]);
		expect(userEntries(harness)).toHaveLength(1);
		armed = false;
		harness.setResponses([fauxAssistantMessage("recovered")]);
		await harness.session.agent.continue({ fromQueuedMessages: true });
		expect(userEntries(harness)).toHaveLength(2);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	// #3155: the positive path keeps queue_update -> user start -> user end ordering.
	it("preserves normal queue publication and start/end order", async () => {
		const harness = await seededHarness();
		await harness.session.steer("queued");
		harness.events.length = 0;
		const countsAtStart: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") {
				countsAtStart.push(harness.session.pendingMessageCount);
			}
		});
		harness.setResponses([fauxAssistantMessage("reply")]);
		await harness.session.agent.continue({ fromQueuedMessages: true });
		expect(
			harness.events.flatMap((event) => {
				if (event.type === "queue_update") return [`queue:${event.steering.length}`];
				if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "user") {
					return [event.type];
				}
				return [];
			}),
		).toEqual(["queue:0", "message_start", "message_end"]);
		expect(countsAtStart).toEqual([0]);
	});

	// #3155: preserve the append and loader-owned receipt before the public end failure reaches native core.
	it("commits a source-bound receipt despite public end mutation and failure", async () => {
		let api!: ExtensionAPI;
		let submitted!: Promise<SendUserMessageResult>;
		const harness = await seededHarness({
			extensionFactories: [
				{
					path: "/extensions/commit-boundary.ts",
					factory: (pi) => {
						api = pi;
						pi.events.on("commit-boundary-submit", () => {
							submitted = pi.sendUserMessage("submitted user", {
								metadata: { request: "private-boundary-3155" },
							});
						});
						pi.on("message_end", (event) => {
							if (event.message.role === "user" && getMessageText(event.message) === "submitted user") {
								return { message: { ...event.message, content: "extension mutation" } };
							}
						});
					},
				},
			],
		});
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "extension mutation"
			) {
				event.message.content = "public mutation";
				throw new Error("public end failed");
			}
		});
		let entriesAtFailure: SessionMessageEntry[] = [];
		let receiptAtFailure: unknown;
		harness.session.agent.subscribe(async (event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "assistant" &&
				event.message.errorMessage === "public end failed"
			) {
				entriesAtFailure = userEntries(harness);
				receiptAtFailure = await submitted.then(
					(value) => value,
					(error: unknown) => error,
				);
			}
		});
		api.events.emit("commit-boundary-submit", undefined);
		const result = await submitted;
		await harness.session.waitForIdle();
		expect(result).toMatchObject({
			status: "turnStarted",
			entryId: expect.any(String),
			metadataSource: { kind: "extension", extensionPath: "/extensions/commit-boundary.ts" },
		});
		expect(receiptAtFailure).toEqual(result);
		expect(entriesAtFailure.find((entry) => entry.id === result.entryId)).toMatchObject({
			message: { role: "user", content: "public mutation" },
			metadata: { request: "private-boundary-3155" },
			metadataSource: result.metadataSource,
			provenance: { channel: "terminal" },
		});
		expect(harness.session.state.errorMessage).toBe("public end failed");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.getQueuedMessages()).toEqual([]);
		await expect(harness.session.agent.continue({ fromQueuedMessages: true })).rejects.toThrow("No queued messages");
		expect(userEntries(harness)).toHaveLength(2);
	});

	// #3155: end mutations must still downgrade keyboard attribution even when that listener throws.
	it("drops keyboard attribution for a public end mutation without losing the committed image input", async () => {
		const harness = await seededHarness();
		const receipt = captureKeyboardTurnReceipt("paul", "b".repeat(32), "2026-10-16T06:40:00.000Z");
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "attested"
			) {
				event.message.content = [{ type: "text", text: "changed" }, image];
				throw new Error("mutation observer failed");
			}
		});
		await promptReceived(harness.session, receiveInput("attested", [image], receipt));
		const entry = userEntries(harness).at(-1);
		expect(entry?.message.content).toEqual([{ type: "text", text: "changed" }, image]);
		const { turnId, receivedAt, submissionToken } = receiptRecord(receipt);
		expect(entry?.provenance).toEqual({ v: 1, turnId, receivedAt, submissionToken, channel: "terminal" });
		expect(entry?.provenance).not.toHaveProperty("principal");
		expect(harness.session.state.errorMessage).toBe("mutation observer failed");
		expect(harness.session.agent.getQueuedMessages()).toEqual([]);
	});

	// #3155: native listeners after Session append cannot undo a receipt; no-throw is the control.
	it.each([false, true])("commits once before a later native end listener (throws=%s)", async (throws) => {
		const harness = await seededHarness();
		let nativeEntry: SessionMessageEntry | undefined;
		harness.session.agent.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "control"
			) {
				nativeEntry = userEntries(harness).at(-1);
				if (throws) throw new Error("later native end failed");
			}
		});
		harness.setResponses([fauxAssistantMessage("control reply")]);
		const result = await harness.session.sendUserMessage("control", { metadata: { control: true } });
		await harness.session.waitForIdle();
		expect(result).toMatchObject({
			status: "turnStarted",
			entryId: nativeEntry?.id,
			metadataSource: { kind: "sdk" },
		});
		expect(nativeEntry?.metadata).toEqual({ control: true });
		expect(userEntries(harness)).toHaveLength(2);
		expect(harness.session.agent.getQueuedMessages()).toEqual([]);
		expect(harness.session.state.errorMessage).toBe(throws ? "later native end failed" : undefined);
		await expect(harness.session.agent.continue({ fromQueuedMessages: true })).rejects.toThrow("No queued messages");
	});

	// #3155: fail the real internal append boundary, not the bypassed public appendMessage method.
	it("keeps storage failure authoritative over a public end failure", async () => {
		const harness = await seededHarness();
		const storageFailure = new Error("user storage failed");
		const target = harness.sessionManager as unknown as { _appendEntry(entry: SessionEntry): void };
		const append = target._appendEntry.bind(target);
		vi.spyOn(target, "_appendEntry").mockImplementation((entry) => {
			if (entry.type === "message" && entry.message.role === "user") throw storageFailure;
			append(entry);
		});
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "user") throw new Error("public end also failed");
		});
		await expect(harness.session.sendUserMessage("storage input", { metadata: { storage: true } })).rejects.toBe(
			storageFailure,
		);
		await harness.session.waitForIdle();
		expect(harness.session.state.errorMessage).toBe("user storage failed");
		expect(userEntries(harness)).toHaveLength(1);
		expect(harness.session.agent.getQueuedMessages()).toEqual([]);
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(2);
	});

	// #3155: mandatory target RPC preflight reports no-run acceptance, not a fictitious started run.
	it.each(["command", "input"] as const)("reports handled %s without a run", async (kind) => {
		const harness = await seededHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("handled", { description: "Handled input", handler: async () => {} });
					pi.on("input", (event) => {
						if (event.text === "handled") return { action: "handled" };
					});
				},
			],
		});
		const order: string[] = [];
		await harness.session.prompt(kind === "command" ? "/handled" : "handled", {
			onInputTransferred: () => order.push("transferred"),
			preflightResult: (disposition) => order.push(disposition),
		});
		expect(order).toEqual(["transferred", "handled"]);
		expect(harness.session.inputAdmissionCount).toBe(0);
		expect(harness.faux.state.callCount).toBe(1);
		const receipt = await harness.session.sendUserMessage("handled", { metadata: { noRun: true } });
		expect(receipt).toMatchObject({ status: "handled", entryId: null, metadataSource: { kind: "sdk" } });
		expect(userEntries(harness)).toHaveLength(1);
	});

	// #3155: started is emitted once only after the prepared input reaches the original native Agent.
	it("reports started after awaited preflight and native transfer, not while input is still admitted", async () => {
		const entered = gate();
		const held = gate();
		releases.push(held.release);
		const harness = await seededHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.messageType !== "user" || event.prompt !== "new input") return;
						entered.release();
						await held.promise;
					});
				},
			],
		});
		const observed: Array<{ disposition: PromptDisposition; nativeActive: boolean; admissions: number }> = [];
		harness.setResponses([fauxAssistantMessage("new reply")]);
		const running = harness.session.prompt("new input", {
			preflightResult: (disposition) =>
				observed.push({
					disposition,
					nativeActive: harness.session.agent.signal !== undefined,
					admissions: harness.session.inputAdmissionCount,
				}),
		});
		await entered.promise;
		expect(observed).toEqual([]);
		expect(harness.session.inputAdmissionCount).toBe(1);
		held.release();
		await running;
		expect(observed).toEqual([{ disposition: "started", nativeActive: true, admissions: 0 }]);
		expect(userEntries(harness)).toHaveLength(2);
	});

	// #3155: queued preflight is acceptance of real queue custody, not a new run or completed user entry.
	it.each(["steer", "followUp"] as const)("reports queued %s during another run", async (behavior) => {
		const entered = gate();
		const held = gate();
		releases.push(held.release);
		const harness = await seededHarness();
		harness.setResponses([
			async () => {
				entered.release();
				await held.promise;
				return fauxAssistantMessage("active reply");
			},
		]);
		const running = harness.session.prompt("active");
		await entered.promise;
		const dispositions: PromptDisposition[] = [];
		await harness.session.prompt("queued preflight", {
			streamingBehavior: behavior,
			preflightResult: (disposition) => {
				expect(harness.session.agent.getQueuedMessages().map(getMessageText)).toEqual(["queued preflight"]);
				dispositions.push(disposition);
			},
		});
		expect(dispositions).toEqual(["queued"]);
		expect(userEntries(harness).map((entry) => getMessageText(entry.message))).toEqual(["seed", "active"]);
		harness.session.clearQueue();
		held.release();
		await running;
		expect(dispositions).toEqual(["queued"]);
	});

	// #3155: rejected preflight must leave RPC free to send its error response instead of an earlier success.
	it("does not report an accepted disposition for rejected input", async () => {
		const harness = await createHarness({ withConfiguredAuth: false, tools: [] });
		harnesses.push(harness);
		const dispositions: PromptDisposition[] = [];
		await expect(
			harness.session.prompt("rejected", {
				preflightResult: (disposition) => dispositions.push(disposition),
			}),
		).rejects.toThrow("No API key");
		expect(dispositions).toEqual([]);
		expect(harness.session.agent.getQueuedMessages()).toEqual([]);
		expect(harness.session.inputAdmissionCount).toBe(0);
		expect(harness.faux.state.callCount).toBe(0);
	});

	// #3155: retained input after failed compaction is not RPC preflight success and starts no native run.
	it("does not announce queued or started when compaction retains rejected input", async () => {
		const harness = await seededHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 100 }],
			settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("oversized seed"),
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
		harness.session.setAutoCompactionEnabled(true);
		const dispositions: PromptDisposition[] = [];
		const startsBefore = harness.eventsOfType("agent_start").length;
		await expect(
			harness.session.prompt("retained", {
				images: [image],
				preflightResult: (disposition) => dispositions.push(disposition),
			}),
		).rejects.toThrow("Input is retained");
		expect(dispositions).toEqual([]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(startsBefore);
		expect(harness.session.getSteeringMessages()).toEqual(["retained"]);
		expect(harness.session.agent.getQueuedMessages()).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(1);
	});

	// #3155: retained final throttle wait is bounded and one-shot, independent of ordinary retry settings.
	it.each([0, 31])("publishes the throttle wait notice only for an accepted bounded wait (%ss)", async (seconds) => {
		const harness = await seededHarness();
		const first = fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider throttled" });
		const second = fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider throttled again" });
		recordThrottledLimitWait(first, seconds);
		recordThrottledLimitWait(second, 0);
		harness.setResponses([first, second, fauxAssistantMessage("must not replay")]);
		await harness.session.prompt("throttled request");
		const notices = harness.eventsOfType("auto_retry_start");
		if (seconds === 0) {
			expect(notices).toEqual([
				expect.objectContaining({
					attempt: 1,
					maxAttempts: 1,
					delayMs: 0,
					waitMessage: THROTTLED_LIMIT_WAIT_MESSAGE,
				}),
			]);
			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.getPendingResponseCount()).toBe(1);
		} else {
			expect(notices).toEqual([]);
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.getPendingResponseCount()).toBe(2);
		}
	});

	// #3155: ordinary retry notices must not gain a provider throttle message or a fallback selection.
	it("omits waitMessage on an ordinary retry", async () => {
		const harness = await seededHarness({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } } });
		const model = harness.session.model;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("ordinary retry");
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_start")[0]).not.toHaveProperty("waitMessage");
		expect(harness.session.model).toBe(model);
	});
});
