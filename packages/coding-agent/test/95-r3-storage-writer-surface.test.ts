// pi#95 R3: writable setup managers must not expose a raw provenance-bearing JSONL writer.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { getTurnProvenance, type TurnProvenance } from "../src/core/turn-provenance.ts";

function receipts(entries: SessionEntry[]) {
	return entries.map(getTurnProvenance).filter(Boolean);
}

describe("pi#95 R3 raw storage writer surface", () => {
	for (const channel of ["keyboard", "voice", "fabric"] as const) {
		it(`does not expose a raw writer for caller-selected ${channel} attribution`, () => {
			const root = mkdtempSync(join(tmpdir(), "pi95-r3-writer-"));
			try {
				const manager = SessionManager.create(root, root);
				manager.appendMessage({ role: "user", content: "legitimate public input", timestamp: 1 });
				manager.appendMessage(fauxAssistantMessage("flush"));
				const file = manager.getSessionFile()!;
				const expected = receipts(manager.getEntries());
				const provenance: TurnProvenance = {
					v: 1,
					turnId: "11111111-1111-4111-8111-111111111111",
					receivedAt: "2000-01-01T00:00:00.000Z",
					channel,
					...(channel === "fabric"
						? { sender: { id: "session:attacker", kind: "main" as const, verified: "mesh" as const } }
						: {
								principal: {
									id: "attacker",
									binding: channel === "keyboard" ? ("herdr-client" as const) : ("voice-call" as const),
								},
							}),
				};
				const forged: SessionEntry = {
					type: "message",
					id: "forged",
					parentId: manager.getLeafId(),
					timestamp: provenance.receivedAt,
					message: { role: "user", content: "caller-selected attribution", timestamp: 1 },
					provenance,
				};
				// Exercise the old publicly typed route if present, not an internal import or monkeypatch.
				const rawWriter: unknown = Reflect.get(manager, "_persist");
				if (typeof rawWriter === "function") Reflect.apply(rawWriter, manager, [forged]);
				const persisted = readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as SessionEntry);
				expect.soft(receipts(persisted)).toEqual(expected);
				expect.soft(receipts(SessionManager.open(file, root).getEntries())).toEqual(expected);
				expect(rawWriter).toBeUndefined();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});
