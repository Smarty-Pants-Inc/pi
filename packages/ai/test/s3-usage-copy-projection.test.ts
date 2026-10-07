import { describe, expect, it } from "vitest";
import type { Usage } from "../src/types.ts";
import { projectUsage } from "../src/utils/diagnostics.ts";

// smarty-dev#5822: a copy of a projected usage must project to the same Pi-owned total.
describe("projectUsage copy stability", () => {
	it("keeps cost.total 0.5 when a structured copy of a projected usage is projected again", () => {
		const supplied = {
			input: 7,
			output: "secret",
			cacheRead: null,
			cacheWrite: true,
			totalTokens: {},
			cost: { input: 0.25, output: "secret", cacheRead: null, cacheWrite: [], total: 0.5 },
		} as unknown as Usage;
		const first = projectUsage(supplied);
		expect(first.cost).toEqual({ input: 0.25, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 });
		const again = projectUsage(structuredClone(first));
		expect(again.cost.total).toBe(0.5);
		expect(projectUsage({ ...again, cost: { ...again.cost } }).cost.total).toBe(0.5);
	});

	it("still replaces an unprojected complete breakdown's supplied total with the component sum", () => {
		const usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 99 },
		} as Usage;
		expect(projectUsage(usage).cost.total).toBe(0);
	});
});
