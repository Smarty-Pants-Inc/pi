/** PR #131 shipping cut: MCP stays refused; pi#203 repaired Codemode (smarty-dev#4506 step 2). */
export function isUnreviewedBuiltin(name: string): boolean {
	return name === "mcp";
}

export function refuseUnreviewedBuiltin(name: "codemode" | "mcp"): void {
	if (!isUnreviewedBuiltin(name)) return;
	throw new Error(
		`${name.toUpperCase()}_SECURITY_REVIEW_REQUIRED: ${name} is disabled pending reviewed re-enable; configuration and explicit opt-in cannot activate it.`,
	);
}
