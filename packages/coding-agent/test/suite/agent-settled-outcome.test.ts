import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentActivityOutcome } from "../../src/core/extensions/types.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("agent_settled outcome", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** Records the outcome seen by an extension and by public session subscribers. */
	async function createObservedHarness(
		options: HarnessOptions = {},
		extensionFactories: ExtensionFactory[] = [],
	): Promise<{ harness: Harness; extensionOutcomes: AgentActivityOutcome[]; publicOutcomes: AgentActivityOutcome[] }> {
		const extensionOutcomes: AgentActivityOutcome[] = [];
		const publicOutcomes: AgentActivityOutcome[] = [];
		const harness = await createHarness({
			...options,
			extensionFactories: [
				...extensionFactories,
				(pi) => {
					pi.on("agent_settled", (event) => {
						extensionOutcomes.push(event.outcome);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") publicOutcomes.push(event.outcome);
		});
		return { harness, extensionOutcomes, publicOutcomes };
	}

	it("reports completed for a normal run", async () => {
		const { harness, extensionOutcomes, publicOutcomes } = await createObservedHarness();
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hi");

		expect(extensionOutcomes).toEqual(["completed"]);
		expect(publicOutcomes).toEqual(["completed"]);
	});

	it("reports error when the run ends on a provider error", async () => {
		const { harness, extensionOutcomes, publicOutcomes } = await createObservedHarness({
			settings: { retry: { enabled: false } },
		});
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request" })]);

		await harness.session.prompt("hi");

		expect(extensionOutcomes).toEqual(["error"]);
		expect(publicOutcomes).toEqual(["error"]);
	});

	// The failed threshold attempt is terminal only when its unchanged projection is over-window.
	// Extension cancellation remains terminal even when the projection fits.
	it.each([
		{ stop: "failure", expected: "completed", contextWindow: 2600 },
		{ stop: "over-window", expected: "error", contextWindow: 2200 },
		{ stop: "extension cancel", expected: "aborted", contextWindow: 2600 },
	] as const)(
		"reports $expected after pre-turn threshold compaction ($stop)",
		async ({ stop, expected, contextWindow }) => {
			let failSummary = false;
			let streamCalls = 0;
			const failedCompactions: Array<{ errorMessage?: string }> = [];
			const preparedTokens: number[] = [];
			const largeTool: AgentTool = {
				name: "large_result",
				label: "Large result",
				description: "Returns fitting results whose combined context crosses the compaction threshold",
				parameters: Type.Object({}),
				execute: async () => {
					failSummary = stop !== "extension cancel";
					const resultSize = 2000;
					return { content: [{ type: "text", text: `large-tool-result:${"x".repeat(resultSize)}` }], details: {} };
				},
			};
			const { harness, extensionOutcomes, publicOutcomes } = await createObservedHarness(
				{
					models: [{ id: "faux-1", contextWindow, maxTokens: 100 }],
					settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
					tools: [largeTool],
				},
				[
					(pi) => {
						pi.on("session_before_compact", (event) => {
							preparedTokens.push(event.preparation.tokensBefore);
							if (stop === "extension cancel") return { cancel: true };
						});
						pi.on("session_compact_failed", (event) => {
							failedCompactions.push(event);
						});
					},
				],
			);
			harness.setResponses([
				fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
				fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
				// pi#337: one 8 KiB result is intentionally repaired before summarization.
				// Three individually fitting results cross the threshold without triggering that repair.
				fauxAssistantMessage(
					Array.from({ length: 3 }, () => fauxToolCall("large_result", {})),
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage("summary after the first failed attempt"),
				fauxAssistantMessage("continued successfully"),
			]);
			const streamFunction = harness.session.agent.streamFunction;
			harness.session.agent.streamFunction = (...args) => {
				streamCalls++;
				if (failSummary) {
					if (stop === "failure") failSummary = false;
					throw new Error("summary generator blew up");
				}
				return streamFunction(...args);
			};

			await harness.session.prompt("seed old history");
			await harness.session.prompt("seed recent history");
			await harness.session.prompt("run the large tool");

			expect(harness.faux.state.callCount).toBeGreaterThanOrEqual(3);
			// Fitting failures continue with the next assistant request; over-window and cancelled runs stop.
			expect(streamCalls).toBe(stop === "failure" ? 6 : stop === "over-window" ? 4 : 3);
			expect(harness.eventsOfType("tool_execution_end")).toHaveLength(3);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toEqual([]);
			expect(preparedTokens.length).toBeGreaterThanOrEqual(1);
			expect(preparedTokens[0]).toBeGreaterThan(2600 - 400);
			expect(preparedTokens[0]).toBeLessThanOrEqual(2600);
			expect(harness.eventsOfType("compaction_start").length).toBeGreaterThanOrEqual(1);
			expect(harness.eventsOfType("compaction_start").every((event) => event.reason === "threshold")).toBe(true);
			expect(harness.eventsOfType("compaction_end")).toContainEqual(
				expect.objectContaining({
					type: "compaction_end",
					reason: "threshold",
					result: undefined,
					aborted: stop === "extension cancel",
					willRetry: false,
					errorMessage:
						stop === "failure" || stop === "over-window"
							? "Auto-compaction failed: summary generator blew up"
							: undefined,
				}),
			);
			if (stop === "failure" || stop === "over-window") {
				expect(failedCompactions.length).toBeGreaterThanOrEqual(1);
				expect(failedCompactions[0]).toMatchObject({
					errorMessage: "Auto-compaction failed: summary generator blew up",
				});
			} else if (stop === "extension cancel") {
				expect(failedCompactions).toMatchObject([{ aborted: true, reason: "threshold" }]);
			} else {
				expect(failedCompactions).toEqual([]);
			}
			expect(extensionOutcomes).toEqual(["completed", "completed", expected]);
			expect(publicOutcomes).toEqual(["completed", "completed", expected]);
		},
	);

	it("reports aborted when the user aborts during a provider request", async () => {
		const { harness, extensionOutcomes, publicOutcomes } = await createObservedHarness();
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);
		const streaming = deferred();
		harness.session.subscribe((event) => {
			if (event.type === "message_update") streaming.resolve();
		});

		const prompt = harness.session.prompt("hi");
		await streaming.promise;
		await harness.session.abort();
		await prompt;

		expect(extensionOutcomes).toEqual(["aborted"]);
		expect(publicOutcomes).toEqual(["aborted"]);
	});

	it("reports aborted when the user aborts during retry backoff", async () => {
		const { harness, extensionOutcomes, publicOutcomes } = await createObservedHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 60_000 } },
		});
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		const backoff = deferred();
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") backoff.resolve();
		});

		const prompt = harness.session.prompt("hi");
		await backoff.promise;
		await harness.session.abort();
		await prompt;

		expect(harness.faux.state.callCount).toBe(1);
		expect(extensionOutcomes).toEqual(["aborted"]);
		expect(publicOutcomes).toEqual(["aborted"]);
	});

	it("reports aborted when the user aborts during another extension's agent_before_settle handler", async () => {
		const started = deferred();
		const release = deferred();
		let blockOnce = true;
		const { harness, extensionOutcomes, publicOutcomes } = await createObservedHarness({}, [
			(pi) => {
				pi.on("agent_before_settle", async () => {
					if (!blockOnce) return;
					blockOnce = false;
					started.resolve();
					await release.promise;
					return { continue: true };
				});
			},
		]);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		const prompt = harness.session.prompt("start");
		await started.promise;
		const abort = harness.session.abort();
		release.resolve();
		await Promise.all([prompt, abort]);

		// The assistant message completed; only the abort flag marks the run aborted.
		expect(harness.faux.state.callCount).toBe(1);
		expect(extensionOutcomes).toEqual(["aborted"]);
		expect(publicOutcomes).toEqual(["aborted"]);

		// The abort does not leak into the next run.
		await harness.session.prompt("again");
		expect(extensionOutcomes).toEqual(["aborted", "completed"]);
		expect(publicOutcomes).toEqual(["aborted", "completed"]);
	});
});
