import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { repairSession } from "./repair-r141-support.ts";

// PR #141 cut #4: a committed summary is not a retryable summarization failure.
it.each(["session_compact", "compaction_end"] as const)(
	"returns committed outcome after %s notification failure",
	async (phase) => {
		const { session, manager, agent } = await repairSession();
		const first = manager.appendMessage({ role: "user", content: "old input ".repeat(100), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("old answer ".repeat(100)));
		manager.appendMessage({ role: "user", content: "recent input", timestamp: 2 });
		manager.appendMessage(fauxAssistantMessage("recent answer"));
		session.refreshContext();
		const emit = vi.spyOn(session.extensionRunner, "emit").mockImplementation(async (event) => {
			if (event.type === "session_before_compact")
				return {
					compaction: { summary: "synthetic committed summary", firstKeptEntryId: first, tokensBefore: 200 },
				};
			if (event.type === phase) throw new Error("synthetic postcommit publication failure");
			return undefined;
		});
		vi.spyOn(session.extensionRunner, "hasHandlers").mockReturnValue(true);
		const failed: string[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end" && !event.result) failed.push("retryable failure");
			if (event.type === phase) throw new Error("synthetic postcommit listener failure");
		});
		try {
			const result = await session.compact();
			expect(result).toMatchObject({
				summary: "synthetic committed summary",
				notificationFailure: { code: "COMPACTION_NOTIFICATION_FAILED" },
			});
			expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(JSON.stringify(agent.state.messages)).toContain("synthetic committed summary");
			expect(failed).toEqual([]);
			expect(session.isCompacting).toBe(false);
		} finally {
			emit.mockRestore();
		}
	},
);
