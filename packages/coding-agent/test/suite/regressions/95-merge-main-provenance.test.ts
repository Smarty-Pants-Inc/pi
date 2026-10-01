// pi#95: main's preview caching and model-switch redispatch must retain per-occurrence first receipts.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { getTurnProvenance, type TurnProvenance } from "../../../src/core/turn-provenance.ts";
import type { BoundaryResult, BoundaryState, ExtensionAPI, ExtensionHandler } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const FIRST = "2026-09-30T19:00:01.000Z";
const LATER = "2026-09-30T19:00:05.000Z";
const harnesses: Harness[] = [];

afterEach(() => {
	vi.useRealTimers();
	while (harnesses.length) harnesses.pop()?.cleanup();
});

it.each(["steer", "followUp"] as const)(
	"retains a trusted voice receipt through %s model-switch redispatch",
	async (deliverAs) => {
		let api: ExtensionAPI | undefined;
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let markEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const h = await createHarness({
			models: [
				{ id: "opus", contextWindow: 100_000 },
				{ id: "sol", contextWindow: 16_000 },
			],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 },
				retry: { enabled: false },
				turnProvenance: { voiceExtensions: ["<inline:voice>"] },
			},
			extensionFactories: [
				{
					name: "voice",
					factory: (pi) => {
						api = pi;
						pi.on("session_before_compact", async (event) => {
							markEntered();
							await held;
							return {
								compaction: {
									summary: "small summary",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				},
			],
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
		h.sessionManager.appendMessage({ ...fauxAssistantMessage("old"), timestamp: Date.now() - 1000 });
		h.session.refreshContext();
		h.setResponses([fauxAssistantMessage("delivered")]);
		const switching = h.session.setModel(h.getModel("sol")!);
		try {
			await entered;
			if (!api) throw new Error("extension API not bound");
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(FIRST));
			api.sendMessage(
				{ customType: "held-voice", content: "accepted once", display: true },
				{
					triggerTurn: true,
					deliverAs,
					provenance: { channel: "voice", principal: { id: "paul" } },
				},
			);
			vi.setSystemTime(new Date(LATER));
			release();
			await switching;
			await h.session.waitForIdle();
			const entries = h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "held-voice");
			expect(entries).toHaveLength(1);
			expect(getTurnProvenance(entries[0])).toMatchObject({
				channel: "voice",
				receivedAt: FIRST,
				principal: { id: "paul", binding: "voice-call" },
			});
			expect(h.session.model?.id).toBe("sol");
			expect(h.faux.state.callCount).toBe(1);
		} finally {
			release();
			await switching;
			await h.session.waitForIdle();
		}
	},
);

it("retains a trusted voice receipt deferred by settlement handlers", async () => {
	let sent = false;
	const h = await createHarness({
		settings: { turnProvenance: { voiceExtensions: ["<inline:voice>"] } },
		extensionFactories: [
			{
				name: "voice",
				factory: (pi) => {
					pi.on("agent_settled", () => {
						if (sent) return;
						sent = true;
						vi.setSystemTime(new Date(FIRST));
						pi.sendMessage(
							{ customType: "settled-voice", content: "accepted once", display: true },
							{
								triggerTurn: true,
								provenance: { channel: "voice", principal: { id: "paul" } },
							},
						);
					});
					pi.on("agent_settled", () => {
						vi.setSystemTime(new Date(LATER));
					});
				},
			},
		],
	});
	harnesses.push(h);
	vi.useFakeTimers({ toFake: ["Date"] });
	h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	await h.session.prompt("start");
	const entries = h.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "settled-voice");
	expect(entries).toHaveLength(1);
	expect(getTurnProvenance(entries[0])).toMatchObject({
		channel: "voice",
		receivedAt: FIRST,
		principal: { id: "paul", binding: "voice-call" },
	});
	expect(h.faux.state.callCount).toBe(2);
});

it.each(["turn_end", "agent_before_settle"] as const)(
	"stamps a new equal-valued %s occurrence despite cached preview equality",
	async (boundary) => {
		const draft = Object.freeze({
			type: "custom_message" as const,
			customType: "equal-draft",
			content: "same",
			display: true,
		});
		const previews: Array<TurnProvenance | undefined> = [];
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					const onBoundary = (handler: ExtensionHandler<BoundaryState, BoundaryResult>) =>
						boundary === "turn_end" ? pi.on("turn_end", handler) : pi.on("agent_before_settle", handler);
					onBoundary(() => {
						vi.setSystemTime(new Date(FIRST));
						return { entries: [draft], continue: false };
					});
					onBoundary((event) => {
						previews.push(getTurnProvenance(event.context.contextEntries.at(-1)!.sourceEntry));
						vi.setSystemTime(new Date(LATER));
						return { entries: [{ ...draft }] };
					});
					onBoundary((event) => {
						previews.push(getTurnProvenance(event.context.contextEntries.at(-1)!.sourceEntry));
					});
				},
			],
		});
		harnesses.push(h);
		vi.useFakeTimers({ toFake: ["Date"] });
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("start");
		const saved = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message")
			.map(getTurnProvenance);
		expect(saved).toHaveLength(1);
		expect(previews.map((record) => record?.receivedAt)).toEqual([FIRST, LATER]);
		expect(previews[0]?.turnId).not.toBe(previews[1]?.turnId);
		expect(saved[0]).toEqual(previews[1]);
		expect(saved[0]?.channel).toBe("terminal");
	},
);
