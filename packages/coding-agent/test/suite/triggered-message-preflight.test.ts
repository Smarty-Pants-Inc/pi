import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type ExtensionAPI, HOST_CAPABILITIES } from "../../src/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const customTypes = (harness: Harness): string[] =>
	harness.session.messages.flatMap((message) =>
		message.role === "custom" ? [(message as { customType: string }).customType] : [],
	);

// A triggered custom message during a prompt's preflight (Smarty-Pants-Inc/pi-fabric#107 review F2):
// the session reports idle while input handlers run, and a run started then made the prompt fail
// with "Agent is already processing".
describe("sendMessage with triggerTurn during a prompt's preflight", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const withGatedInput = async (consume = false, hook: "input" | "before_agent_start" = "input") => {
		const entered = deferred();
		const release = deferred();
		let api: ExtensionAPI | undefined;
		let gate = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					// Registered first: this input handler runs before any other extension's.
					const hold = async (ctx: { isIdle(): boolean }): Promise<boolean> => {
						if (!gate) return false;
						gate = false;
						expect(ctx.isIdle()).toBe(true);
						entered.resolve();
						await release.promise;
						return true;
					};
					if (hook === "input") {
						pi.on("input", async (_event, ctx) =>
							(await hold(ctx)) && consume ? { action: "handled" as const } : undefined,
						);
					} else {
						pi.on("before_agent_start", async (_event, ctx) => {
							await hold(ctx);
						});
					}
				},
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		return {
			harness,
			entered,
			release,
			api: () => api!,
			arm: () => {
				gate = true;
			},
		};
	};

	it("declares the capability, and gives it to an extension through pi.hostCapabilities", async () => {
		expect(HOST_CAPABILITIES.triggeredMessageQueuesBehindPreflight).toBe(true);
		const { api } = await withGatedInput();
		expect(api().hostCapabilities.triggeredMessageQueuesBehindPreflight).toBe(true);
	});

	it("queues behind the prompt: the prompt runs, then the message, with no competing run", async () => {
		const { harness, entered, release, api, arm } = await withGatedInput();
		harness.setResponses([fauxAssistantMessage("answered the user"), fauxAssistantMessage("took the wake")]);
		arm();
		const prompt = harness.session.prompt("the user's prompt");
		await entered.promise;
		api().sendMessage(
			{ customType: "wake", content: "wake", display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		// Nothing started while the prompt is in preflight.
		expect(harness.faux.state.callCount).toBe(0);
		release.resolve();
		await expect(prompt).resolves.toBeUndefined();
		expect(getAssistantTexts(harness)).toEqual(["answered the user", "took the wake"]);
		expect(customTypes(harness)).toEqual(["wake"]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("queues a steer behind the prompt too", async () => {
		const { harness, entered, release, api, arm } = await withGatedInput();
		harness.setResponses([fauxAssistantMessage("answered the user"), fauxAssistantMessage("took the wake")]);
		arm();
		const prompt = harness.session.prompt("the user's prompt");
		await entered.promise;
		api().sendMessage({ customType: "wake", content: "wake", display: false }, { triggerTurn: true });
		release.resolve();
		await expect(prompt).resolves.toBeUndefined();
		// The steer joins the prompt's own run: one run, which holds both the prompt and the message.
		expect(harness.session.messages.map((message) => message.role).filter((role) => role !== "system")).toEqual([
			"user",
			"custom",
			"assistant",
		]);
		expect(customTypes(harness)).toEqual(["wake"]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("starts the message's own run when the preflight ends without a run (input consumed)", async () => {
		const { harness, entered, release, api, arm } = await withGatedInput(true);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("took the wake")]);
		await harness.session.prompt("first");
		arm();
		const prompt = harness.session.prompt("consumed by the input handler");
		await entered.promise;
		api().sendMessage(
			{ customType: "wake", content: "wake", display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		release.resolve();
		await prompt;
		const deadline = Date.now() + 5_000;
		while (getAssistantTexts(harness).length < 2 && Date.now() < deadline)
			await new Promise((r) => setTimeout(r, 20));
		expect(getAssistantTexts(harness)).toEqual(["first", "took the wake"]);
		expect(customTypes(harness)).toEqual(["wake"]);
	});

	it("still starts a run at once when no prompt is in preflight", async () => {
		const { harness, api } = await withGatedInput();
		harness.setResponses([fauxAssistantMessage("took the wake")]);
		api().sendMessage({ customType: "wake", content: "wake", display: false }, { triggerTurn: true });
		const deadline = Date.now() + 5_000;
		while (getAssistantTexts(harness).length < 1 && Date.now() < deadline)
			await new Promise((r) => setTimeout(r, 20));
		expect(harness.faux.state.callCount).toBe(1);
		expect(getAssistantTexts(harness)).toEqual(["took the wake"]);
	});

	it("queues behind a prompt held in before_agent_start", async () => {
		const { harness, entered, release, api, arm } = await withGatedInput(false, "before_agent_start");
		harness.setResponses([fauxAssistantMessage("answered the user"), fauxAssistantMessage("took the wake")]);
		arm();
		const prompt = harness.session.prompt("the user's prompt");
		await entered.promise;
		api().sendMessage(
			{ customType: "wake", content: "wake", display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		expect(harness.faux.state.callCount).toBe(0);
		release.resolve();
		await expect(prompt).resolves.toBeUndefined();
		expect(getAssistantTexts(harness)).toEqual(["answered the user", "took the wake"]);
		expect(customTypes(harness)).toEqual(["wake"]);
	});

	const waitForAssistants = async (harness: Harness, count: number) => {
		const deadline = Date.now() + 5_000;
		while (getAssistantTexts(harness).length < count && Date.now() < deadline)
			await new Promise((r) => setTimeout(r, 20));
	};

	// Review F1 on pi#74: with no assistant message yet, the message must still get its own run.
	it.each(["steer", "followUp"] as const)(
		"starts the run a %s asked for when a fresh session's first input is consumed",
		async (deliverAs) => {
			const { harness, entered, release, api, arm } = await withGatedInput(true);
			harness.setResponses([fauxAssistantMessage("took the wake")]);
			arm();
			const prompt = harness.session.prompt("consumed by the input handler");
			await entered.promise;
			api().sendMessage({ customType: "wake", content: "wake", display: false }, { triggerTurn: true, deliverAs });
			release.resolve();
			await prompt;
			await waitForAssistants(harness, 1);
			expect(getAssistantTexts(harness)).toEqual(["took the wake"]);
			expect(customTypes(harness)).toEqual(["wake"]);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	it("starts the run when the transcript ends with a custom message that started no turn", async () => {
		const { harness, entered, release, api, arm } = await withGatedInput(true);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("took the wake")]);
		await harness.session.prompt("first");
		api().sendMessage({ customType: "note", content: "note", display: false });
		expect(harness.session.messages.at(-1)?.role).toBe("custom");
		arm();
		const prompt = harness.session.prompt("consumed by the input handler");
		await entered.promise;
		api().sendMessage({ customType: "wake", content: "wake", display: false }, { triggerTurn: true });
		release.resolve();
		await prompt;
		await waitForAssistants(harness, 2);
		expect(getAssistantTexts(harness)).toEqual(["first", "took the wake"]);
		expect(customTypes(harness)).toEqual(["note", "wake"]);
	});

	it("does not run the held message twice when the consumed input came before a real prompt", async () => {
		const { harness, entered, release, api, arm } = await withGatedInput(true);
		harness.setResponses([fauxAssistantMessage("took the wake"), fauxAssistantMessage("next")]);
		arm();
		const prompt = harness.session.prompt("consumed");
		await entered.promise;
		api().sendMessage({ customType: "wake", content: "wake", display: false }, { triggerTurn: true });
		release.resolve();
		await prompt;
		await waitForAssistants(harness, 1);
		await harness.session.prompt("next");
		expect(getAssistantTexts(harness)).toEqual(["took the wake", "next"]);
		expect(customTypes(harness)).toEqual(["wake"]);
	});

	// pi#74 review F4: clearQueue clears a held triggered message too.
	it.each([true, false])("clearQueue drops a held message (input consumed: %s)", async (consume) => {
		const { harness, entered, release, api, arm } = await withGatedInput(consume);
		harness.setResponses([fauxAssistantMessage("answered the user"), fauxAssistantMessage("must not run")]);
		arm();
		const prompt = harness.session.prompt("the user's prompt");
		await entered.promise;
		api().sendMessage(
			{ customType: "wake", content: "wake", display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		harness.session.clearQueue();
		release.resolve();
		await prompt;
		await new Promise((r) => setTimeout(r, 200));
		expect(customTypes(harness)).toEqual([]);
		expect(getAssistantTexts(harness)).toEqual(consume ? [] : ["answered the user"]);
		expect(harness.faux.state.callCount).toBe(consume ? 0 : 1);
	});
});
