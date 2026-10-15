import { existsSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

// smarty-dev#12837: teardown must join cancellation before it releases admission or removes provider/files.
describe("suite harness cleanup", () => {
	it.each(["input", "settlement"] as const)("settles a held %s hook before disposal", async (phase) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const hold = async () => {
						entered.resolve();
						await release.promise;
					};
					if (phase === "input") pi.on("input", hold);
					else pi.on("agent_settled", hold);
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.bindExtensions({});
		const prompt = harness.session.prompt("go").catch((error: unknown) => error);
		await entered.promise;

		try {
			await harness.cleanup();
			await prompt;
			expect(harness.session.inputAdmissionCount).toBe(0);
			expect(harness.session.isIdle).toBe(true);
			expect(harness.session.isSettling).toBe(false);
			expect(existsSync(harness.tempDir)).toBe(false);
			expect(() => harness.session.dispose()).not.toThrow();
			await expect(harness.session.prompt("too late")).rejects.toThrow("INPUT_ADMISSION_SHUTDOWN");
		} finally {
			release.resolve();
			await prompt;
			await harness.cleanup();
		}
	});

	// Existing suite callers need not remember a special timeout-cleanup path.
	let unawaited: Harness | undefined;
	let pendingPrompt: Promise<unknown> | undefined;
	it("starts cleanup of a still-running faux turn without awaiting it", async () => {
		const entered = Promise.withResolvers<void>();
		unawaited = await createHarness();
		unawaited.setResponses([
			(_context, options) =>
				new Promise((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
						{ once: true },
					);
					entered.resolve();
				}),
		]);
		pendingPrompt = unawaited.session.prompt("go");
		await entered.promise;
		void unawaited.cleanup();
	});

	it("starts the next test only after the shared teardown joined that turn", async () => {
		expect(unawaited).toBeDefined();
		expect(unawaited!.session.isIdle).toBe(true);
		expect(unawaited!.session.isSettling).toBe(false);
		expect(existsSync(unawaited!.tempDir)).toBe(false);
		await pendingPrompt;
	});
});
