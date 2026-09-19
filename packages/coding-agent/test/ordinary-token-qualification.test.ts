import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
	parseResponsesTokenCount,
	projectResponsesTokenCount,
	validateResponsesTokenCount,
} from "../src/core/ordinary-token-qualification.ts";

// Pure synthetic serializer/result checks. Not count-endpoint permission, an
// authenticated count response, a native reservation or provider qualification.
const admitted = { wireModel: "synthetic", contextTokens: 1000, outputTokens: 100 };
const payload = {
	model: "synthetic",
	stream: true,
	store: false,
	max_output_tokens: 100,
	input: [{ role: "user", content: [{ type: "input_text", text: 'quotes " slash \\ newline\n unicode☃' }] }],
	instructions: "synthetic instruction",
	tools: [
		{ type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
	],
	tool_choice: "auto",
	reasoning: { effort: "high" },
	text: { format: { type: "json_schema", name: "result", schema: { type: "object" } } },
	prompt_cache_key: "synthetic-cache",
	include: ["reasoning.encrypted_content"],
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("full-request native count projection", () => {
	test("parses only the exact count response schema without duplicate or extra fields", () => {
		expect(parseResponsesTokenCount('{"object":"response.input_tokens","input_tokens":0}')).toBe(0);
		expect(parseResponsesTokenCount(' { "input_tokens": 900, "object": "response.input_tokens" }\n')).toBe(900);
		for (const text of [
			'{"object":"response.input_tokens","input_tokens":1,"input_tokens":2}',
			'{"object":"response.input_tokens","input_tokens":1,"extra":true}',
			'{"object":"response.input_tokens","input_tokens":null}',
			'{"object":"response.input_tokens","input_tokens":1.5}',
			'{"object":"response.input_tokens","input_tokens":9007199254740992}',
			'{"object":"other","input_tokens":1}',
		])
			expect(() => parseResponsesTokenCount(text)).toThrow("OWNER_TOKEN_COUNT_RESPONSE");
	});

	test("preserves all context-bearing fields and hashes the exact escaped wire bytes", () => {
		const bytes = encode(payload);
		const projection = projectResponsesTokenCount(bytes, admitted);
		expect(projection.payloadHash).toBe(createHash("sha256").update(bytes).digest("hex"));
		const counted = JSON.parse(projection.countBody);
		for (const key of ["model", "input", "instructions", "tools", "tool_choice", "reasoning", "text"] as const)
			expect(counted[key]).toEqual(payload[key]);
		expect(counted.truncation).toBe("disabled");
		expect(counted).not.toHaveProperty("stream");
		expect(counted).not.toHaveProperty("max_output_tokens");
		expect(validateResponsesTokenCount(projection, { object: "response.input_tokens", input_tokens: 900 })).toBe(900);
		expect(() =>
			validateResponsesTokenCount(projection, { object: "response.input_tokens", input_tokens: 901 }),
		).toThrow("OWNER_TOKEN_CONTEXT_EXCEEDED");
		const changed = projectResponsesTokenCount(encode({ ...payload, instructions: "changed" }), admitted);
		expect(changed.payloadHash).not.toBe(projection.payloadHash);
		expect(changed.countBodyHash).not.toBe(projection.countBodyHash);
	});

	test("rejects duplicate-key and non-SDK serialization before count projection", () => {
		const raw = encode(payload).toString();
		expect(() =>
			projectResponsesTokenCount(
				Buffer.from(raw.replace('"model":"synthetic"', '"model":"other","model":"synthetic"')),
				admitted,
			),
		).toThrow("OWNER_TOKEN_SERIALIZER");
		expect(() => projectResponsesTokenCount(Buffer.from(`${raw}\n`), admitted)).toThrow("OWNER_TOKEN_SERIALIZER");
	});

	test.each(["previous_response_id", "conversation", "unknown_context_extension"])(
		"rejects uncounted %s instead of omitting context",
		(field) => {
			expect(() =>
				projectResponsesTokenCount(encode({ ...payload, [field]: "synthetic-reference" }), admitted),
			).toThrow("OWNER_TOKEN_UNCOUNTED_FIELD");
		},
	);

	test("rejects mutable media, hosted tools and automatic truncation", () => {
		for (const changed of [
			{ ...payload, truncation: "auto" },
			{ ...payload, tools: [{ type: "web_search" }] },
			{ ...payload, input: [{ type: "item_reference", id: "prior" }] },
			{
				...payload,
				input: [
					{ role: "user", content: [{ type: "input_image", image_url: "https://mutable.invalid/image.png" }] },
				],
			},
			{ ...payload, input: [{ role: "user", content: [{ type: "input_file", file_id: "file-A" }] }] },
		])
			expect(() => projectResponsesTokenCount(encode(changed), admitted)).toThrow();
	});

	test("keeps inline image bytes and local tool results in the native count input", () => {
		const input = [
			{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==", detail: "high" }] },
			{ type: "function_call_output", call_id: "call-A", output: "synthetic tool output" },
		];
		const projection = projectResponsesTokenCount(encode({ ...payload, input }), admitted);
		expect(JSON.parse(projection.countBody).input).toEqual(input);
	});

	test.each([
		null,
		{},
		{ input_tokens: 5 },
		{ object: "response.input_tokens", input_tokens: -1 },
		{ object: "response.input_tokens", input_tokens: 1.5 },
		{ object: "response.input_tokens", input_tokens: "5" },
	])("does not manufacture a count from malformed result %s", (result) => {
		expect(() => validateResponsesTokenCount(projectResponsesTokenCount(encode(payload), admitted), result)).toThrow(
			"OWNER_TOKEN_COUNT_RESPONSE",
		);
	});
});
