// pi#95 R10: reentrant dispatch must not delete the next compacting model switch's ticket.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { getTurnProvenance } from "../../../src/core/turn-provenance.ts";
import { createHarness, type Harness } from "../harness.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const harnesses: Harness[] = [];
afterEach(() => {
	vi.useRealTimers();
	while (harnesses.length) harnesses.pop()?.cleanup();
});

for (const deliverAs of ["steer", "followUp"] as const) {
	it.each(["success", "refusal", "abort"] as const)(
		`retains one original ${deliverAs} message through two feasible compactions: %s`,
		async (outcome) => {
			const firstEntered = gate();
			const firstRelease = gate();
			const secondEntered = gate();
			const secondRelease = gate();
			let compactions = 0;
			const summarizedMessageCounts: number[] = [];
			let settlements = 0;
			let secondSwitch: Promise<unknown> | undefined;
			const firstReceipt = "2026-10-01T12:00:01.000Z";
			const laterReceipt = "2026-10-01T12:00:05.000Z";
			const h = await createHarness({
				models: [
					{ id: "large", contextWindow: 100_000 },
					{ id: "medium", contextWindow: 32_000 },
					{ id: "small", contextWindow: 8_000 },
				],
				settings: {
					compaction: {
						enabled: true,
						reserveTokens: 1000,
						keepRecentTokens: 10_000,
						modelOverrides: { "faux/medium": { keepRecentTokens: 1 } },
					},
					retry: { enabled: false },
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							compactions++;
							summarizedMessageCounts.push(
								event.preparation.messagesToSummarize.length + event.preparation.turnPrefixMessages.length,
							);
							const second = compactions === 2;
							(second ? secondEntered : firstEntered).release();
							await (second ? secondRelease : firstRelease).promise;
							return {
								compaction: {
									// A completed but oversized summary refuses the second target; abort is separate.
									summary: second && outcome === "refusal" ? "z".repeat(32_000) : "small summary",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
						pi.on("agent_settled", async () => {
							settlements++;
							if (settlements === 1) await h.session.setModel(h.getModel("medium")!);
						});
						pi.on("agent_settled", async () => {
							if (settlements !== 1) return;
							secondSwitch = h.session.setModel(h.getModel("small")!).then(
								() => undefined,
								(error: unknown) => error,
							);
							await Promise.race([
								secondEntered.promise,
								secondSwitch.then((error) => {
									throw error ?? new Error("Second switch did not compact");
								}),
							]);
						});
					},
				],
			});
			harnesses.push(h);
			let queueCounts = { steering: 0, followUp: 0 };
			h.session.agent.observeLifecycle((event) => {
				queueCounts = { steering: event.steering, followUp: event.followUp };
			});
			h.session.agent.steeringMode = "all";
			h.session.agent.followUpMode = "all";
			h.sessionManager.appendMessage({ role: "user", content: "x".repeat(100_000), timestamp: Date.now() - 4000 });
			h.sessionManager.appendMessage({ ...fauxAssistantMessage("old"), timestamp: Date.now() - 3000 });
			h.sessionManager.appendMessage({ role: "user", content: "y".repeat(48_000), timestamp: Date.now() - 2000 });
			h.sessionManager.appendMessage({ ...fauxAssistantMessage("recent"), timestamp: Date.now() - 1000 });
			h.session.refreshContext();
			h.setResponses([fauxAssistantMessage("ordinary run"), fauxAssistantMessage("delivered once")]);
			const prompt = h.session.prompt("start");
			let delivery: Promise<void> | undefined;
			let aborting: Promise<void> | undefined;
			try {
				await Promise.race([
					firstEntered.promise,
					prompt.then(() => {
						throw new Error("First switch did not compact");
					}),
				]);
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(new Date(firstReceipt));
				// Public SDK ingress, outside either hook's async scope; a caller-supplied claim is refused.
				delivery = h.session.sendCustomMessage(
					{ customType: "reentrant", content: "accepted once", display: true, details: { marker: 95 } },
					{ triggerTurn: true, deliverAs, provenance: { channel: "voice", principal: { id: "paul" } } },
				);
				vi.setSystemTime(new Date(laterReceipt));
				firstRelease.release();
				await Promise.race([
					secondEntered.promise,
					prompt.then(() => {
						throw new Error("Second switch did not enter compaction");
					}),
				]);
				await vi.waitFor(() => expect(h.eventsOfType("agent_settled")).toHaveLength(1));
				// Drain settlement's deferred action while the second real compaction remains held.
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(compactions).toBe(2);
				expect(summarizedMessageCounts).toHaveLength(2);
				expect(summarizedMessageCounts.every((count) => count > 0)).toBe(true);
				expect(h.session.model?.id).toBe("medium");
				if (outcome === "abort") aborting = h.session.abort();
				secondRelease.release();
				const switched = await secondSwitch;
				await delivery;
				await prompt;
				await aborting;
				await h.session.waitForIdle();
				const entries = h.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message" && entry.customType === "reentrant");
				if (outcome === "success") {
					expect(switched).toBeUndefined();
					expect(entries).toHaveLength(1);
					expect(h.session.model?.id).toBe("small");
					expect(h.faux.state.callCount).toBe(2);
				} else {
					expect(switched).toBeInstanceOf(Error);
					expect(String(switched)).toContain(
						outcome === "refusal" ? "could not reduce context below 80%" : "Compaction aborted",
					);
					expect(entries).toHaveLength(0);
					expect(h.session.model?.id).toBe("medium");
					expect(h.faux.state.callCount).toBe(1);
					const retained = h.session.agent.peekQueuedMessages();
					expect(queueCounts).toEqual(
						deliverAs === "steer" ? { steering: 1, followUp: 0 } : { steering: 0, followUp: 1 },
					);
					expect(retained).toHaveLength(1);
					expect(retained[0]).toMatchObject({
						role: "custom",
						customType: "reentrant",
						content: "accepted once",
						display: true,
						details: { marker: 95 },
						timestamp: Date.parse(firstReceipt),
					});
					// Deliver retained input using the public API, then verify its original receipt.
					await h.session.prompt("resume retained input");
				}
				const delivered = h.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message" && entry.customType === "reentrant");
				expect(delivered).toHaveLength(1);
				expect(delivered[0]).toMatchObject({ content: "accepted once", display: true, details: { marker: 95 } });
				expect(getTurnProvenance(delivered[0])).toMatchObject({ channel: "terminal", receivedAt: firstReceipt });
				expect(h.session.agent.hasQueuedMessages()).toBe(false);
			} finally {
				firstRelease.release();
				secondRelease.release();
				await Promise.allSettled([prompt, delivery, secondSwitch, aborting]);
				await h.session.waitForIdle();
			}
		},
	);
}
