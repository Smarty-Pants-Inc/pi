import { describe, expect, it } from "vitest";
import { buildOpenRouterCatalog, type OpenRouterModelListItem } from "../scripts/openrouter-catalog.ts";
import { getModel } from "../src/compat.ts";
import { calculateCost } from "../src/models.ts";
import type { Usage } from "../src/types.ts";

const router: OpenRouterModelListItem = {
	id: "typesafe/jev-router",
	name: "TypeSafe: Jev Router",
	supported_parameters: ["tools"],
	pricing: { prompt: "-1", completion: "-1" },
};

function routerUsage(): Usage {
	return {
		input: 1000,
		output: 250,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1250,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("OpenRouter pricing", () => {
	// Regression for Smarty-Pants-Inc/pi#100: the router's -1 sentinel is not a price.
	it("normalizes unknown router prices before usage cost math", () => {
		const model = buildOpenRouterCatalog([router], [], []).chat[0];
		expect(calculateCost(model, routerUsage())).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		});
	});

	// Regression for Smarty-Pants-Inc/pi#100: all catalog operations share the pricing guard.
	it.each(["-1", "-0.000001", "NaN", "Infinity", "1e309", "1e308", "invalid", "0.1garbage", "", undefined])(
		"normalizes invalid or missing rates (%s) for chat, image and classifier models",
		(rate) => {
			const source: OpenRouterModelListItem = {
				...router,
				architecture: { input_modalities: ["text"], output_modalities: ["image", "decisions"] },
				pricing: { prompt: rate, completion: rate, input_cache_read: rate, input_cache_write: rate },
			};
			const catalog = buildOpenRouterCatalog([source], [source], [source]);
			for (const model of [...catalog.chat, ...catalog.images, ...catalog.classifiers]) {
				expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			}
		},
	);

	it("preserves valid nonnegative rates and converts to dollars per million tokens", () => {
		const model = buildOpenRouterCatalog(
			[
				{
					...router,
					pricing: {
						prompt: "0.000000042",
						completion: "0.000002",
						input_cache_read: "0",
						input_cache_write: "0.0000001",
					},
				},
			],
			[],
			[],
		).chat[0];
		expect(model.cost).toEqual({ input: 0.042, output: 2, cacheRead: 0, cacheWrite: 0.1 });
		expect(calculateCost(model, routerUsage()).total).toBeCloseTo(0.000542, 10);
	});

	// Regression for Smarty-Pants-Inc/pi#100: verify the committed snapshot, not just the parser.
	it("ships nonnegative router prices in the built-in catalog", () => {
		const model = getModel("openrouter", "typesafe/jev-router");
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(calculateCost(model, routerUsage()).total).toBe(0);
	});
});
