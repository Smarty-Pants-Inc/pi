import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBeforeSettleEvent, CustomMessageEntryDraft, TurnEndEvent } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { createHarness, type Harness } from "./harness.ts";

const first = "2026-10-04T11:00:00.000Z";
const received = "2026-10-04T11:01:00.000Z";
const effect = "2026-10-04T11:02:00.000Z";
const scenarios = [
	"ordinary",
	"stable-proxy",
	"1->3",
	"3->1",
	"negative",
	"fraction",
	"nan",
	"infinite",
	"overflow",
	"string",
	"object",
] as const;

function draft(customType: string): CustomMessageEntryDraft {
	return { type: "custom_message", customType, content: customType, display: false };
}

// pi#95 / PROV1-COR-002: the first observed selection length bounds every receipt and indexed read.
describe.each(["turn_end", "agent_before_settle"] as const)("%s boundary selection length", (boundary) => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		for (const h of harnesses.splice(0)) h.cleanup();
	});

	it.each(scenarios)("receives %s once through preview, commit, JSONL and reopen", async (scenario) => {
		const invalid = !["ordinary", "stable-proxy", "1->3", "3->1"].includes(scenario);
		let lengthReads = 0;
		let coercions = 0;
		const indexReads = [0, 0, 0];
		let prior: ReturnType<typeof getTurnProvenance>;
		let preview: ReturnType<typeof getTurnProvenance>[] = [];
		const errors: string[] = [];
		const h = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					const propose = () => ({ entries: [draft("Old")] });
					const select = (event: TurnEndEvent | AgentBeforeSettleEvent) => {
						prior = getTurnProvenance(
							event.context.contextEntries.find((entry) => entry.sourceEntry.type === "custom_message")
								?.sourceEntry,
						);
						vi.setSystemTime(received);
						if (invalid) {
							(event.entries[0] as CustomMessageEntryDraft).content = "edited Old";
							event.entries.push(draft("Retained"));
						}
						const selected = [draft("New"), draft("New2"), event.entries[0]];
						selected.forEach((entry, index) => {
							Object.defineProperty(selected, index, {
								enumerable: true,
								configurable: true,
								get() {
									indexReads[index]++;
									if (index === 0) vi.setSystemTime(effect);
									return entry;
								},
							});
						});
						const invalidLengths: Record<string, unknown> = {
							negative: -1,
							fraction: 1.5,
							nan: Number.NaN,
							infinite: Number.POSITIVE_INFINITY,
							overflow: 2 ** 32,
							string: "3",
							object: {
								[Symbol.toPrimitive]: () => {
									coercions++;
									return 3;
								},
							},
						};
						const proxy = new Proxy(selected, {
							get(target, property, receiver) {
								if (property === "length") {
									lengthReads++;
									if (invalid) return invalidLengths[scenario];
									if (scenario === "1->3") return lengthReads === 1 ? 1 : 3;
									if (scenario === "3->1") return lengthReads === 1 ? 3 : 1;
								}
								return Reflect.get(target, property, receiver);
							},
						});
						return { entries: scenario === "ordinary" ? selected : proxy };
					};
					const observe = (event: TurnEndEvent | AgentBeforeSettleEvent) => {
						preview = event.context.contextEntries
							.filter((entry) => entry.sourceEntry.type === "custom_message")
							.map((entry) => getTurnProvenance(entry.sourceEntry));
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
		h.session.extensionRunner.onError((error) => errors.push(error.error));
		h.setResponses([fauxAssistantMessage("done")]);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		await h.session.prompt("ordinary");

		const canonical = h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		const records = canonical.map(getTurnProvenance);
		const expectedTypes = invalid ? ["Old", "Retained"] : scenario === "1->3" ? ["New"] : ["New", "New2", "Old"];
		expect.soft(canonical.map((entry) => entry.customType)).toEqual(expectedTypes);
		expect.soft(lengthReads).toBe(scenario === "ordinary" ? 0 : 1);
		expect.soft(indexReads).toEqual(invalid ? [0, 0, 0] : scenario === "1->3" ? [1, 0, 0] : [1, 1, 1]);
		expect.soft(coercions).toBe(0);
		expect.soft(errors).toEqual(invalid ? ["Invalid array length"] : []);
		expect.soft(records).toEqual(preview);
		expect
			.soft(records.map((record) => record?.receivedAt))
			.toEqual(invalid ? [first, received] : scenario === "1->3" ? [received] : [received, received, first]);
		if (scenario !== "1->3") expect.soft(records[invalid ? 0 : 2]).toEqual(prior);
		if (invalid) expect.soft(canonical[0].content).toBe("edited Old");
		expect(new Set(records.map((record) => record?.turnId)).size).toBe(records.length);
		for (const record of records) {
			expect(record?.channel).toBe("terminal");
			expect(Object.keys(record!).sort()).toEqual(["channel", "receivedAt", "turnId", "v"]);
		}
		const physical = readFileSync(h.session.sessionFile!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string })
			.filter((entry) => entry.type === "custom_message");
		expect(physical).toEqual(canonical);
		expect(
			SessionManager.open(h.session.sessionFile!)
				.getEntries()
				.filter((entry) => entry.type === "custom_message"),
		).toEqual(canonical);
	});
});
