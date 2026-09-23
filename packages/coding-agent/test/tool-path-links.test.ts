import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { fileLinkUrl } from "../src/core/tools/render-utils.ts";
import { findRenderers, grepRenderers, readRenderers } from "../src/core/tools/renderers/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const OSC8_URL = /\x1b\]8;;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;

function linkTargets(component: Component): string[] {
	return [...component.render(200).join("\n").matchAll(OSC8_URL)].map((match) => match[1]);
}

function context(args: Record<string, unknown>, cwd: string): ToolRenderContext {
	return {
		args,
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
	};
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });
const options = { expanded: true, isPartial: false };

describe("tool path links", () => {
	let dir: string;
	beforeAll(() => {
		initTheme("dark");
		dir = mkdtempSync(join(tmpdir(), "pi-links-"));
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "a.ts"), "one\ntwo\n");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	afterEach(() => resetCapabilitiesCache());

	test("file URLs carry the host and an optional line fragment", () => {
		expect(fileLinkUrl("/tmp/a b.ts")).toBe(`file://${hostname()}/tmp/a%20b.ts`);
		expect(fileLinkUrl("/tmp/a.ts", 12)).toBe(`file://${hostname()}/tmp/a.ts#12`);
	});

	test("read title links the path at the offset line", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const args = { path: "src/a.ts", offset: 2 };
		const call = readRenderers.renderCall!(args, theme, context(args, dir));
		expect(linkTargets(call)).toEqual([`file://${hostname()}${dir}/src/a.ts#2`]);
	});

	test("grep rows link each path at its line, relative to the searched directory or file", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const inDir = grepRenderers.renderResult!(
			text("src/a.ts:2: two\nsrc/a.ts-1- one\n\n[100 matches limit reached]"),
			options,
			theme,
			context({ pattern: "two" }, dir),
		);
		expect(linkTargets(inDir)).toEqual([
			`file://${hostname()}${dir}/src/a.ts#2`,
			`file://${hostname()}${dir}/src/a.ts#1`,
		]);
		const inFile = grepRenderers.renderResult!(
			text("a.ts:2: two"),
			options,
			theme,
			context({ pattern: "two", path: "src/a.ts" }, dir),
		);
		expect(linkTargets(inFile)).toEqual([`file://${hostname()}${dir}/src/a.ts#2`]);
	});

	test("find rows link paths but not messages or notices", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const found = findRenderers.renderResult!(
			text("a.ts\n\n[1 results limit reached]"),
			options,
			theme,
			context({ pattern: "*.ts", path: "src" }, dir),
		);
		expect(linkTargets(found)).toEqual([`file://${hostname()}${dir}/src/a.ts`]);
		const none = findRenderers.renderResult!(
			text("No files found matching pattern"),
			options,
			theme,
			context({ pattern: "*.x" }, dir),
		);
		expect(linkTargets(none)).toEqual([]);
	});

	test("no links without hyperlink support", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const result = grepRenderers.renderResult!(
			text("src/a.ts:2: two"),
			options,
			theme,
			context({ pattern: "two" }, dir),
		);
		expect(linkTargets(result)).toEqual([]);
	});
});
