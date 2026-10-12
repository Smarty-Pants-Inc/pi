/** Temporary shipping refusal for PR #131; only a reviewed source change may re-enable MCP. */
export function refuseMcpAdmission(): void {
	throw new Error(
		"MCP_SECURITY_REVIEW_REQUIRED: MCP is disabled pending reviewed re-enable; configuration and explicit opt-in cannot activate it.",
	);
}
