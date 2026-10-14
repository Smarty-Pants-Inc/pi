import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { type BashToolDetails, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { formatSize } from "../src/core/tools/truncate.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// Synthetic final result recorded for a 50 MiB command output. Only the metadata is large; no 50 MiB buffer is allocated.
const TOTAL = 50 * 1024 * 1024;
const KEPT_PER_SIDE = 4 * 1024 * 1024;
const OMITTED = TOTAL - 2 * KEPT_PER_SIDE;
const LOG_PATH = "/tmp/pi-bash-capped.log";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function makeResult(capped: boolean): { content: Array<{ type: "text"; text: string }>; details: BashToolDetails } {
	const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	let text = `${lines}\n\n[Showing lines 1-20 of 900000 (50KB limit). Full output: ${LOG_PATH}]`;
	if (capped) {
		text += `\n[Output log capped: ${OMITTED} of ${TOTAL} bytes omitted; ${LOG_PATH} keeps the first 4.0MB and last 4.0MB]`;
	}
	return {
		content: [{ type: "text", text }],
		details: {
			truncation: {
				content: lines,
				truncated: true,
				truncatedBy: "bytes",
				totalLines: 900000,
				totalBytes: TOTAL,
				outputLines: 20,
				outputBytes: lines.length,
				lastLinePartial: false,
				firstLineExceedsLimit: false,
				maxLines: 2000,
				maxBytes: 50 * 1024,
			},
			fullOutputPath: LOG_PATH,
			...(capped ? { fullOutputTruncation: { totalBytes: TOTAL, omittedBytes: OMITTED } } : {}),
		} as BashToolDetails,
	};
}

function renderComponent(capped: boolean, expanded: boolean, partialFirst: boolean): string {
	const component = new ToolExecutionComponent(
		"bash",
		`bash-cap-${capped}-${expanded}-${partialFirst}`,
		{ command: "yes | head -c 52428800" },
		{},
		createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
		createFakeTui(),
		process.cwd(),
	);
	component.setExpanded(expanded);
	if (partialFirst) {
		component.updateResult({ content: [{ type: "text", text: "line 1" }], isError: false }, true);
	}
	component.updateResult({ ...makeResult(capped), isError: false });
	return stripAnsi(component.render(160).join("\n"));
}

const capWarning = `Output log capped: ${OMITTED} of ${TOTAL} bytes omitted; ${LOG_PATH} keeps the first ${formatSize(KEPT_PER_SIDE)} and last ${formatSize(KEPT_PER_SIDE)}`;

describe("bash renderer capped output log", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	const evidence: string[] = [];

	test.each([
		{ expanded: false, partialFirst: false },
		{ expanded: true, partialFirst: false },
		{ expanded: false, partialFirst: true },
		{ expanded: true, partialFirst: true },
	])("capped log: expanded=$expanded partialFirst=$partialFirst", ({ expanded, partialFirst }) => {
		const out = renderComponent(true, expanded, partialFirst);
		evidence.push(`--- capped expanded=${expanded} partialFirst=${partialFirst}\n${out}`);
		expect(out).toContain(capWarning);
		expect(out).not.toContain("Full output");
		expect(out.split(capWarning).length).toBe(2);
		expect(out).toMatch(/Truncated: 20 lines shown \(50\.0KB\s+limit\)/);
	});

	test.each([
		{ expanded: false, partialFirst: false },
		{ expanded: true, partialFirst: true },
	])(
		"uncapped log keeps Full output footer: expanded=$expanded partialFirst=$partialFirst",
		({ expanded, partialFirst }) => {
			const out = renderComponent(false, expanded, partialFirst);
			evidence.push(`--- uncapped expanded=${expanded} partialFirst=${partialFirst}\n${out}`);
			expect(out).not.toContain("Output log capped");
			expect(out.split(`Full output: ${LOG_PATH}`).length).toBe(2);
			expect(out).not.toContain("Showing lines");
			if (process.env.PI_TOOL_RENDER_PROOF) {
				writeFileSync(resolve(process.env.PI_TOOL_RENDER_PROOF), `${evidence.join("\n\n")}\n`);
			}
		},
	);
});
