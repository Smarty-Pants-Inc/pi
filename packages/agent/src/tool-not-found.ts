const MAX_LISTED_TOOLS = 40;

/** Name the tools valid in this session so the model can correct the call (smarty-dev#1528 K05). */
export function toolNotFoundMessage(name: string, tools: ReadonlyArray<{ name: string }>): string {
	const names = [...new Set(tools.map((t) => t.name))].sort();
	if (names.length === 0) return `Tool ${name} not found. No tools are available in this session.`;
	const listed = names.slice(0, MAX_LISTED_TOOLS).join(", ");
	const more = names.length > MAX_LISTED_TOOLS ? `, ... (${names.length - MAX_LISTED_TOOLS} more)` : "";
	return `Tool ${name} not found. Available tools in this session: ${listed}${more}`;
}
