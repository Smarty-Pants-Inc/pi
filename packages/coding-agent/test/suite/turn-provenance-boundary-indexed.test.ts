import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBeforeSettleEvent, CustomMessageEntryDraft, TurnEndEvent } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { createHarness, type Harness } from "./harness.ts";

const first = "2026-10-01T12:00:00.000Z";
const later = "2026-10-01T12:01:00.000Z";
const scenarios = ["old-then-new", "new-then-old", "ordinary", "two-fresh"] as const;
type Scenario = (typeof scenarios)[number];

function draft(customType: string): CustomMessageEntryDraft {
	return { type: "custom_message", customType, content: customType, display: false };
}

function provenance(entries: Array<{ type: string }>) {
	return entries.map(getTurnProvenance);
}

// pi#95: indexed boundary selection is materialized once, so receipts match the selected references.
describe.each(["turn_end", "agent_before_settle"] as const)("%s indexed boundary receipts", (boundary) => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length) harnesses.pop()!.cleanup();
	});

	it.each(scenarios)("keeps %s occurrence order and receipt ownership", async (scenario: Scenario) => {
		let prior: ReturnType<typeof getTurnProvenance>;
		let preview: ReturnType<typeof getTurnProvenance>[] = [];
		let reads = 0;
		const h = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					const propose = () => ({ entries: [draft("old")] });
					const select = (event: TurnEndEvent | AgentBeforeSettleEvent) => {
						prior = getTurnProvenance(
							event.context.contextEntries.find((entry) => entry.sourceEntry.type === "custom_message")
								?.sourceEntry,
						);
						const old = event.entries[0];
						const fresh = draft("new");
						if (scenario === "ordinary") return { entries: [fresh, old] };
						const selected = scenario === "two-fresh" ? [fresh, draft("second-new"), old] : [fresh, old];
						Object.defineProperty(selected, "0", {
							enumerable: true,
							configurable: true,
							get() {
								vi.setSystemTime(later);
								reads++;
								if (scenario === "two-fresh") return reads === 1 ? fresh : old;
								return scenario === "old-then-new" ? (reads === 1 ? old : fresh) : reads === 1 ? fresh : old;
							},
						});
						return { entries: selected };
					};
					const observe = (event: TurnEndEvent | AgentBeforeSettleEvent) => {
						preview = provenance(
							event.context.contextEntries
								.filter((entry) => entry.sourceEntry.type === "custom_message")
								.map((entry) => entry.sourceEntry),
						);
					};
					if (boundary === "turn_end") {
						pi.on("turn_end", propose);
						pi.on("turn_end", select);
						pi.on("turn_end", observe);
					} else {
						pi.on("agent_before_settle", propose);
						pi.on("agent_before_settle", select);
						pi.on("agent_before_settle", observe);
					}
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("done")]);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		await h.session.prompt("start");

		const entries = h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		const records = provenance(entries);
		const reopened = SessionManager.open(h.session.sessionFile!)
			.getEntries()
			.filter((entry) => entry.type === "custom_message");
		const expectedTypes =
			scenario === "two-fresh"
				? ["new", "second-new", "old"]
				: scenario === "old-then-new"
					? ["old", "old"]
					: ["new", "old"];
		expect(entries.map((entry) => entry.customType)).toEqual(expectedTypes);
		expect(records).toEqual(preview);
		expect(reopened).toEqual(entries);
		const persisted = readFileSync(h.session.sessionFile!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string })
			.filter((entry) => entry.type === "custom_message");
		expect(persisted).toEqual(entries);
		expect(new Set(records.map((record) => record?.turnId)).size).toBe(records.length);
		for (const record of records) {
			expect(record?.channel).toBe("terminal");
			expect(Object.keys(record!).sort()).toEqual(["channel", "receivedAt", "turnId", "v"]);
		}
		if (scenario !== "ordinary") expect(reads).toBe(1);
		if (scenario === "two-fresh") {
			expect(records.slice(0, 2).map((record) => record?.receivedAt)).toEqual([first, first]);
			expect(records[2]).toEqual(prior);
		} else {
			expect(records[1]).toEqual(
				scenario === "old-then-new" ? expect.objectContaining({ receivedAt: first }) : prior,
			);
			expect(records[0]).toEqual(
				scenario === "old-then-new" ? prior : expect.objectContaining({ receivedAt: first }),
			);
			if (scenario === "old-then-new") expect(records[0]?.turnId).toBe(prior?.turnId);
			else expect(records[1]?.turnId).toBe(prior?.turnId);
		}
	});
});
