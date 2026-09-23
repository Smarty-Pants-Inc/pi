import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Component, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { ansiToHtml } from "../src/core/export-html/ansi-to-html.ts";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { fileLinkUrl } from "../src/core/tools/render-utils.ts";
import { editRenderers, findRenderers, grepRenderers, readRenderers } from "../src/core/tools/renderers/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const OSC8_URL = /\x1b\]8;;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
const HERDR = { HERDR_ENV: "1", TERM_PROGRAM: "" };
const PLAIN = { HERDR_ENV: "", TERM_PROGRAM: "" };

function linkTargets(component: Component): string[] {
	return [...component.render(200).join("\n").matchAll(OSC8_URL)].map((match) => match[1]);
}

function context(args: Record<string, unknown>, cwd: string, state: Record<string, unknown> = {}): ToolRenderContext {
	return {
		args,
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state,
		cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
	};
}

const text = (value: string, details?: Record<string, unknown>) => ({
	content: [{ type: "text" as const, text: value }],
	details,
});
const options = { expanded: true, isPartial: false };

describe("tool path links", () => {
	let dir: string;
	let host: string;
	beforeAll(() => {
		initTheme("dark");
		dir = mkdtempSync(join(tmpdir(), "pi-links-"));
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "a.ts"), "one\ntwo\nthree\n");
		host = `file://${hostname()}`;
	});
	beforeEach(() => {
		vi.stubEnv("HERDR_ENV", HERDR.HERDR_ENV);
		vi.stubEnv("TERM_PROGRAM", HERDR.TERM_PROGRAM);
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	afterEach(() => {
		resetCapabilitiesCache();
		vi.unstubAllEnvs();
	});

	test("Herdr file URLs carry the host and an integer line fragment", () => {
		expect(fileLinkUrl("/tmp/a b.ts", undefined, HERDR, "linux")).toBe(`${host}/tmp/a%20b.ts`);
		expect(fileLinkUrl("/tmp/a.ts", 12, HERDR, "linux")).toBe(`${host}/tmp/a.ts#12`);
		expect(fileLinkUrl("/tmp/a.ts", 12, { TERM_PROGRAM: "herdr" }, "darwin")).toBe(`${host}/tmp/a.ts#12`);
		for (const line of [0, -3, 2.5, Number.NaN]) {
			expect(fileLinkUrl("/tmp/a.ts", line, HERDR, "linux")).toBe(`${host}/tmp/a.ts`);
		}
	});

	test("other terminals and Windows keep the plain file:/// URL without host or line", () => {
		expect(fileLinkUrl("/tmp/a.ts", 12, PLAIN, "linux")).toBe("file:///tmp/a.ts");
		expect(fileLinkUrl("/tmp/a.ts", 12, { TERM_PROGRAM: "vscode" }, "darwin")).toBe("file:///tmp/a.ts");
		expect(fileLinkUrl("C:\\x\\a.ts", 12, HERDR, "win32")).toBe(pathToFileURL("C:\\x\\a.ts").href);
	});

	test("special and control characters are percent-encoded, never raw", () => {
		const url = fileLinkUrl("/tmp/a#b%c ü\x1b\x07?.ts", 3, HERDR, "linux");
		expect(url).toBe(`${host}/tmp/a%23b%25c%20%C3%BC%1B%07%3F.ts#3`);
		expect(url).not.toMatch(/[\x00-\x1f\x7f]/);
	});

	test("read title links the integer offset line", () => {
		const args = { path: "src/a.ts", offset: 2 };
		expect(linkTargets(readRenderers.renderCall!(args, theme, context(args, dir)))).toEqual([
			`${host}${dir}/src/a.ts#2`,
		]);
		const partial = { path: "src/a.ts", offset: "10" };
		expect(linkTargets(readRenderers.renderCall!(partial, theme, context(partial, dir)))).toEqual([
			`${host}${dir}/src/a.ts`,
		]);
	});

	test("edit title links the first changed line", async () => {
		const args = { path: "src/a.ts", edits: [{ oldText: "three", newText: "THREE" }] };
		const state = {};
		let rendered!: () => void;
		const previewReady = new Promise<void>((resolve) => {
			rendered = resolve;
		});
		const ctx = { ...context(args, dir, state), invalidate: () => rendered() };
		const first = editRenderers.renderCall!(args, theme, ctx);
		await previewReady;
		const second = editRenderers.renderCall!(args, theme, { ...ctx, lastComponent: first });
		expect(linkTargets(second)).toEqual([`${host}${dir}/src/a.ts#3`]);
	});

	test("grep rows link each path at its line, relative to the searched directory or file", () => {
		const inDir = grepRenderers.renderResult!(
			text("src/a.ts:2: two\nsrc/a.ts-1- one\n\n[100 matches limit reached]"),
			options,
			theme,
			context({ pattern: "two" }, dir),
		);
		expect(linkTargets(inDir)).toEqual([`${host}${dir}/src/a.ts#2`, `${host}${dir}/src/a.ts#1`]);
		const inFile = grepRenderers.renderResult!(
			text("a.ts:2: two", { searchIsFile: true }),
			options,
			theme,
			context({ pattern: "two", path: "src/a.ts" }, dir),
		);
		expect(linkTargets(inFile)).toEqual([`${host}${dir}/src/a.ts#2`]);
	});

	test("find rows link paths but not messages or notices", () => {
		const found = findRenderers.renderResult!(
			text("a.ts\n\n[1 results limit reached]"),
			options,
			theme,
			context({ pattern: "*.ts", path: "src" }, dir),
		);
		expect(linkTargets(found)).toEqual([`${host}${dir}/src/a.ts`]);
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
		const args = { path: "src/a.ts", offset: 2 };
		expect(linkTargets(readRenderers.renderCall!(args, theme, context(args, dir)))).toEqual([]);
		const grep = grepRenderers.renderResult!(
			text("src/a.ts:2: two"),
			options,
			theme,
			context({ pattern: "two" }, dir),
		);
		expect(linkTargets(grep)).toEqual([]);
		const find = findRenderers.renderResult!(text("src/a.ts"), options, theme, context({ pattern: "*.ts" }, dir));
		expect(linkTargets(find)).toEqual([]);
	});

	test("HTML export drops OSC 8 hyperlinks and keeps the link text", () => {
		const grep = grepRenderers.renderResult!(
			text("src/a.ts:2: two"),
			options,
			theme,
			context({ pattern: "two" }, dir),
		);
		const html = ansiToHtml(grep.render(200).join("\n"));
		expect(html).toContain("src/a.ts:2: two");
		expect(html).not.toContain("]8;");
		expect(html).not.toContain("\x1b");
		expect(html).not.toContain(hostname());
	});
});
