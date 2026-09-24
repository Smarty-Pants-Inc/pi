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

	it("is true in every agent_settled handler, including a held async one, until deferred actions complete", async () => {
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
						// Deferred past the remaining handlers because agent_settled is still being emitted.
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
				// The deferred run is itself a pending settled action.
				deferredRunSettling.push(harness.session.isSettling);
				return fauxAssistantMessage("after wake");
			},
		]);

		const prompt = harness.session.prompt("hi");
		await held.promise;
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.isSettling).toBe(true);
		expect(heldContext?.isSettling()).toBe(true);
		// The deferred turn has not started while the held handler runs.
		expect(harness.faux.state.callCount).toBe(1);

		release.resolve();
		await prompt;

		expect(harness.faux.state.callCount).toBe(2);
		expect(deferredRunSettling).toEqual([true]);
		expect(observed).toEqual([
			"first:1:idle=true:settling=true",
			"held:1:settling=true",
			"held-resumed:settling=true",
			"first:2:idle=true:settling=true",
			"held:2:settling=true",
		]);
		expect(harness.session.isSettling).toBe(false);
		expect(heldContext?.isSettling()).toBe(false);
		expect(harness.session.isIdle).toBe(true);
	});
});
