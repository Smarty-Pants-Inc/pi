import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// isSettling() means "a turn requested now is deferred past the remaining agent_settled handlers".
describe("ExtensionContext.isSettling", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is false in ordinary idle", async () => {
		let context: ExtensionContext | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", (_event, ctx) => {
						context = ctx;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		expect(harness.session.isSettling).toBe(false);
		await harness.session.prompt("hi");

		expect(context?.isIdle()).toBe(true);
		expect(context?.isSettling()).toBe(false);
		expect(harness.session.isSettling).toBe(false);
	});

	it("is true in every agent_settled handler, including a held async one, while a triggered turn is deferred", async () => {
		const held = deferred();
		const release = deferred();
		const observed: string[] = [];
		let heldContext: ExtensionContext | undefined;
		let settledCount = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", (_event, ctx) => {
						settledCount++;
						observed.push(`first:${settledCount}:idle=${ctx.isIdle()}:settling=${ctx.isSettling()}`);
						if (settledCount === 1)
							pi.sendMessage({ customType: "wake", content: "wake", display: false }, { triggerTurn: true });
					});
				},
				(pi) => {
					pi.on("agent_settled", async (_event, ctx) => {
						observed.push(`held:${settledCount}:settling=${ctx.isSettling()}`);
						if (settledCount !== 1) return;
						heldContext = ctx;
						held.resolve();
						await release.promise;
						observed.push(`held-resumed:settling=${ctx.isSettling()}`);
					});
				},
			],
		});
		harnesses.push(harness);
		const deferredRunSettling: boolean[] = [];
		harness.setResponses([
			fauxAssistantMessage("first"),
			() => {
				// The deferred turn has begun, so a turn requested now would not be deferred.
				deferredRunSettling.push(harness.session.isSettling);
				return fauxAssistantMessage("after wake");
			},
		]);

		const prompt = harness.session.prompt("hi");
		await held.promise;
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.isSettling).toBe(true);
		expect(heldContext?.isSettling()).toBe(true);
		// The triggered turn is deferred while the held handler runs.
		expect(harness.faux.state.callCount).toBe(1);

		release.resolve();
		await prompt;

		expect(harness.faux.state.callCount).toBe(2);
		expect(deferredRunSettling).toEqual([false]);
		expect(observed).toEqual([
			"first:1:idle=true:settling=true",
			"held:1:settling=true",
			"held-resumed:settling=true",
			"first:2:idle=true:settling=true",
			"held:2:settling=true",
		]);
		expect(harness.session.isSettling).toBe(false);
		expect(heldContext?.isSettling()).toBe(false);
	});

	it("tracks deferral exactly across two deferred prompts and a nested deferral", async () => {
		const observed: string[] = [];
		let settledCount = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", (_event, ctx) => {
						settledCount++;
						observed.push(`settled:${settledCount}:settling=${ctx.isSettling()}`);
						// First settlement defers A and B; A's settlement defers the nested prompt C.
						if (settledCount === 1) {
							pi.sendUserMessage("A");
							pi.sendUserMessage("B");
						} else if (settledCount === 2) {
							pi.sendUserMessage("C");
						}
					});
					pi.on("before_agent_start", (event, ctx) => {
						// A deferred prompt's pre-run handlers are outside agent_settled: a turn requested here is not deferred.
						observed.push(`before:${event.prompt}:idle=${ctx.isIdle()}:settling=${ctx.isSettling()}`);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("start done"),
			fauxAssistantMessage("A done"),
			fauxAssistantMessage("C done"),
			fauxAssistantMessage("B done"),
		]);

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(4);
		expect(observed).toEqual([
			"before:start:idle=true:settling=false",
			"settled:1:settling=true",
			"before:A:idle=true:settling=false",
			"settled:2:settling=true",
			"before:C:idle=true:settling=false",
			"settled:3:settling=true",
			"before:B:idle=true:settling=false",
			"settled:4:settling=true",
		]);
		expect(harness.session.isSettling).toBe(false);
		expect(harness.session.isIdle).toBe(true);
	});
});
