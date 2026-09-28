import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent } from "../src/core/tools/edit-diff.ts";

describe("multi-edit not-found errors", () => {
	it("reports every non-matching edit with its nearest line", () => {
		const content = "alpha one\nbeta two\ngamma three\n";
		const edits = [
			{ oldText: "beta two", newText: "BETA" },
			{ oldText: "alpha 1", newText: "x" },
			{ oldText: "gamma thre3", newText: "y" },
		];
		expect(() => applyEditsToNormalizedContent(content, edits, "f.txt")).toThrow(
			'Could not find 2 of 3 edits in f.txt. Each oldText must match exactly including all whitespace and newlines. No edits were applied.\n- edits[1]: nearest match at line 1: "alpha one"\n- edits[2]: nearest match at line 3: "gamma three"',
		);
	});
});
