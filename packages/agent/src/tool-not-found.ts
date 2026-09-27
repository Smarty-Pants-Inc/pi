const MAX_LISTED_TOOL_NAMES = 40;

/**
 * Describe the tool names that are valid in this session, so a model that called an unknown
 * tool can retry with a real one. Names are deduplicated, sorted, and capped.
 */
export function formatAvailableToolNames(toolNames: readonly string[]): string {
	const names = [...new Set(toolNames)].sort();
	if (names.length === 0) return "No tools are available in this session.";
	const listed = names.slice(0, MAX_LISTED_TOOL_NAMES).join(", ");
	const omitted = names.length - MAX_LISTED_TOOL_NAMES;
	return omitted > 0 ? `Available tools: ${listed}, ... (${omitted} more)` : `Available tools: ${listed}`;
}
