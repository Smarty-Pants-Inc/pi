import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportFromFile, exportSessionToHtml } from "../src/core/export-html/index.ts";
import * as exportLimits from "../src/core/export-limits.ts";
import { copyEntry, isColdEntry } from "../src/core/session-lazy-entries.ts";
import { type FileEntry, type SessionEntry, type SessionHeader, SessionManager } from "../src/core/session-manager.ts";

// Exercise the real HTML path and shared snapshot with small hook results, not a 70 MiB allocation.
// Only this test's HTML snapshot budget is reduced; production constants and count guards stay real.
const htmlBudget = vi.hoisted(() => ({ bytes: 4096 }));
vi.mock("../src/core/export-limits.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof exportLimits>();
	return {
		...actual,
		prepareExportValueForJson: (value: unknown, format: string, limit = actual.MAX_MATERIALIZED_EXPORT_BYTES) =>
			actual.prepareExportValueForJson(value, format, format === "HTML" ? Math.min(limit, htmlBudget.bytes) : limit),
	};
});

interface ExportedSession {
	header: SessionHeader;
	entries: SessionEntry[];
	leafId: string | null;
	renderedTools?: Record<string, { callHtml?: string; resultHtmlCollapsed?: string; resultHtmlExpanded?: string }>;
}

const directories: string[] = [];
function directory(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-html-guard-boundaries-"));
	directories.push(dir);
	return dir;
}

function readExport(file: string): { html: string; data: ExportedSession } {
	const html = readFileSync(file, "utf8");
	const match = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
	expect(match).not.toBeNull();
	return { html, data: JSON.parse(Buffer.from(match![1], "base64").toString("utf8")) as ExportedSession };
}

