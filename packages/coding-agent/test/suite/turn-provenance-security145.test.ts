import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as boundaryReceipts from "../../src/core/extensions/boundary-receipts.ts";
import type { AgentBeforeSettleEvent, CustomMessageEntryDraft, TurnEndEvent } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { receiptRecord } from "../../src/core/turn-receipts.ts";
import { createHarness, type Harness } from "./harness.ts";

const first = "2026-10-01T12:00:00.000Z";
const later = "2026-10-01T12:01:00.000Z";
const harnesses: Harness[] = [];
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()!.cleanup();
});
function draft(customType: string): CustomMessageEntryDraft {
	return { type: "custom_message", customType, content: customType, display: false };
}

// pi#145 SR145-1/2: selection and continuation effects cannot move first receipt facts.
describe.each(["turn_end", "agent_before_settle"] as const)("%s first receipts", (boundary) => {
	it.each(
		(["entries", "length", "continue"] as const).flatMap((effect) =>
			[false, true].map((mixed) => ({ effect, mixed })),
		),
	)("survives a delayed $effect getter (mixed=$mixed)", async ({ effect, mixed }) => {
		let collected: ReturnType<typeof getTurnProvenance>;
		const receive = vi.spyOn(boundaryReceipts, "receiveBoundaryEntries");
		let prior: ReturnType<typeof getTurnProvenance>;
		let preview: ReturnType<typeof getTurnProvenance>[] = [];
		const h = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					const propose = () => ({ entries: mixed ? [draft("retained")] : [] });
					const select = (event: TurnEndEvent | AgentBeforeSettleEvent) => {
						prior = getTurnProvenance(
							event.context.contextEntries.find((e) => e.sourceEntry.type === "custom_message")?.sourceEntry,
						);
						event.entries.push(draft("fresh-one"), draft("fresh-two"));
						if (effect === "continue")
							return {
								get continue(): boolean {
									collected = receiptRecord(receive.mock.results.at(-1)?.value.receipts.at(-1));
									vi.setSystemTime(later);
									throw new Error("flag failed");
								},
							};
						if (effect === "entries")
							return {
								get entries() {
									vi.setSystemTime(later);
									return event.entries;
								},
							};
						return {
							entries: new Proxy(event.entries, {
								get(target, key, receiver) {
									if (key === "length") vi.setSystemTime(later);
									return Reflect.get(target, key, receiver);
								},
							}),
						};
					};
					const observe = (event: TurnEndEvent | AgentBeforeSettleEvent) => {
						preview = event.context.contextEntries
							.filter((e) => e.sourceEntry.type === "custom_message")
							.map((e) => getTurnProvenance(e.sourceEntry));
					};
					if (boundary === "turn_end") {
						pi.on(boundary, propose);
						pi.on(boundary, select);
						pi.on(boundary, observe);
					} else {
						pi.on(boundary, propose);
						pi.on(boundary, select);
						pi.on(boundary, observe);
					}
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("done")]);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		await h.session.prompt("start");
		const entries = h.sessionManager.getEntries().filter((e) => e.type === "custom_message");
		const records = entries.map(getTurnProvenance);
		expect(records).toEqual(preview);
		if (effect === "continue") expect(records.at(-1)).toEqual(collected);
		expect(records).toHaveLength(mixed ? 3 : 2);
		if (mixed) expect(records[0]).toEqual(prior);
		expect(records.map((r) => r?.receivedAt)).toEqual(records.map(() => first));
		expect(new Set(records.map((r) => r?.turnId)).size).toBe(records.length);
		expect(
			SessionManager.open(h.session.sessionFile!)
				.getEntries()
				.filter((e) => e.type === "custom_message"),
		).toEqual(entries);
		const physical = readFileSync(h.session.sessionFile!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string })
			.filter((e) => e.type === "custom_message");
		expect(physical).toEqual(entries);
	});

	// pi#145: unrelated structured-clone-compatible state is not JSON-normalized by previews.
	it.each(["bigint", "cycle", "date-map"] as const)("preserves %s state through boundary previews", async (kind) => {
		const cycle: { self?: unknown } = {};
		cycle.self = cycle;
		const data =
			kind === "bigint" ? 1n : kind === "cycle" ? cycle : { date: new Date(first), map: new Map([["key", 1]]) };
		let observed: unknown;
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					const propose = () => ({ entries: [draft("valid")] });
					const observe = (event: TurnEndEvent | AgentBeforeSettleEvent) => {
						observed = event.context.contextEntries.find((e) => e.sourceEntry.type === "custom")?.sourceEntry;
					};
					if (boundary === "turn_end") {
						pi.on(boundary, propose);
						pi.on(boundary, observe);
					} else {
						pi.on(boundary, propose);
						pi.on(boundary, observe);
					}
				},
			],
		});
		harnesses.push(h);
		h.sessionManager.appendCustomEntry("unrelated", data);
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("start");
		expect(h.sessionManager.getEntries().filter((e) => e.type === "custom_message")).toHaveLength(1);
		expect(observed).toMatchObject({ data });
	});
});
