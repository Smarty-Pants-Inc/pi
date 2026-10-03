import type { McpServerConfig } from "./mcp-servers.ts";

/** Configuration values and remote failures are not safe report text. */
export function describeMcpTransport(config: McpServerConfig): string {
	if (!("url" in config)) return "stdio (command and arguments omitted)";
	try {
		const url = new URL(config.url);
		url.username = "";
		url.password = "";
		url.hash = "";
		// Query names are not a complete credential schema; omit all values.
		for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, "[redacted]");
		return url.href;
	} catch {
		return "HTTP (invalid URL)";
	}
}

/** Never retain raw Fetch errors, child stderr, token responses or credential loader diagnostics. */
export function safeMcpErrorMessage(error: unknown): string {
	if (error instanceof Error && error.name === "McpCredentialPersistenceError")
		return "MCP_LITERAL_CREDENTIAL_REFUSED: Cannot write literal MCP credentials to a non-private config file. Use an env-var reference or the private credential store.";
	if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
		return `MCP HTTP request failed with status ${error.status}`;
	}
	if (error instanceof Error && error.name === "AbortError") return "MCP operation cancelled";
	return "MCP operation failed; check server configuration and private logs";
}
