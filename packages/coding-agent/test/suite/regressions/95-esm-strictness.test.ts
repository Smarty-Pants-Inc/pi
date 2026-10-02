// pi#95 R10: captured-byte evaluation must preserve ESM strictness and sloppy CommonJS.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { loadExtensions } from "../../../src/core/extensions/loader.ts";

const directories: string[] = [];
const probeKey = "pi95StrictnessProbe";
afterEach(() => {
	Reflect.deleteProperty(globalThis, probeKey);
	while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

it.each([
	{ file: "extension.mjs", declaration: "export default", directive: "", strict: true },
	{ file: "extension.ts", declaration: "export default", directive: "", strict: true },
	{ file: "extension.cjs", declaration: "module.exports =", directive: "", strict: false },
	{ file: "strict.cjs", declaration: "module.exports =", directive: '"use strict";', strict: true },
])("preserves $file strictness (strict=$strict)", async ({ file, declaration, directive, strict }) => {
	const root = mkdtempSync(join(tmpdir(), "pi-95-strictness-"));
	directories.push(root);
	const path = join(root, file);
	writeFileSync(
		path,
		`${directive}
		${declaration} function(pi) {
			let threw = false;
			try { pi95UndeclaredStrictness = 1; } catch (error) { threw = error instanceof ReferenceError; }
			delete globalThis.pi95UndeclaredStrictness;
			pi.events.emit("strictness", { threw, receiver: (function() { return this; })() === undefined });
		}`,
	);
	const eventBus = createEventBus();
	let result: unknown;
	eventBus.on("strictness", (value) => {
		result = value;
	});
	const loaded = await loadExtensions([path], root, eventBus);
	expect(loaded.errors).toEqual([]);
	expect(loaded.extensions).toHaveLength(1);
	expect(result).toEqual({ threw: strict, receiver: strict });
});

// pi#95 R10: a syntax-free .mjs dependency is still ESM; a .cjs dependency stays sloppy.
it.each([
	{ suffix: "mjs", strict: true },
	{ suffix: "cjs", strict: false },
])(
	"preserves directive-free .$suffix dependency strictness without import/export syntax",
	async ({ suffix, strict }) => {
		const root = mkdtempSync(join(tmpdir(), "pi-95-dependency-strictness-"));
		directories.push(root);
		writeFileSync(
			join(root, `helper.${suffix}`),
			`
		let threw = false;
		try { pi95UndeclaredStrictness = 1; } catch (error) { threw = error instanceof ReferenceError; }
		delete globalThis.pi95UndeclaredStrictness;
		globalThis.${probeKey} = { threw, receiver: (function() { return this; })() === undefined };
	`,
		);
		const path = join(root, "extension.ts");
		writeFileSync(
			path,
			`import "./helper.${suffix}"; export default function(pi) {
		pi.events.emit("strictness", globalThis.${probeKey});
	}`,
		);
		const eventBus = createEventBus();
		let result: unknown;
		eventBus.on("strictness", (value) => {
			result = value;
		});
		const loaded = await loadExtensions([path], root, eventBus);
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(1);
		expect(result).toEqual({ threw: strict, receiver: strict });
	},
);
