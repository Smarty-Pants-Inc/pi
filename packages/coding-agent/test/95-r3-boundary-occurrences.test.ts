import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { getTurnProvenance, type TurnProvenance } from "../src/core/turn-provenance.ts";
import type { BoundaryResult, BoundaryState, ExtensionAPI, ExtensionHandler } from "../src/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const FIRST = "2026-09-30T19:00:01.000Z";
const LATER = "2026-09-30T19:00:05.000Z";
const FINAL = "2026-09-30T19:00:09.000Z";
const FORGED: TurnProvenance = {
	v: 1,
	turnId: "11111111-1111-4111-8111-111111111111",
	receivedAt: "2000-01-01T00:00:00.000Z",
	channel: "keyboard",
	principal: { id: "paul", binding: "herdr-client" },
};

function records(entries: SessionEntry[]) {
	return entries.filter((entry) => entry.type === "custom_message").map(getTurnProvenance);
}

function preview(event: BoundaryState) {
	return records(event.context.contextEntries.map((entry) => entry.sourceEntry));
}

describe("pi#95 R3 boundary occurrence receipts", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	for (const boundary of ["turn_end", "agent_before_settle"] as const) {
		for (const { initialCount, reuseAdmitted } of [
			{ initialCount: 1, reuseAdmitted: false },
			{ initialCount: 2, reuseAdmitted: false },
			{ initialCount: 1, reuseAdmitted: true },
		]) {
			// pi#95: frozen draft reuse is a new occurrence, not a claim to its first receipt.
			it(`${boundary}: retains ${initialCount} first receipts and stamps held duplicates of ${reuseAdmitted ? "an admitted occurrence" : "the frozen draft"} independently`, async () => {
				const draft = Object.freeze({
					type: "custom_message" as const,
					customType: "boundary-occurrence",
					content: "untrusted hook input",
					display: true,
					provenance: FORGED,
					details: { provenance: FORGED },
				});
				let release!: () => void;
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				let markEntered!: () => void;
				const entered = new Promise<void>((resolve) => {
					markEntered = resolve;
				});
				const previews: Array<Array<TurnProvenance | undefined>> = [];
				const harness = await createHarness({
					persistSession: true,
					settings: { turnProvenance: { voiceExtensions: ["<inline:voice>"] } },
					extensionFactories: [
						{
							name: "voice",
							factory: (pi: ExtensionAPI) => {
								const onBoundary = (handler: ExtensionHandler<BoundaryState, BoundaryResult>) =>
									boundary === "turn_end" ? pi.on("turn_end", handler) : pi.on("agent_before_settle", handler);
								onBoundary(() => {
									vi.setSystemTime(new Date(FIRST));
									return { entries: Array.from({ length: initialCount }, () => draft), continue: false };
								});
								onBoundary(async (event) => {
									previews.push(preview(event));
									markEntered();
									await held;
									const repeated = reuseAdmitted ? event.entries[0] : draft;
									return { entries: [...event.entries, repeated, repeated] };
								});
								onBoundary((event) => {
									previews.push(preview(event));
									vi.setSystemTime(new Date(FINAL));
									return { entries: [...event.entries] };
								});
								onBoundary((event) => {
									previews.push(preview(event));
								});
							},
						},
					],
				});
				harnesses.push(harness);
				vi.useFakeTimers({ toFake: ["Date"] });
				harness.setResponses([fauxAssistantMessage("done")]);
				const prompt = harness.session.prompt("input");
				await entered;
				vi.setSystemTime(new Date(LATER));
				release();
				await prompt;
				const saved = records(harness.sessionManager.getEntries());
				expect(saved).toHaveLength(initialCount + 2);
				expect(saved.map((record) => record?.receivedAt)).toEqual([
					...Array.from({ length: initialCount }, () => FIRST),
					LATER,
					LATER,
				]);
				expect(new Set(saved.map((record) => record?.turnId)).size).toBe(saved.length);
				for (const record of saved) {
					expect(record).toEqual({
						v: 1,
						turnId: expect.stringMatching(
							/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
						),
						receivedAt: expect.any(String),
						channel: "terminal",
					});
					expect(Object.isFrozen(record)).toBe(true);
				}
				expect(previews.map((value) => value.length)).toEqual([initialCount, initialCount + 2, initialCount + 2]);
				// pi#95 R3: detached inspection snapshots retain exact receipt values, not canonical references.
				for (const value of previews) {
					for (let index = 0; index < value.length; index++) expect(value[index]).toEqual(saved[index]);
				}
				const appended = harness.eventsOfType("entry_appended").map((event) => event.entry);
				const appendedRecords = records(appended);
				expect(appendedRecords).toEqual(saved);
				for (let index = 0; index < saved.length; index++) expect(appendedRecords[index]).toEqual(saved[index]);
				const file = harness.sessionManager.getSessionFile()!;
				const jsonl = readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as SessionEntry);
				expect(records(jsonl)).toEqual(saved);
				const reopened = SessionManager.open(file, harness.tempDir);
				expect(records(reopened.getEntries())).toEqual(saved);
				expect(records(reopened.getBranch())).toEqual(saved);
				expect(draft.provenance).toBe(FORGED);
			});
		}
	}
});
