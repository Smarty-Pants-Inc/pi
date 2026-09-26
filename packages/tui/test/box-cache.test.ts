import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import type { Component } from "../src/tui.ts";

// Smarty-Pants-Inc/smarty-dev#1043: every frame renders every box in the transcript.
describe("Box render cache", () => {
	class Child implements Component {
		lines: string[];
		renders = 0;
		constructor(lines: string[]) {
			this.lines = lines;
		}
		render(): string[] {
			this.renders++;
			return this.lines;
		}
		invalidate(): void {}
	}
	const child = (lines: string[]) => new Child(lines);

	it("reuses its lines while children render the same lines, and rebuilds when a child changes", () => {
		const a = child(["a"]);
		const b = child(["b"]);
		const box = new Box(1, 0);
		box.addChild(a);
		box.addChild(b);

		const first = box.render(10);
		assert.deepStrictEqual(first, [" a        ", " b        "]);
		assert.strictEqual(box.render(10), first);
		assert.strictEqual(a.renders, 2);

		b.lines = ["b2", "b3"];
		assert.deepStrictEqual(box.render(10), [" a        ", " b2       ", " b3       "]);

		// Same content in a new array: equal lines, cache kept.
		const second = box.render(10);
		b.lines = ["b2", "b3"];
		assert.strictEqual(box.render(10), second);

		assert.deepStrictEqual(box.render(6), [" a    ", " b2   ", " b3   "]);
	});

	it("rebuilds when the background function output changes", () => {
		let color = "1";
		const box = new Box(0, 0, (text) => `<${color}>${text}`);
		box.addChild(child(["x"]));
		const first = box.render(3);
		assert.strictEqual(box.render(3), first);
		color = "2";
		assert.notStrictEqual(box.render(3), first);
		assert.ok(box.render(3)[0].includes("<2>"));
	});
});
