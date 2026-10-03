// Trusted lifetime credits, independent of guest globals and heap accounting.
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TRANSIT_BYTES = 16 * 1024 * 1024;
export const MAX_TRANSIT_ITEMS = 512;
export const MAX_OUTPUT_ITEMS = 256;
export const MAX_CALLS = 64;
export const MAX_PENDING_CALLS = 16;
export const MAX_EXECUTION_MS = 300_000;

/** Stop serialization before constructing an unbounded JSON string. Conservatively count escapes. */
export function boundedJson(value: unknown, maxBytes = MAX_MESSAGE_BYTES): string | undefined {
	let bytes = 0;
	return JSON.stringify(value, (key, item: unknown) => {
		bytes += key.length * 6 + 8;
		if (typeof item === "string") bytes += item.length * 6;
		if (typeof item === "number") bytes += 32;
		if (bytes > maxBytes) throw new Error("Sandbox message byte budget exceeded");
		return item;
	});
}
