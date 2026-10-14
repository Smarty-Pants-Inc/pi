import type { ModelCost, ModelCostTier } from "../types.ts";

/** OpenRouter's per-token prices, as decimal strings. */
export interface OpenRouterPricing {
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
	overrides?: OpenRouterPricingOverride[];
}

/**
 * A conditional price. `min_prompt_tokens` selects prompt-length pricing; `utc_*` fields select
 * time-of-day or weekday pricing. Missing rates keep the base price.
 */
export interface OpenRouterPricingOverride {
	min_prompt_tokens?: number;
	utc_start?: number;
	utc_end?: number;
	utc_days?: string[];
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
}

/** The fields pi reads from a model in OpenRouter's `GET /models` and `GET /models/user`. */
export interface OpenRouterModel {
	id: string;
	context_length?: number | null;
	top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
	pricing?: OpenRouterPricing;
}

/**
 * Convert one $/token price to $/1M tokens. Missing prices keep the fallback. Invalid and negative
 * sentinel prices are unknown and use a zero estimate, never a credit or a partial parsed rate.
 */
function perMillion(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const rate = Number(value) * 1_000_000;
	return Number.isFinite(rate) && rate > 0 ? Number(rate.toFixed(6)) : 0;
}

/**
 * Convert OpenRouter's $/token prices to pi's $/1M tokens. Missing, invalid and negative base
 * prices are 0. Prompt-length overrides become request-wide tiers; a rate a tier does not list
 * keeps the base price. Time-of-day overrides are skipped because ModelCost cannot express them.
 */
export function openRouterCost(pricing: OpenRouterPricing | undefined): ModelCost {
	const base = {
		input: perMillion(pricing?.prompt, 0),
		output: perMillion(pricing?.completion, 0),
		cacheRead: perMillion(pricing?.input_cache_read, 0),
		cacheWrite: perMillion(pricing?.input_cache_write, 0),
	};
	const tiers = (pricing?.overrides ?? []).flatMap((override): ModelCostTier[] => {
		if (
			override.min_prompt_tokens === undefined ||
			override.utc_start !== undefined ||
			override.utc_end !== undefined ||
			override.utc_days !== undefined
		) {
			return [];
		}
		return [
			{
				inputTokensAbove: override.min_prompt_tokens,
				input: perMillion(override.prompt, base.input),
				output: perMillion(override.completion, base.output),
				cacheRead: perMillion(override.input_cache_read, base.cacheRead),
				cacheWrite: perMillion(override.input_cache_write, base.cacheWrite),
			},
		];
	});
	return tiers.length > 0 ? { ...base, tiers } : base;
}
