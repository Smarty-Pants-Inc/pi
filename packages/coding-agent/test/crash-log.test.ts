import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { findExtensionStackMatches, readCrashLog, recordCrash, takeUnnotifiedCrash } from "../src/core/crash-log.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]{0,14}$/;

type StackExtension = Parameters<typeof findExtensionStackMatches>[1][number];

function packageExtension(source: string, baseDir: string, entry = "extensions/index.ts"): StackExtension {
	const normalizedBaseDir = baseDir.replace(/\\/g, "/");
	const resolvedPath = `${normalizedBaseDir}/${entry}`;
	return {
		path: resolvedPath,
		resolvedPath,
		sourceInfo: {
			path: resolvedPath,
			source,
			scope: "user",
			origin: "package",
			baseDir,
		},
	};
}

describe("extension crash attribution", () => {
	test("matches stack frames beneath loaded package roots", () => {
		const memory = packageExtension(
			"npm:pi-observational-memory",
			"/home/fedora/.pi/agent/npm/node_modules/pi-observational-memory",
		);
		const unrelated = packageExtension("npm:unrelated", "/home/fedora/.pi/agent/npm/node_modules/unrelated");
		const stack =
			"TypeError: Cannot read properties of undefined (reading 'runtime')\n" +
			"    at streamSimple (file:///home/fedora/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-CMRUVXTE.js:1093:16944)\n" +
			"    at /home/fedora/.pi/agent/npm/node_modules/pi-observational-memory/src/agents/worker-stream.ts:43:45";

		expect(findExtensionStackMatches(stack, [memory, unrelated])).toEqual(["npm:pi-observational-memory"]);
	});

	test("normalizes Windows paths and deduplicates package extensions", () => {
		const root = "C:\\Users\\reporter\\.pi\\agent\\npm\\node_modules\\@scope\\memory";
		const first = packageExtension("npm:@scope/memory", root, "extensions/first.ts");
		const second = packageExtension("npm:@scope/memory", root, "extensions/second.ts");
		const stack =
			"Error: broken\n" +
			"    at run (c:\\users\\reporter\\.pi\\agent\\npm\\node_modules\\@scope\\memory\\src\\worker.ts:4:2)";

		expect(findExtensionStackMatches(stack, [first, second])).toEqual(["npm:@scope/memory"]);
	});

	test("does not attribute sibling single-file packages", () => {
		const extension = (name: string): StackExtension => ({
			path: `/plugins/${name}.ts`,
			resolvedPath: `/plugins/${name}.ts`,
			sourceInfo: {
				path: `/plugins/${name}.ts`,
				source: `/plugins/${name}.ts`,
				scope: "user",
				origin: "package",
				baseDir: "/plugins",
			},
		});
		const stack = "Error: broken\n    at run (file:///plugins/b.ts:4:2)";

		expect(findExtensionStackMatches(stack, [extension("a"), extension("b")])).toEqual(["/plugins/b.ts"]);
	});

	test("ignores extension paths in the error message", () => {
		const extension = packageExtension("npm:memory", "/tmp/node_modules/memory");
		const stack = `Error: Failed to read ${extension.resolvedPath}\n    at run (file:///opt/pi/dist/core.js:4:2)`;

		expect(findExtensionStackMatches(stack, [extension])).toEqual([]);
	});

	test("decodes frame paths independently from malformed error text", () => {
		const extension: StackExtension = {
			path: "/Users/reporter/.pi/agent/extensions/local memory/index.ts",
			resolvedPath: "/Users/reporter/.pi/agent/extensions/local memory/index.ts",
			sourceInfo: {
				path: "/Users/reporter/.pi/agent/extensions/local memory/index.ts",
				source: "local",
				scope: "user",
				origin: "top-level",
				baseDir: "/Users/reporter/.pi/agent/extensions",
			},
		};
		const stack =
			"Error: progress 100%\n    at run (file:///Users/reporter/.pi/agent/extensions/local%20memory/worker.ts:4:2)";

		expect(findExtensionStackMatches(stack, [extension])).toEqual([extension.path]);
	});
});

describe("crash producer ids (smarty-dev#8981)", () => {
	test("one process numbers its records <gen>:1, <gen>:2; notifying keeps the ids; a new process has a new gen", async () => {
		const dir = mkdtempSync(join(tmpdir(), "crash-id-"));
		const path = join(dir, "crashes.json");
		try {
			const first = recordCrash({ kind: "fatal_error", error: new Error("one"), cwd: dir }, path);
			const second = recordCrash({ kind: "fatal_error", error: new Error("two"), cwd: dir }, path);
			expect(first?.id).toMatch(ID);
			expect(second?.id).toMatch(ID);
			const [gen, seq] = first!.id!.split(":");
			expect(second!.id).toBe(`${gen}:${Number(seq) + 1}`);

			expect(takeUnnotifiedCrash(path)?.id).toBe(second!.id);
			expect(readCrashLog(path).map((r) => r.id)).toEqual([first!.id, second!.id]);

			// A fresh module instance stands in for a new producer process: the gen is taken once at module load.
			vi.resetModules();
			const fresh = await import("../src/core/crash-log.ts");
			fresh.recordCrash({ kind: "fatal_error", error: new Error("three"), cwd: dir }, path);
			const third = readCrashLog(path).at(-1)!;
			expect(third.message).toBe("three");
			expect(third.id).toMatch(ID);
			expect(third.id!.split(":")[0]).not.toBe(gen);
			expect(third.id!.endsWith(":1")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("crash notice bookkeeping (smarty-dev#5271)", () => {
	test("marks only the shown crash as notified; older unseen crashes stay pending", () => {
		const dir = mkdtempSync(join(tmpdir(), "crash-log-"));
		const path = join(dir, "crashes.json");
		const now = Date.parse("2026-10-05T08:30:00Z");
		const record = (timestamp: string, message: string) => ({
			timestamp,
			version: "test",
			kind: "fatal_error" as const,
			message,
			stack: null,
			sessionFile: null,
		});
		writeFileSync(
			path,
			JSON.stringify([
				record("2026-10-05T08:09:00Z", "lane A"),
				record("2026-10-05T08:09:10Z", "lane B"),
				record("2026-10-05T08:09:20Z", "lane C"),
			]),
		);
		try {
			expect(takeUnnotifiedCrash(path, now)?.message).toBe("lane C");
			expect(readCrashLog(path).map((r) => Boolean(r.notified))).toEqual([false, false, true]);
			expect(takeUnnotifiedCrash(path, now)?.message).toBe("lane B");
			expect(takeUnnotifiedCrash(path, now)?.message).toBe("lane A");
			expect(takeUnnotifiedCrash(path, now)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