function fixture(dir: string, count: number, kind: "duplicate IDs" | "unique IDs" | "extra headers"): string {
	const header: SessionHeader = {
		type: "session",
		version: 3,
		id: "count",
		timestamp: "2026-01-01T00:00:00Z",
		cwd: dir,
	};
	const lines = [JSON.stringify(header)];
	for (let i = 0; i < count; i++) {
		lines.push(
			JSON.stringify(
				kind === "extra headers"
					? header
					: {
							type: "custom",
							id: kind === "duplicate IDs" ? "same" : String(i),
							parentId: null,
							timestamp: header.timestamp,
							customType: "count",
							data: i,
						},
			),
		);
	}
	const file = join(dir, `${kind}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

// #11897 / storage-review P1#1 and P2#2: materialization is a data-safety boundary.
// Keep real export entry points, bounded negative fixtures and successful neighboring cases.
describe("HTML export guard boundaries", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		htmlBudget.bytes = 4096;
		for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("bounds a nested stateful hook's export result after its small append-time result", async () => {
		const dir = directory();
		const sm = SessionManager.create(dir, dir);
		sm.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const keys: string[] = [];
		sm.appendCustomEntry("stateful", {
			payload: {
				toJSON(key: string) {
					keys.push(key);
					return keys.length === 1 ? { saved: "small" } : "x".repeat(htmlBudget.bytes * 2);
				},
			},
		});
		expect(keys).toEqual(["payload"]);
		expect(readFileSync(sm.getSessionFile()!, "utf8")).toContain('"saved":"small"');
		const stringify = vi.spyOn(JSON, "stringify");
		const outputPath = join(dir, "oversized.html");
		await expect(exportSessionToHtml(sm, undefined, { outputPath, themeName: "dark" })).rejects.toThrow(
			/64 MiB.*use JSONL/,
		);
		expect(keys).toEqual(["payload", "payload"]);
		expect(stringify).not.toHaveBeenCalled();
		expect(existsSync(outputPath)).toBe(false);
	});

	// #3155: returning the receiver is valid JSON; only its function-valued hook is omitted.
	it("exports a nested self-returning hook as native JSON through live and file HTML", async () => {
		const dir = directory();
		const sm = SessionManager.create(dir, dir);
		sm.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const hook = vi.fn(function (this: object, _key: string) {
			return this;
		});
		const payload = { value: "ok", toJSON: hook };
		const expected: unknown = JSON.parse(JSON.stringify({ payload }));
		hook.mockClear();
		const id = sm.appendCustomEntry("self-return", { payload });
		expect(hook.mock.calls).toEqual([["payload"]]);
		hook.mockClear();
		const live = readExport(
			await exportSessionToHtml(sm, undefined, { outputPath: join(dir, "self-live.html"), themeName: "dark" }),
		);
		expect(hook.mock.calls).toEqual([["payload"]]);
		expect(live.data.entries.find((entry) => entry.id === id)).toEqual({ ...sm.getEntry(id), data: expected });
		expect(expected).toEqual({ payload: { value: "ok" } });
		const cli = readExport(
			await exportFromFile(sm.getSessionFile()!, { outputPath: join(dir, "self-cli.html"), themeName: "dark" }),
		);
		expect(cli.data).toEqual(live.data);
		expect(hook.mock.calls).toEqual([["payload"]]);
	});

	// #3155: a real self data field must still refuse, rather than hiding behind the hook.
	it("refuses real circular data on a self-returning hook receiver before HTML stringify", async () => {
		const dir = directory();
		const sm = SessionManager.create(dir, dir);
		sm.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const hook = vi.fn(function (this: object, _key: string) {
			return this;
		});
		const payload: Record<string, unknown> = { value: "ok", toJSON: hook };
		sm.appendCustomEntry("circular-self-return", { payload });
		hook.mockClear();
		payload.self = payload;
		const stringify = vi.spyOn(JSON, "stringify");
		const outputPath = join(dir, "circular.html");
		await expect(exportSessionToHtml(sm, undefined, { outputPath, themeName: "dark" })).rejects.toThrow(
			/circular session data/,
		);
		expect(hook).not.toHaveBeenCalled();
		expect(stringify).not.toHaveBeenCalled();
		expect(existsSync(outputPath)).toBe(false);
	});

	// #3155: the receiver's post-hook fields are charged, even when append-time JSON was small.
	it("bounds a nested self-returning hook after it expands its own data", async () => {
		const dir = directory();
		const sm = SessionManager.create(dir, dir);
		sm.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const keys: string[] = [];
		sm.appendCustomEntry("expanding-self-return", {
			payload: {
				value: "small",
				toJSON(key: string): unknown {
					keys.push(key);
					if (keys.length > 1) this.value = "x".repeat(htmlBudget.bytes * 2);
					return this;
				},
			},
		});
		expect(keys).toEqual(["payload"]);
		expect(readFileSync(sm.getSessionFile()!, "utf8")).toContain('"payload":{"value":"small"}');
		const stringify = vi.spyOn(JSON, "stringify");
		const outputPath = join(dir, "oversized-self.html");
		await expect(exportSessionToHtml(sm, undefined, { outputPath, themeName: "dark" })).rejects.toThrow(
			/64 MiB.*use JSONL/,
		);
		expect(keys).toEqual(["payload", "payload"]);
		expect(stringify).not.toHaveBeenCalled();
		expect(existsSync(outputPath)).toBe(false);
	});

	it("keeps native small hook output, original renderer inputs and rendered HTML", async () => {
		const dir = directory();
		const sm = SessionManager.create(dir, dir);
		sm.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const replacementHook = vi.fn(() => "must not be chained");
		const hook = vi.fn((key: string) => ({
			key,
			text: "<world> 雪",
			list: [undefined, "kept"],
			toJSON: replacementHook,
		}));
		const payload = { nested: { toJSON: hook }, buffer: Buffer.from([1, 2]), omitted: undefined };
		const expected: unknown = JSON.parse(JSON.stringify(payload));
		const id = sm.appendCustomEntry("small-hook", payload);
		const args = { original: "renderer input" };
		sm.appendMessage(fauxAssistantMessage(fauxToolCall("extension-tool", args, { id: "call" })));
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "call",
			toolName: "extension-tool",
			content: [{ type: "text", text: "result" }],
			details: { original: "details" },
			isError: false,
			timestamp: 2,
		});
		hook.mockClear();
		replacementHook.mockClear();
		const renderCall = vi.fn((_id: string, _name: string, received: unknown) => {
			expect(received).toBe(args);
			return "<b>custom call</b>";
		});
		const renderResult = vi.fn(() => ({ collapsed: "<i>collapsed</i>", expanded: "<p>expanded</p>" }));
		const output = await exportSessionToHtml(sm, undefined, {
			outputPath: join(dir, "small.html"),
			themeName: "dark",
			toolRenderer: { renderCall, renderResult },
		});
		const { html, data } = readExport(output);
		expect(hook).toHaveBeenCalledTimes(1);
		expect(hook).toHaveBeenCalledWith("nested");
		expect(replacementHook).not.toHaveBeenCalled();
		expect(data.entries.find((entry) => entry.id === id)).toMatchObject({ data: expected });
		expect(data.entries.map((entry) => entry.parentId)).toEqual(sm.getEntries().map((entry) => entry.parentId));
		expect(data.leafId).toBe(sm.getLeafId());
		expect(data.renderedTools).toEqual({
			call: {
				callHtml: "<b>custom call</b>",
				resultHtmlCollapsed: "<i>collapsed</i>",
				resultHtmlExpanded: "<p>expanded</p>",
			},
		});
		expect(renderCall).toHaveBeenCalledTimes(1);
		expect(renderResult).toHaveBeenCalledTimes(1);
		// #3155: only whole template injection slots are active; injected JS may quote "{{JS}}".
		const injectionSites = [...html.matchAll(/<(style|script)\b[^>]*>([\s\S]*?)<\/\1>/g)];
		expect(injectionSites).toHaveLength(5);
		for (const [, , content] of injectionSites) {
			expect(content.trim()).not.toMatch(/^\{\{(?:CSS|JS|SESSION_DATA|MARKED_JS|HIGHLIGHT_JS)\}\}$/);
		}
	});

	it.each(["duplicate IDs", "unique IDs", "extra headers"] as const)(
		"refuses live-manager over-limit %s before getEntries or rendering; CLI refuses before open",
		async (kind) => {
			const dir = directory();
			const file = fixture(dir, exportLimits.MAX_MATERIALIZED_EXPORT_ENTRIES + 1, kind);
			const sm = SessionManager.open(file);
			expect(sm.getEntryCount()).toBe(kind === "duplicate IDs" ? 1 : kind === "extra headers" ? 0 : 10_001);
			const entries = vi.spyOn(sm, "getEntries").mockImplementation(() => {
				throw new Error("getEntries must not run before the physical-count guard");
			});
			const renderCall = vi.fn();
			const renderResult = vi.fn();
			const outputPath = join(dir, "over-count.html");
			await expect(
				exportSessionToHtml(sm, undefined, { outputPath, toolRenderer: { renderCall, renderResult } }),
			).rejects.toThrow(/10000 entry.*use JSONL/);
			expect(entries).not.toHaveBeenCalled();
			expect(renderCall).not.toHaveBeenCalled();
			expect(renderResult).not.toHaveBeenCalled();
			expect(existsSync(outputPath)).toBe(false);
			const open = vi.spyOn(SessionManager, "open");
			await expect(exportFromFile(file, { outputPath })).rejects.toThrow(/10000 entry.*use JSONL/);
			expect(open).not.toHaveBeenCalled();
		},
	);

	it("accepts exactly the physical entry limit with duplicate IDs and keeps distinct-ID UI counts", async () => {
		htmlBudget.bytes = exportLimits.MAX_MATERIALIZED_EXPORT_BYTES;
		const dir = directory();
		const file = fixture(dir, exportLimits.MAX_MATERIALIZED_EXPORT_ENTRIES, "duplicate IDs");
		const sm = SessionManager.open(file);
		expect(sm.getEntryCount()).toBe(1);
		expect(sm.getPhysicalEntryCount()).toBe(exportLimits.MAX_MATERIALIZED_EXPORT_ENTRIES);
		const live = readExport(
			await exportSessionToHtml(sm, undefined, { outputPath: join(dir, "live.html"), themeName: "dark" }),
		);
		const cli = readExport(await exportFromFile(file, { outputPath: join(dir, "cli.html"), themeName: "dark" }));
		expect(live.data.entries).toHaveLength(exportLimits.MAX_MATERIALIZED_EXPORT_ENTRIES);
		expect(live.data.entries[0]).toMatchObject({ id: "same", parentId: null, data: 0 });
		expect(live.data.entries.at(-1)).toMatchObject({ id: "same", parentId: null, data: 9999 });
		expect(live.html).toBe(cli.html);
		expect(sm.getEntryCount()).toBe(1);
	});

	it("preserves cold custom/message payloads and resident links through both HTML entry points", async () => {
		htmlBudget.bytes = 32 * 1024;
		const dir = directory();
		const timestamp = "2026-01-01T00:00:00Z";
		const records: FileEntry[] = [
			{ type: "session", version: 3, id: "cold", timestamp, cwd: dir },
			{ type: "custom", id: "cold-data", parentId: null, timestamp, customType: "cold", data: "x".repeat(2048) },
			{
				type: "message",
				id: "cold-message",
				parentId: "cold-data",
				timestamp,
				message: { role: "user", content: "y".repeat(2048), timestamp: 1 },
			},
		];
		for (let i = 0; i < 101; i++) {
			records.push({ type: "custom", id: String(i), parentId: null, timestamp, customType: "recent" });
		}
		const file = join(dir, "cold.jsonl");
		writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		const sm = SessionManager.open(file);
		const cold = sm.getEntry("cold-data")!;
		expect(isColdEntry(cold)).toBe(true);
		expect(isColdEntry(sm.getEntry("cold-message")!)).toBe(true);
		// Use the internal cold-copy helper to model a resident link rewrite without changing disk data.
		const linked = copyEntry(cold, { parentId: "resident-link" });
		const entries = sm.getEntries().map((entry) => (entry === cold ? linked : entry));
		vi.spyOn(sm, "getEntries").mockReturnValue(entries);
		const expected: unknown = JSON.parse(JSON.stringify(entries));
		const live = readExport(
			await exportSessionToHtml(sm, undefined, { outputPath: join(dir, "cold-live.html"), themeName: "dark" }),
		);
		expect(live.data.entries).toEqual(expected);
		expect(live.data.entries[0].parentId).toBe("resident-link");
		const cli = readExport(await exportFromFile(file, { outputPath: join(dir, "cold-cli.html"), themeName: "dark" }));
		expect(cli.data.entries).toEqual(records.slice(1));
		expect(isColdEntry(cold)).toBe(true);
	});
});
