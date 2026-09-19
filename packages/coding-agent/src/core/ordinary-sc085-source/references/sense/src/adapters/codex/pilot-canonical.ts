import assert from "node:assert/strict";

/** Exact helper d3f93ab4 v2 decision recipe over the schema's restricted numeric
 * domain. This is NOT the version1 prepared-credential envelope serializer. */
export function canonicalPilotDecision(value: unknown): Buffer {
	const string = (value: string) => {
		assert(
			!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
			"PILOT_UNICODE_SCALAR_REQUIRED",
		);
		return JSON.stringify(value);
	};
	const compare = (a: string, b: string) => {
		const x = Array.from(a, (c) => c.codePointAt(0)!),
			y = Array.from(b, (c) => c.codePointAt(0)!);
		for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
		return x.length - y.length;
	};
	const encode = (item: unknown, depth: number): string => {
		assert(depth <= 32, "PILOT_JSON_DEPTH");
		if (item === null) return "null";
		if (typeof item === "boolean") return item ? "true" : "false";
		if (typeof item === "string") return string(item);
		if (typeof item === "number") {
			assert(Number.isSafeInteger(item) && item >= 0 && !Object.is(item, -0), "PILOT_SAFE_INTEGER_REQUIRED");
			return String(item);
		}
		assert(item && typeof item === "object", "PILOT_JSON_VALUE");
		if (Array.isArray(item)) return `[${Array.from(item, (child) => encode(child, depth + 1)).join(",")}]`;
		assert(
			Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null,
			"PILOT_JSON_OBJECT",
		);
		return `{${Object.keys(item)
			.sort(compare)
			.map((key) => `${string(key)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`)
			.join(",")}}`;
	};
	const bytes = Buffer.from(`${encode(value, 0)}\n`, "utf8");
	assert(bytes.length <= 64 * 1024, "PILOT_FILE_BOUND");
	return bytes;
}

export function parseCanonicalPilotDecision(bytes: Uint8Array): unknown {
	assert(bytes.length > 0 && bytes.length <= 64 * 1024, "PILOT_FILE_BOUND");
	const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
	// Exact comparison rejects duplicates, reordered keys, float/exponent lexical
	// forms, negative zero, BOM, alternate escapes and extra/missing final LF.
	assert(canonicalPilotDecision(value).equals(bytes), "PILOT_CANONICAL_JSON");
	return value;
}
