import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { serializeSessionBranch } from "../src/core/session-export.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getTurnProvenance } from "../src/core/turn-provenance.ts";
import { createHarness } from "./suite/harness.ts";

const valid = {
	v: 1,
	turnId: "11111111-1111-4111-8111-111111111111",
	receivedAt: "2020-01-01T00:00:00.000Z",
	channel: "keyboard",
	principal: { id: "historical", binding: "herdr-client" },
};

describe("historical records and serializer neighbors", () => {
	test.each([undefined, null, 1, ["raw", { historical: true }], { v: 999, extra: { raw: true } }, valid])(
		"ordinary disk load preserves raw metadata %j without repair or backfill",
		(record) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-provenance-history-"));
			try {
				const file = join(dir, "history.jsonl");
				const header = { type: "session", version: 3, id: "old", cwd: dir, timestamp: "2020-01-01T00:00:00.000Z" };
				const entry = {
					type: "message",
					id: "user",
					parentId: null,
					timestamp: header.timestamp,
					message: { role: "user", content: "history", timestamp: 1 },
					provenance: record,
				};
				const before = `${[header, entry].map((e) => JSON.stringify(e)).join("\n")}\n`;
				writeFileSync(file, before);
				const m = SessionManager.open(file);
				expect(readFileSync(file, "utf8")).toBe(before);
				const slot = Object.getOwnPropertyDescriptor(m.getEntry("user")!, "provenance");
				expect(slot).toMatchObject({ value: record, enumerable: true, writable: false, configurable: false });
				if (record && typeof record === "object") expect(Object.isFrozen(slot!.value)).toBe(true);
				if (record === valid) expect(getTurnProvenance(m.getEntry("user"))).toEqual(valid);
				m.appendCustomEntry("after");
				const selected = JSON.parse(serializeSessionBranch(m).trim().split("\n")[1]);
				if (record === undefined) expect(selected).not.toHaveProperty("provenance");
				else expect(selected.provenance).toEqual(record);
				const fork = SessionManager.forkFrom(file, dir, dir);
				expect(Reflect.get(fork.getEntry("user")!, "provenance")).toEqual(record);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	test("context edits, compaction, branches, forks, JSONL and real HTML export never restamp", async () => {
		const h = await createHarness({ persistSession: true });
		try {
			h.setResponses([fauxAssistantMessage("saved")]);
			await h.session.prompt("admitted");
			const m = h.sessionManager;
			const user = m.getEntries().find((e) => e.type === "message" && e.message.role === "user")!;
			const custom = m.appendCustomMessageEntry("custom", "original", true);
			const original = [user.id, custom].map((id) => getTurnProvenance(m.getEntry(id)));
			m.appendContextEdit(custom, { content: "edited" });
			m.appendLabelChange(user.id, "kept");
			m.appendCompaction("summary", user.id, 1);
			const end = m.getLeafId()!;
			m.branch(user.id);
			m.branchWithSummary(user.id, "other branch");
			m.branch(end);
			const fork = SessionManager.forkFrom(m.getSessionFile()!, h.tempDir, h.tempDir);
			expect([user.id, custom].map((id) => getTurnProvenance(fork.getEntry(id)))).toEqual(original);
			m.createBranchedSession(end);
			expect([user.id, custom].map((id) => getTurnProvenance(m.getEntry(id)))).toEqual(original);
			const json = serializeSessionBranch(m)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect([user.id, custom].map((id) => json.find((e) => e.id === id).provenance)).toEqual(original);
			const html = await exportSessionToHtml(m, undefined, {
				outputPath: join(h.tempDir, "history.html"),
				themeName: "dark",
			});
			const encoded = readFileSync(html, "utf8").match(
				/<script id="session-data" type="application\/json">([^<]+)<\/script>/,
			)![1];
			const data = JSON.parse(Buffer.from(encoded, "base64").toString());
			expect(
				[user.id, custom].map((id) => data.entries.find((e: { id: string }) => e.id === id).provenance),
			).toEqual(original);
		} finally {
			h.cleanup();
		}
	});

	test("ordinary data/details keep inherited key-sensitive toJSON and frozen getter behavior on real disk writes", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-provenance-json-"));
		try {
			const details = Object.freeze(
				Object.defineProperty(
					Object.create({
						toJSON(this: { value: string }, key: string) {
							return { key, value: this.value };
						},
					}),
					"value",
					{
						enumerable: true,
						get: () => "getter",
					},
				),
			);
			const m = SessionManager.create(dir, dir);
			const custom = m.appendCustomMessageEntry("json", "text", true, details);
			const state = m.appendCustomEntry("json", details);
			m.appendMessage(fauxAssistantMessage("flush"));
			const reopened = SessionManager.open(m.getSessionFile()!);
			expect(Reflect.get(reopened.getEntry(custom)!, "details")).toEqual({ key: "details", value: "getter" });
			expect(Reflect.get(reopened.getEntry(state)!, "data")).toEqual({ key: "data", value: "getter" });
			expect(Reflect.get(m.getEntry(custom)!, "details")).toBe(details);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
