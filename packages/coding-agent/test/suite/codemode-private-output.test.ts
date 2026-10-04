import { readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import type { CodemodeToolDetails } from "../../src/extensions/codemode/tool.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

// pi#137 A3: ordinary CLI umasks must not expose untruncated nested-tool output.
describe("Codemode private spill output", () => {
	let harness: Harness | undefined;
	let spill: string | undefined;
	afterEach(() => {
		if (spill) rmSync(spill, { force: true });
		harness?.cleanup();
		harness = undefined;
		spill = undefined;
		vi.restoreAllMocks();
		syncBuiltinESMExports();
	});

	const secret = "private nested output\n".repeat(100);
	async function setup() {
		harness = await createHarness({
			initialActiveToolNames: ["codemode"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi) =>
					pi.registerTool({
						name: "private_output",
						label: "Private output",
						description: "Private output",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: secret }], details: {} }),
					}),
			],
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: '// @options: {"max_output_tokens": 10}\nreturn await tools.private_output({});',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		return harness;
	}

	it.skipIf(process.platform === "win32")("creates full nested output with mode 0600 under umask 022", async () => {
		const harness = await setup();
		const previous = process.umask(0o022);
		try {
			await harness.session.prompt("spill private output");
			const result = getToolResult(harness, "codemode");
			expect(result.isError, JSON.stringify(result.content)).toBe(false);
			spill = (result.details as unknown as CodemodeToolDetails).fullOutputPath;
			if (!spill) throw new Error("No spill file");
			expect(readFileSync(spill, "utf8")).toBe(secret);
			expect(statSync(spill).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(previous);
		}
	});

	it.skipIf(process.platform === "win32")(
		"does not follow a symlink placed at the spill path before creation",
		async () => {
			const harness = await setup();
			const victim = join(harness.tempDir, "sentinel.txt");
			writeFileSync(victim, "retained sentinel", { mode: 0o600 });
			const writeFile = fs.writeFile;
			vi.spyOn(fs, "writeFile").mockImplementation(async (path, data, options) => {
				if (typeof path === "string" && basename(path).startsWith("pi-codemode-")) {
					spill = path;
					symlinkSync(victim, path);
				}
				await writeFile(path, data, options);
			});
			syncBuiltinESMExports();
			await harness.session.prompt("spill private output");
			const result = getToolResult(harness, "codemode");
			expect(spill).toBeDefined();
			expect(readFileSync(victim, "utf8")).toBe("retained sentinel");
			expect((result.details as unknown as CodemodeToolDetails).fullOutputPath).toBeUndefined();
			expect(JSON.stringify(result.content)).toContain("Could not save the full output");
		},
	);
});
