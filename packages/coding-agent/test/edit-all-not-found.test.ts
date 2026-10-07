import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent, findNearestLine, fuzzyFindText } from "../src/core/tools/edit-diff.ts";

// Regression coverage for Smarty-Pants-Inc/smarty-dev#3240.
describe("edit not-found errors", () => {
	it("reports every non-matching edit with numbered nearest-match snippets", () => {
		const content = "alpha one\nbeta two\ngamma three\n";
		const edits = [
			{ oldText: "beta two", newText: "BETA" },
			{ oldText: "alpha 1", newText: "x" },
			{ oldText: "gamma thre3", newText: "y" },
		];
		expect(() => applyEditsToNormalizedContent(content, edits, "f.txt")).toThrow(
			"Could not find 2 of 3 edits in f.txt. Each oldText must match exactly including all whitespace and newlines. No edits were applied.\n- edits[1]: nearest match at line 1:\n  1: alpha one\n  2: beta two\n  3: gamma three\n- edits[2]: nearest match at line 3:\n  3: gamma three",
		);
	});

	it.each([1, 2])("uses the same multiline hint for a missing edit in a %i-edit call", (count) => {
		const content =
			"section:\nobsolete setting\nobsolete details\n\nsection:\ntarget setting value\ntarget details value\ntail\n";
		const edits = [{ oldText: "section:\ntarget setting valu3\ntarget details valu3", newText: "changed" }];
		if (count === 2) edits.push({ oldText: "tail", newText: "TAIL" });
		expect(() => applyEditsToNormalizedContent(content, edits, "f.txt")).toThrow(
			"nearest match at line 5:\n  5: section:\n  6: target setting value\n  7: target details value",
		);
	});

	it("caps the snippet at three numbered lines, not the lines used for scoring", () => {
		const content =
			"header\ncommon line\nthird line\nobsolete branch\nobsolete footer\n\nheader\ncommon line\nthird line\ntarget branch value\ntarget footer value\nnot shown\n";
		const oldText = "header\ncommon line\nthird line\ntarget branch valu3\ntarget footer valu3";
		expect(findNearestLine(content, oldText)).toEqual({ line: 7, excerpt: "header" });
		expect(() => applyEditsToNormalizedContent(content, [{ oldText, newText: "changed" }], "f.txt")).toThrow(
			new Error(
				"Could not find the exact text in f.txt. The old text must match exactly including all whitespace and newlines. No edits were applied.\nnearest match at line 7:\n  7: header\n  8: common line\n  9: third line",
			),
		);
	});

	it("uses bounded snippets while preserving indentation and blank lines", () => {
		const content = `intro\n  target ${"x".repeat(100)}\n\n  next line\n  excluded line\n`;
		expect(() =>
			applyEditsToNormalizedContent(
				content,
				[{ oldText: `target ${"x".repeat(99)}y`, newText: "changed" }],
				"f.txt",
			),
		).toThrow(`nearest match at line 2:\n  2:   target ${"x".repeat(68)}...\n  3: \n  4:   next line`);
	});

	it.each([
		{ content: "zzzz\nqqqq\n", oldText: "abcd\nefgh" },
		{ content: "zzzz\n\nqqqq\n", oldText: "abcd\n\nefgh" },
		{ content: "\n \n\t\n", oldText: "target value" },
		{ content: "", oldText: "target value" },
		{ content: "target value", oldText: " \n\t" },
	])("does not invent a nearest match for unrelated or blank text: $oldText", ({ content, oldText }) => {
		expect(findNearestLine(content, oldText)).toBeUndefined();
		expect(() => applyEditsToNormalizedContent(content, [{ oldText, newText: "changed" }], "f.txt")).toThrow(
			"no similar line",
		);
	});

	it("keeps the public nearest-line result shape and first-line tie behavior", () => {
		expect(findNearestLine("  alpha one  \nalpha one\n", "\n alpha 1\n")).toEqual({
			line: 1,
			excerpt: "alpha one",
		});
		expect(findNearestLine(`target ${"x".repeat(100)}`, "target value")?.excerpt).toHaveLength(80);
	});

	it("applies successful single and batch replacements against the original content", () => {
		const content = "alpha one\nbeta two\ngamma three\n";
		expect(applyEditsToNormalizedContent(content, [{ oldText: "beta two", newText: "BETA" }], "f.txt")).toEqual({
			baseContent: content,
			newContent: "alpha one\nBETA\ngamma three\n",
		});
		expect(
			applyEditsToNormalizedContent(
				content,
				[
					{ oldText: "alpha one", newText: "beta two" },
					{ oldText: "beta two", newText: "BETA" },
				],
				"f.txt",
			),
		).toEqual({ baseContent: content, newContent: "beta two\nBETA\ngamma three\n" });
	});

	it("still accepts fuzzy normalization but does not apply merely similar text", () => {
		const content = "keep “quotes”  \nsection:\n  target “value”  \n  detail—value\ntail  \n";
		const oldText = 'section:\n  target "value"\n  detail-value';
		expect(fuzzyFindText(content, oldText)).toMatchObject({ found: true, usedFuzzyMatch: true });
		expect(applyEditsToNormalizedContent(content, [{ oldText, newText: "changed" }], "f.txt")).toEqual({
			baseContent: content,
			newContent: "keep “quotes”  \nchanged\ntail  \n",
		});
		const similar = 'section:\n  target "valu3"\n  detail-value';
		expect(fuzzyFindText(content, similar).found).toBe(false);
		expect(() => applyEditsToNormalizedContent(content, [{ oldText: similar, newText: "changed" }], "f.txt")).toThrow(
			"nearest match at line 2:",
		);
	});

	// Regression coverage for Smarty-Pants-Inc/smarty-dev#3240: hint work is bounded for large inputs.
	describe("large inputs", () => {
		const skipped =
			"nearest match search skipped: the file is too large to compare with this oldText; re-read the file and copy the exact text";
		const content = `#!/bin/sh\n${"line of text\n".repeat(400_000)}`;
		const missingBlock = Array.from({ length: 500 }, (_, i) => `missing block line ${i}`).join("\n");

		function timeFailure(edits: { oldText: string; newText: string }[]): { message: string; ms: number } {
			const start = performance.now();
			let message = "";
			try {
				applyEditsToNormalizedContent(content, edits, "big.sh");
			} catch (error) {
				message = (error as Error).message;
			}
			return { message, ms: performance.now() - start };
		}

		it("skips the hint for a 500-line oldText against a 400,000-line file in a single edit", () => {
			const { message, ms } = timeFailure([{ oldText: missingBlock, newText: "changed" }]);
			expect(message).toBe(
				`Could not find the exact text in big.sh. The old text must match exactly including all whitespace and newlines. No edits were applied.\n${skipped}`,
			);
			expect(ms).toBeLessThan(1000);
			expect(findNearestLine(content, missingBlock)).toBeUndefined();
		});

		it("skips the hint for each 500-line oldText against a 400,000-line file in a batch", () => {
			const { message, ms } = timeFailure([
				{ oldText: "#!/bin/sh", newText: "#!/bin/bash" },
				{ oldText: missingBlock, newText: "changed" },
				{ oldText: `${missingBlock}\nmore`, newText: "changed" },
			]);
			expect(message).toBe(
				`Could not find 2 of 3 edits in big.sh. Each oldText must match exactly including all whitespace and newlines. No edits were applied.\n- edits[1]: ${skipped}\n- edits[2]: ${skipped}`,
			);
			expect(ms).toBeLessThan(1000);
		});

		it("still hints a one-line oldText in a large file, but one budget covers every missing edit", () => {
			const { message, ms } = timeFailure([
				{ oldText: "#!/bin/sh", newText: "#!/bin/bash" },
				{ oldText: "line of texx", newText: "a" },
				{ oldText: "line of tezt", newText: "b" },
			]);
			expect(
				message.endsWith(
					"\n- edits[1]: nearest match at line 2:\n  2: line of text\n  3: line of text\n  4: line of text\n- edits[2]: " +
						skipped,
				),
			).toBe(true);
			expect(ms).toBeGreaterThanOrEqual(0);
		});
	});
});
