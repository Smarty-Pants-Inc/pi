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

	// A pre-turn compaction stop aborts the agent loop, which records an aborted synthetic turn.
	// The compaction result, not that turn, decides the outcome.
	it.each([
		{ stop: "failure", expected: "error" },
		{ stop: "extension cancel", expected: "aborted" },
	] as const)(
		"reports $expected when pre-turn threshold compaction stops the run ($stop)",
		async ({ stop, expected }) => {
			let failSummary = false;
			const largeTool: AgentTool = {
				name: "large_result",
				label: "Large result",
				description: "Returns enough content to cross the compaction threshold",
				parameters: Type.Object({}),
				execute: async () => {
					failSummary = stop === "failure";
					return { content: [{ type: "text", text: `large-tool-result:${"x".repeat(8000)}` }], details: {} };
				},
			};
			const { harness, extensionOutcomes, publicOutcomes } = await createObservedHarness(
				{
					models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
					settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
					tools: [largeTool],
				},
				stop === "extension cancel"
					? [
							(pi) => {
								pi.on("session_before_compact", () => ({ cancel: true }));
							},
						]
					: [],
			);
			harness.setResponses([
				fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
				fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
				fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("must not run"),
			]);
			const streamFunction = harness.session.agent.streamFunction;
			harness.session.agent.streamFunction = (...args) => {
				if (failSummary) throw new Error("summary generator blew up");
				return streamFunction(...args);
			};

			await harness.session.prompt("seed old history");
			await harness.session.prompt("seed recent history");
			await harness.session.prompt("run the large tool");

			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				reason: "threshold",
				aborted: stop === "extension cancel",
			});
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
