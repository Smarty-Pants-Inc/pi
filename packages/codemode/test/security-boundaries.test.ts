import { afterEach, expect, it } from "vitest";
import { CodemodeSandbox, MAX_OUTPUT_CHARS, MAX_OUTPUT_ITEMS } from "../src/index.ts";
import { validateOutput } from "../src/runtime/output-validation.ts";

const sandboxes: CodemodeSandbox[] = [];
afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
});

// pi#137 / smarty-dev#3535, security findings 3 and 11.
it.each([
	"Array.prototype.toJSON = function() { delete Array.prototype.toJSON; return ({}); };",
	"Array.prototype.toJSON = function() { delete Array.prototype.toJSON; return [[1, 'true']]; };",
	"Array.prototype.toJSON = function() { delete Array.prototype.toJSON; return [['k', {}]]; };",
	"Array.prototype.toJSON = function() { delete Array.prototype.toJSON; return [['k', 'not-json']]; };",
	"Array.prototype.toJSON = function() { delete Array.prototype.toJSON; return [['k', 'true', 'extra']]; };",
	"Array.prototype.toJSON = function() { delete Array.prototype.toJSON; return [['x'.repeat(1024 * 1024 + 1)]]; };",
	"Array.prototype.toJSON = function() { delete Array.prototype.toJSON; return Array(100001).fill(['k']); };",
])("settles malformed prototype-controlled completion as a sandbox error: %s", async (mutation) => {
	const sandbox = new CodemodeSandbox({ timeoutMs: 10000 });
	sandboxes.push(sandbox);
	const result = await sandbox.execute(`${mutation} store('k', 1);`);
	expect(result).toMatchObject({
		ok: false,
		error: { kind: "sandbox", message: expect.stringContaining("Malformed sandbox completion") },
	});
	expect(await sandbox.execute("return 42")).toMatchObject({ ok: true, value: 42 });
});

it("settles prototype-controlled malformed script errors without crashing the host", async () => {
	const sandbox = new CodemodeSandbox({ timeoutMs: 10000 });
	sandboxes.push(sandbox);
	const result = await sandbox.execute(`Object.prototype.toJSON = () => ({ message: 42 }); throw new Error('bad');`);
	expect(result).toMatchObject({
		ok: false,
		error: { kind: "sandbox", message: expect.stringContaining("Malformed sandbox completion") },
	});
});

it("rejects a mutated image signature helper before relaying a large MIME string", async () => {
	const sandbox = new CodemodeSandbox({ timeoutMs: 10000 });
	sandboxes.push(sandbox);
	const result = await sandbox.execute(`
		Array.prototype.find = () => ['x'.repeat(1024 * 1024), /./];
		for (let i = 0; i < 100; i++) image('data:image/png;base64,iVBORw0KGgo=');
	`);
	expect(result.ok).toBe(false);
	expect(result.output).toEqual([]);
});

it("independently bounds trusted output size, count and canonical MIME values", () => {
	expect(() => validateOutput({ type: "image", data: "abc", mimeType: "x".repeat(1000) }, 0, 0)).toThrow(
		"Invalid sandbox image",
	);
	expect(() => validateOutput({ type: "image", data: "abc", mimeType: "image/png" }, MAX_OUTPUT_CHARS - 3, 0)).toThrow(
		"budget",
	);
	expect(() => validateOutput({ type: "text", text: "" }, 0, MAX_OUTPUT_ITEMS)).toThrow("budget");
});
