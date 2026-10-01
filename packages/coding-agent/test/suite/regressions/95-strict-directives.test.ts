// PR #95 R8 P2: import observation must preserve directive prologues without making sloppy CJS strict.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../../../src/core/extensions/loader.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
	while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("PR #95 extension directive prologues", () => {
	// PR #95: use the real file loader, then dispatch the loaded hook through a faux-provider session.
	it.each([
		{ name: "strict CJS", extension: "cjs", prefix: '"use strict";\n', strict: true },
		{
			name: "strict JS with hashbang, comments and multiple ASI directives",
			extension: "js",
			prefix: "#!/usr/bin/env node\n/* header */\n\"use metadata\"\n// another directive\n'use strict'\n",
			strict: true,
		},
		{ name: "strict TypeScript", extension: "ts", prefix: '"use strict";\n', strict: true },
		{ name: "strict ES module", extension: "mjs", prefix: '"use strict";\n', strict: true, esm: true },
		{ name: "strict TypeScript ES module", extension: "ts", prefix: '"use strict";\n', strict: true, esm: true },
		{ name: "sloppy CJS", extension: "cjs", prefix: "", strict: false },
		{ name: "escaped non-strict directive", extension: "cjs", prefix: '"use\\x20strict";\n', strict: false },
		{ name: "parenthesized non-directive", extension: "cjs", prefix: '("use strict");\n', strict: false },
		{ name: "string after a statement", extension: "cjs", prefix: 'void 0;\n"use strict";\n', strict: false },
		{
			name: "strict dependent TypeScript helper",
			extension: "ts",
			prefix: '"use strict";\n',
			strict: true,
			dependent: true,
		},
		{ name: "sloppy dependent TypeScript helper", extension: "ts", prefix: "", strict: false, dependent: true },
	])("$name preserves unbound function this", async ({ extension, prefix, strict, dependent, esm }) => {
		const root = mkdtempSync(join(tmpdir(), "pi-95-directives-"));
		directories.push(root);
		const entry = join(root, `extension.${extension}`);
		const implementation = dependent ? join(root, "helper.ts") : entry;
		writeFileSync(
			implementation,
			`${prefix}
function unboundThis() { return this; }
const moduleStrict = unboundThis() === undefined;
${esm ? "export default" : "module.exports ="} function(pi) {
	const factoryStrict = unboundThis() === undefined;
	pi.on("before_agent_start", () => ({
		message: {
			customType: "directive-probe",
			content: JSON.stringify({ moduleStrict, factoryStrict, handlerStrict: unboundThis() === undefined }),
			display: false,
		},
	}));
};`,
		);
		if (dependent) writeFileSync(entry, 'export { default } from "./helper.ts";');
		const extensionsResult = await loadExtensions([entry], root);
		expect(extensionsResult.errors).toEqual([]);
		expect(extensionsResult.extensions).toHaveLength(1);
		const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("probe extension directives");

		expect(harness.session.messages.find((message) => message.role === "custom")).toMatchObject({
			customType: "directive-probe",
			content: JSON.stringify({ moduleStrict: strict, factoryStrict: strict, handlerStrict: strict }),
		});
		expect(getAssistantTexts(harness)).toEqual(["done"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
