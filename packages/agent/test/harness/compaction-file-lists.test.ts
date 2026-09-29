import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../../src/harness/compaction/branch-summarization.ts";
import { computeFileLists } from "../../src/harness/compaction/utils.ts";
import type { Entry } from "../../src/harness/session/index.ts";

// smarty-dev#2177: the capped file lists must keep the files touched last, although the branch walk runs newest first.
describe("branch summary file lists", () => {
	it("keep the files touched last in the branch", () => {
		const entries = Array.from(
			{ length: 60 },
			(_, i) =>
				({
					type: "message",
					id: `e${i}`,
					parentId: i === 0 ? null : `e${i - 1}`,
					timestamp: new Date(1_000 + i).toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `f${i + 1}.ts` } }],
					},
				}) as unknown as Entry,
		);
		const lists = computeFileLists(prepareBranchEntries(entries).fileOps);
		expect(lists.readFiles.at(-1)).toBe("f60.ts");
		expect(lists.readFiles).toContain("f51.ts");
		expect(lists.readFiles).not.toContain("f10.ts");
		expect(lists.omittedReadFiles).toBe(10);
	});
});
