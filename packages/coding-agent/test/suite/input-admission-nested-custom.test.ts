import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

// smarty-dev#3048 / PR #110 R6-1: a custom message must never release its parent's held user admission.
describe("nested custom dispatch preserves the originating input's admission", () => {
	const harnesses: Harness[] = [];
	const releases: Array<() => void> = [];
	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		for (const h of harnesses.splice(0)) {
			await h.session.abort();
			h.session.clearQueue();
			h.cleanup();
		}
	});

	it.each(
		(["steer", "followUp"] as const).flatMap((entry) =>
			(["transform", "handled"] as const).map((action) => ({ entry, action })),
		),
	)(
		"idle $entry is refused after nested custom settlement, abort, and late $action completion",
		async ({ entry, action }) => {
			let release!: () => void;
			const held = new Promise<void>((done) => {
				release = done;
			});
			releases.push(release);
			let handlerFinished = false;
			const h = await createHarness({
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							if (event.text !== "held-A") return;
							pi.sendMessage(
								{ customType: "nested", content: "custom turn", display: false },
								{ triggerTurn: true },
							);
							await held;
							// The abandoned handler must not acquire fresh native or custom custody either.
							pi.sendUserMessage("late-native");
							pi.sendMessage(
								{ customType: "late-custom", content: "late custom", display: false },
								{ triggerTurn: true },
							);
							handlerFinished = true;
							return action === "handled" ? { action: "handled" } : { action: "transform", text: "late-A" };
						});
					},
				],
			});
			harnesses.push(h);
			h.setResponses([fauxAssistantMessage("custom reply"), fauxAssistantMessage("fresh reply")]);
			const errors: Array<{ event: string; error: string }> = [];
			h.session.extensionRunner.onError((error) => errors.push(error));
			const input = h.session[entry]("held-A");
			const receipt = input.then(
				() => ({ success: true }),
				(error: unknown) => ({ error }),
			);
			await vi.waitFor(() => {
				expect(h.eventsOfType("agent_settled")).toHaveLength(1);
				expect(h.session.isStreaming).toBe(false);
				expect(h.session.isSettling).toBe(false);
			});
			expect(
				h.session.messages.some((message) => message.role === "custom" && message.customType === "nested"),
			).toBe(true);
			expect(handlerFinished).toBe(false);
			expect(h.session.inputAdmissionCount).toBe(1);
			expect(h.session.isIdle).toBe(false);
			await h.session.abort();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				expect(
					await Promise.race([
						receipt,
						new Promise((done) => {
							timer = setTimeout(() => done("missing authoritative refusal"), 100);
						}),
					]),
				).toMatchObject({
					error: expect.objectContaining({ code: "INPUT_ADMISSION_ABORTED" }),
				});
			} finally {
				clearTimeout(timer);
			}
			expect(h.session.inputAdmissionCount).toBe(0);
			expect(h.session.isIdle).toBe(true);
			release();
			await vi.waitFor(() => {
				expect(handlerFinished).toBe(true);
				expect(errors).toHaveLength(2);
			});
			expect(errors).toEqual([
				expect.objectContaining({
					event: "send_user_message",
					error: expect.stringContaining("INPUT_ADMISSION_ABORTED"),
				}),
				expect.objectContaining({
					event: "send_message",
					error: expect.stringContaining("INPUT_ADMISSION_ABORTED"),
				}),
			]);
			await new Promise<void>((done) => setImmediate(done));
			expect(await receipt).toMatchObject({ error: expect.objectContaining({ code: "INPUT_ADMISSION_ABORTED" }) });
			expect(h.session.pendingMessageCount).toBe(0);
			expect(h.session.agent.getQueuedMessages()).toEqual([]);
			expect(getUserTexts(h)).toEqual([]);
			expect(h.eventsOfType("agent_start")).toHaveLength(1);
			expect(h.getPendingResponseCount()).toBe(1);
			await h.session.prompt("unrelated fresh input");
			expect(getUserTexts(h)).toEqual(["unrelated fresh input"]);
			expect(h.eventsOfType("agent_start")).toHaveLength(2);
			expect(h.eventsOfType("agent_settled")).toHaveLength(2);
			expect(h.session.pendingMessageCount).toBe(0);
			expect(h.session.isIdle).toBe(true);
		},
	);
});
