import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { readCodemodeStore } from "../../src/extensions/codemode/execute.ts";
import type { CodemodeToolDetails } from "../../src/extensions/codemode/tool.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { getOutputDirectory } from "../../src/utils/output-files.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

// smarty-dev#4506: real CLI resource loading -> faux provider -> native read -> worker VM -> owned output.
// Offline regression, not the installed-session/real-model E2E-4506-codemode-realpath release gate.
it.each(["default", "settings", "explicit"] as const)(
	"runs Codemode from %s builtin admission and saves the result in the owned directory",
	async (admission) => {
		const directory = mkdtempSync(join(tmpdir(), "pi4506-codemode-"));
		let harness: Harness | undefined;
		let spill: string | undefined;
		try {
			const agentDir = join(directory, "agent");
			mkdirSync(agentDir);
			const loader = new DefaultResourceLoader({
				cwd: directory,
				agentDir,
				settingsManager: SettingsManager.inMemory({
					extensions:
						admission === "settings"
							? ["+builtin:codemode"]
							: admission === "explicit"
								? ["-builtin:codemode"]
								: [],
				}),
				additionalExtensionPaths: admission === "explicit" ? ["builtin:codemode"] : [],
				extensionFactories: builtInExtensions,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getExtensions().extensions.map((extension) => extension.path)).toContain("builtin:codemode");
			expect(loader.getExtensions().extensions.map((extension) => extension.path)).not.toContain("builtin:mcp");
			harness = await createHarness({
				cwd: directory,
				resourceLoader: loader,
				initialActiveToolNames: ["read", "codemode"],
			});
			writeFileSync(join(directory, "input.txt"), "offline-4506");
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("codemode", {
							code: `// @options: {"max_output_tokens": 20}
								const value = await tools.read({ path: "input.txt" });
								store("checked", value);
								for (let i = 0; i < 100; i++) text(value + ":" + i);`,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Read the input through Codemode and retain its output.");
			const result = getToolResult(harness, "codemode");
			expect(result.isError).toBe(false);
			const details = result.details as unknown as CodemodeToolDetails;
			expect(details.calls).toMatchObject([{ name: "read", status: "ok" }]);
			spill = details.fullOutputPath;
			if (!spill) throw new Error("Codemode did not save its full output");
			expect(dirname(spill)).toBe(getOutputDirectory());
			expect(lstatSync(getOutputDirectory()).mode & 0o777).toBe(0o700);
			expect(lstatSync(spill).mode & 0o777).toBe(0o400);
			expect(readFileSync(spill, "utf8")).toContain("offline-4506:99");
			expect(readCodemodeStore(harness.sessionManager.getBranch())).toEqual({ checked: "offline-4506" });
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			await harness?.cleanup();
			if (spill) rmSync(spill, { force: true });
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
