import { createHash } from "node:crypto";

export interface ResponsesCountProjection {
	readonly payloadHash: string;
	readonly countBody: string;
	readonly countBodyHash: string;
	readonly wireModel: string;
	readonly contextTokens: number;
	readonly outputTokens: number;
}

/** Pure serializer projection, NOT authority to call the count endpoint and NOT
 * an issued qualification receipt. Installed Responses input-token API accepts
 * these complete context-bearing fields; no tokenizer or byte ratio is guessed. */
export function projectResponsesTokenCount(
	bytes: Uint8Array,
	admitted: {
		readonly wireModel: string;
		readonly contextTokens: number;
		readonly outputTokens: number;
	},
): Readonly<ResponsesCountProjection> {
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OWNER_TOKEN_PAYLOAD");
	// Installed SDK FallbackEncoder uses JSON.stringify(body). Require those
	// exact bytes so duplicate keys or alternate decoders cannot change the count.
	if (JSON.stringify(value) !== text) throw new Error("OWNER_TOKEN_SERIALIZER");
	const wire = value as Record<string, unknown>;
	if (
		wire.model !== admitted.wireModel ||
		wire.stream !== true ||
		wire.store !== false ||
		(wire.background !== undefined && wire.background !== false) ||
		(wire.truncation !== undefined && wire.truncation !== "disabled") ||
		!Number.isSafeInteger(wire.max_output_tokens) ||
		(wire.max_output_tokens as number) <= 0 ||
		(wire.max_output_tokens as number) > admitted.outputTokens ||
		!Number.isSafeInteger(admitted.contextTokens) ||
		!Number.isSafeInteger(admitted.outputTokens) ||
		admitted.outputTokens <= 0 ||
		admitted.contextTokens > 2_000_000 ||
		admitted.contextTokens < admitted.outputTokens
	)
		throw new Error("OWNER_TOKEN_PAYLOAD");
	// The count endpoint must see every context-bearing field unchanged. Unknown
	// top-level sampling extensions cannot silently evade this qualification.
	const contextFields = new Set([
		"model",
		"input",
		"instructions",
		"parallel_tool_calls",
		"personality",
		"reasoning",
		"text",
		"tool_choice",
		"tools",
		"truncation",
	]);
	const transportFields = new Set([
		"stream",
		"store",
		"background",
		"max_output_tokens",
		"temperature",
		"top_p",
		"service_tier",
		"include",
		"prompt_cache_key",
		"prompt_cache_retention",
		"prompt_cache_options",
		"metadata",
		"user",
		"safety_identifier",
	]);
	for (const name of Object.keys(wire)) {
		if (!contextFields.has(name) && !transportFields.has(name)) throw new Error("OWNER_TOKEN_UNCOUNTED_FIELD");
	}
	// No independently mutable server history, hosted tools, file IDs or remote
	// image URLs between counting and inference. Ordinary tools are local function
	// or custom definitions; their complete schemas remain in the count request.
	if (
		wire.tools !== undefined &&
		(!Array.isArray(wire.tools) ||
			wire.tools.some(
				(tool: unknown) =>
					!tool ||
					typeof tool !== "object" ||
					!("type" in tool) ||
					!["function", "custom"].includes(String(tool.type)),
			))
	) {
		throw new Error("OWNER_TOKEN_MUTABLE_CONTEXT");
	}
	if (typeof wire.input !== "string") {
		if (!Array.isArray(wire.input)) throw new Error("OWNER_TOKEN_MUTABLE_CONTEXT");
		for (const item of wire.input as unknown[]) {
			if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("OWNER_TOKEN_MUTABLE_CONTEXT");
			const fields = item as Record<string, unknown>;
			if (
				fields.type !== undefined &&
				![
					"message",
					"function_call",
					"function_call_output",
					"custom_tool_call",
					"custom_tool_call_output",
					"reasoning",
					"compaction",
				].includes(String(fields.type))
			) {
				throw new Error("OWNER_TOKEN_MUTABLE_CONTEXT");
			}
			const content =
				fields.type === "function_call_output" || fields.type === "custom_tool_call_output"
					? fields.output
					: fields.content;
			if (Array.isArray(content))
				for (const part of content as unknown[]) {
					if (!part || typeof part !== "object" || Array.isArray(part))
						throw new Error("OWNER_TOKEN_MUTABLE_CONTEXT");
					const data = part as Record<string, unknown>;
					if (
						!["input_text", "output_text", "refusal", "input_image"].includes(String(data.type)) ||
						(data.type === "input_image" &&
							(Object.hasOwn(data, "file_id") ||
								typeof data.image_url !== "string" ||
								!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(data.image_url)))
					) {
						throw new Error("OWNER_TOKEN_MUTABLE_CONTEXT");
					}
				}
		}
	}
	const projected: Record<string, unknown> = {};
	for (const name of Object.keys(wire)) if (contextFields.has(name)) projected[name] = wire[name];
	projected.truncation = "disabled";
	const countBody = JSON.stringify(projected);
	return Object.freeze({
		payloadHash: createHash("sha256").update(bytes).digest("hex"),
		countBody,
		countBodyHash: createHash("sha256").update(countBody).digest("hex"),
		wireModel: admitted.wireModel,
		contextTokens: admitted.contextTokens,
		outputTokens: wire.max_output_tokens as number,
	});
}

/** Native count API has exactly these two JSON fields. Refuse duplicate keys,
 * alternate objects and ambiguous encodings before treating a response as final.
 * Whitespace and either field order are permitted; no input count is estimated. */
export function parseResponsesTokenCount(text: string): number {
	const object = '"object"\\s*:\\s*"response\\.input_tokens"';
	const tokens = '"input_tokens"\\s*:\\s*(0|[1-9][0-9]*)';
	const shape = new RegExp(`^\\s*\\{\\s*(?:${object}\\s*,\\s*${tokens}|${tokens}\\s*,\\s*${object})\\s*\\}\\s*$`);
	if (!shape.test(text)) throw new Error("OWNER_TOKEN_COUNT_RESPONSE");
	const value = JSON.parse(text) as { input_tokens: number };
	if (!Number.isSafeInteger(value.input_tokens)) throw new Error("OWNER_TOKEN_COUNT_RESPONSE");
	return value.input_tokens;
}

/** Pure result validation only. A production caller must bind the actual count
 * Response/socket to its original reservation before issuing any usable receipt. */
export function validateResponsesTokenCount(projection: Readonly<ResponsesCountProjection>, result: unknown): number {
	if (
		!result ||
		typeof result !== "object" ||
		Array.isArray(result) ||
		!Object.hasOwn(result, "object") ||
		!Object.hasOwn(result, "input_tokens") ||
		!("object" in result) ||
		result.object !== "response.input_tokens" ||
		!("input_tokens" in result) ||
		typeof result.input_tokens !== "number" ||
		!Number.isSafeInteger(result.input_tokens) ||
		result.input_tokens < 0
	) {
		throw new Error("OWNER_TOKEN_COUNT_RESPONSE");
	}
	if (result.input_tokens > projection.contextTokens - projection.outputTokens)
		throw new Error("OWNER_TOKEN_CONTEXT_EXCEEDED");
	return result.input_tokens;
}
