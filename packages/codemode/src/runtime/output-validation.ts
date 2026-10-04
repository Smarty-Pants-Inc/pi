import type { CodemodeOutputItem } from "../types.ts";
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_ITEMS } from "./prelude-source.ts";

/** Both the worker relay and host retention enforce the budget independently of mutable VM helpers. */
export function validateOutput(item: CodemodeOutputItem, chars: number, items: number): number {
	let size: number;
	if (item.type === "image") {
		if (
			typeof item.data !== "string" ||
			!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(item.mimeType)
		) {
			throw new Error("Invalid sandbox image output");
		}
		size = item.data.length + item.mimeType.length;
	} else if (item.type === "text" && typeof item.text === "string") size = item.text.length;
	else throw new Error("Invalid sandbox output");
	if (chars + size > MAX_OUTPUT_CHARS || items >= MAX_OUTPUT_ITEMS)
		throw new Error("Sandbox output exceeds host budget");
	return chars + size;
}
