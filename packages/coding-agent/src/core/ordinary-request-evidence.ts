import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ResponsesUsage } from "@earendil-works/pi-ai/api/responses-evidence";

export interface NativeRequestSource {
	profileSha256: string;
	recipe: string;
	packageSha256: string;
	applicationSha256: string;
	senseSha256: string;
	provider: string;
	model: string;
	api: string;
	baseUrl: string;
}

/** Pure projection, not authentication. The audit supplies its retained original
 * body and original guarded capture. Never remove arbitrary equal-text messages. */
export function nonViewRequest(bytes: Uint8Array, frameText: string | null): Uint8Array {
	const wire: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	if (!wire || typeof wire !== "object" || Array.isArray(wire) || !("input" in wire) || !Array.isArray(wire.input)) {
		throw new Error("OWNER_REQUEST_HISTORY_UNAVAILABLE: responses input");
	}
	if (frameText !== null) {
		const last = wire.input.at(-1);
		if (!isDeepStrictEqual(last, { role: "user", content: [{ type: "input_text", text: frameText }] })) {
			throw new Error("OWNER_REQUEST_HISTORY_UNAVAILABLE: original final view serialization");
		}
		wire.input = wire.input.slice(0, -1);
	}
	return new TextEncoder().encode(JSON.stringify(wire));
}

/** Facts from the existing raw Responses counters, not AssistantMessage defaults.
 * RawRefs must be issued by the host's actual durable recorder, never this helper. */
export function requestCost(usage: Readonly<ResponsesUsage> | null, finalInputBytes: number) {
	const fact = (value: number | null, unknown: string | null) => ({ value, raw: null, unknown });
	const cached = usage?.cachedInputTokens ?? null;
	return {
		uncachedTokens: fact(
			usage && cached !== null ? usage.inputTokens - cached : null,
			usage && cached !== null ? null : "Original complete input/cache breakdown unavailable",
		),
		cachedTokens: fact(cached, cached === null ? "Original cached input counter unavailable" : null),
		finalInputBytes: fact(finalInputBytes, null),
		latencyMs: fact(null, "Qualified latency boundary and clock uncertainty unavailable"),
	};
}

export function requestDigest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
