import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Codemode/MCP admissions remain refused pending reviewed re-enable.
	// Generic tool search remains replaceable independently of those integrations.
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
];
