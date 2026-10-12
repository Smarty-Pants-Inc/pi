/** PR #131 shipping cut. Old settings and explicit opt-in are not security-review authority. */
export function isUnreviewedBuiltin(name: string): boolean {
	return name === "codemode" || name === "mcp";
}

export function refuseUnreviewedBuiltin(name: "codemode" | "mcp"): void {
	throw new Error(
		`${name.toUpperCase()}_SECURITY_REVIEW_REQUIRED: ${name} is disabled pending reviewed re-enable; configuration and explicit opt-in cannot activate it.`,
	);
}
