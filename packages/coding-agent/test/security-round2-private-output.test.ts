import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { executeCodemode } from "../src/extensions/codemode/execute.ts";
import {
	convertMcpResult,
	createMcpToolDefinition,
	MCP_OUTPUT_MAX_BYTES,
	saveToTempFile,
} from "../src/extensions/mcp/tools.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

// #2241: exercise public output paths with fake data and real files, never user config.
describe("private full output files", () => {
	let root: string;
	let previousUmask: number;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi92-private-output-"));
		previousUmask = process.umask(0o022);
		vi.stubEnv("TMPDIR", root);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		process.umask(previousUmask);
		rmSync(root, { recursive: true, force: true });
	});

	it("spills actual codemode output privately and keeps model offset reads working", async () => {
		// Model a shared temp parent using only our fake-data fixture directory.
		chmodSync(root, 0o755);
		const code =
			'// @options: {"max_output_tokens": 10}\nfor (let i = 0; i < 100; i++) text("fake row " + i);\nimage("data:image/png;base64,AAAA");';
		const result = await executeCodemode("private", { code }, undefined, undefined, undefined);
		const path = result.details.fullOutputPath;
		if (!path) throw new Error("No spill file");
		expect(result.isError).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe(Array.from({ length: 100 }, (_, i) => `fake row ${i}`).join("\n"));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(dirname(path)).not.toBe(root);
		expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
		expect(statSync(root).mode & 0o777).toBe(0o755);
		expect(result.content).toContainEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
		expect(result.content).toContainEqual({
			type: "text",
			text: expect.stringContaining(`[Full output: ${path} (read with offset/limit)]`),
		});
		const read = await createReadTool(root).execute("offset", { path, offset: 51, limit: 2 });
		expect(read.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("fake row 50\nfake row 51"),
		});
	});

	it("leaves ordinary codemode output untruncated without creating files", async () => {
		const result = await executeCodemode(
			"small",
			{ code: 'text("fake small"); return { ok: true };' },
			undefined,
			undefined,
			undefined,
		);
		expect(result.details.fullOutputPath).toBeUndefined();
		expect(result.content.slice(1)).toEqual([
			{ type: "text", text: "fake small" },
			{ type: "text", text: '{"ok":true}' },
		]);
		expect(readdirSync(root)).toEqual([]);
	});

	it("reports a real temp-parent failure while preserving truncated output", async () => {
		const blocked = join(root, "not-a-directory");
		writeFileSync(blocked, "fake blocker");
		vi.stubEnv("TMPDIR", blocked);
		const result = await executeCodemode(
			"blocked",
			{ code: '// @options: {"max_output_tokens": 1}\ntext("fake large output");' },
			undefined,
			undefined,
			undefined,
		);
		expect(result.isError).toBeUndefined();
		expect(result.details.fullOutputPath).toBeUndefined();
		expect(result.content[1]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Could not save the full output:"),
		});
		expect(result.content[1]).toMatchObject({ type: "text", text: expect.stringContaining("ENOTDIR") });
	});

	it("keeps codemode script errors and partial output", async () => {
		const result = await executeCodemode(
			"error",
			{ code: 'text("fake partial"); throw new Error("fake failure");' },
			undefined,
			undefined,
			undefined,
		);
		expect(result.isError).toBe(true);
		expect(result.details.fullOutputPath).toBeUndefined();
		expect(result.content[1]).toEqual({ type: "text", text: "fake partial" });
		expect(result.content[2]).toMatchObject({ type: "text", text: expect.stringContaining("fake failure") });
		expect(readdirSync(root)).toEqual([]);
	});

	it("creates unique private MCP text and binary files", async () => {
		const paths = await Promise.all([
			saveToTempFile("fake one", ".txt"),
			saveToTempFile(new Uint8Array([0, 1, 2]), ".bin"),
		]);
		expect(new Set(paths.map(dirname)).size).toBe(2);
		for (const path of paths) {
			expect(dirname(path)).not.toBe(root);
			expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
		expect(readFileSync(paths[0], "utf8")).toBe("fake one");
		expect(readFileSync(paths[1])).toEqual(Buffer.from([0, 1, 2]));
	});

	it("saves actual MCP tool truncation privately without changing structured content", async () => {
		const text = "fake text\n".repeat(MCP_OUTPUT_MAX_BYTES);
		const serverResult = { content: [{ type: "text" as const, text }], structuredContent: { fake: true } };
		const tool = createMcpToolDefinition({
			server: "fixture",
			tool: { name: "echo", inputSchema: { type: "object" } },
			name: "fixture_echo",
			exposure: "direct",
			namespace: { name: "fixture" },
			timeoutMs: 1000,
			getClient: async () => ({ callTool: async () => serverResult }),
		});
		const result = await wrapToolDefinition(tool).execute("mcp", {});
		const path = result.details.fullOutputPath;
		if (!path) throw new Error("No MCP spill file");
		expect(readFileSync(path, "utf8")).toBe(text);
		expect(dirname(path)).not.toBe(root);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
		expect(result.structuredContent).toEqual(serverResult);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining(`Full output: ${path} (read it with offset/limit)`),
		});
	});

	it("does not save small MCP output and reports real MCP saver failures", async () => {
		const small = await convertMcpResult("fixture", "echo", { content: [{ type: "text", text: "fake small" }] });
		expect(small.content).toEqual([{ type: "text", text: "fake small" }]);
		expect(small.details.fullOutputPath).toBeUndefined();
		expect(readdirSync(root)).toEqual([]);
		const blocked = join(root, "blocked");
		writeFileSync(blocked, "fake blocker");
		vi.stubEnv("TMPDIR", blocked);
		const result = await convertMcpResult("fixture", "echo", {
			content: [{ type: "text", text: "x".repeat(MCP_OUTPUT_MAX_BYTES + 1) }],
		});
		expect(result.details.fullOutputPath).toBeUndefined();
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Could not save the full output:"),
		});
		await expect(saveToTempFile("fake", ".txt")).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	it.each(["codemode", "mcp"])("rejects an existing symlink instead of overwriting it in %s", async (kind) => {
		const victim = join(root, "fake-victim");
		writeFileSync(victim, "fake sentinel");
		const writeFile = vi.mocked(fs.writeFile).getMockImplementation();
		if (!writeFile) throw new Error("No native writeFile implementation");
		vi.mocked(fs.writeFile).mockImplementationOnce(async (path, data, options) => {
			if (typeof path !== "string") throw new Error("Expected a filename");
			symlinkSync(victim, path);
			return writeFile(path, data, options);
		});
		if (kind === "codemode") {
			const result = await executeCodemode(
				"collision",
				{ code: '// @options: {"max_output_tokens": 1}\ntext("fake long output");' },
				undefined,
				undefined,
				undefined,
			);
			expect(result.details.fullOutputPath).toBeUndefined();
			expect(result.content[1]).toMatchObject({ type: "text", text: expect.stringContaining("EEXIST") });
		} else {
			await expect(saveToTempFile("fake replacement", ".txt")).rejects.toMatchObject({ code: "EEXIST" });
		}
		expect(readFileSync(victim, "utf8")).toBe("fake sentinel");
		expect(readdirSync(root)).toEqual(["fake-victim"]);
	});
});
