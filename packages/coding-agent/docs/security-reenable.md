# Codemode and MCP reviewed re-enable

This fork temporarily refuses all supported Codemode and MCP execution and mutation admissions. This is not a settings default that old configuration or an environment variable can bypass.

The following explicit opt-in requests remain **refused** until a reviewed re-enable changes the admission policy:

- Global or trusted-project `extensions: ["+builtin:codemode", "+builtin:mcp"]`.
- CLI `-e builtin:codemode` or `-e builtin:mcp`.
- SDK `createCodemodeExtension()` or `createMcpExtension()` factory activation.
- Standalone `pi mcp` commands, existing `mcp.json`, and extension `registerMcpServer` / `unregisterMcpServer` mutations.
- Standalone `CodemodeSandbox` construction and the separately exported worker entry.
- Standalone MCP clients, stdio/HTTP transports, OAuth providers, callback servers, discovery, authorization, registration, exchange, refresh and auth adaptation.

Refusal diagnostics are `CODEMODE_SECURITY_REVIEW_REQUIRED` and `MCP_SECURITY_REVIEW_REQUIRED`. No runtime opt-in is currently accepted. Do not edit local settings, add a secret loader, or import an internal module as a workaround.

A later re-enable PR must repair and review the deferred boundaries before making an explicit opt-in effective. Re-enable must cover the CLI, SDK, package exports, worker and retained extension APIs together. Project trust and tool allow/exclude policy are additional boundaries, not replacements for this security admission.

AI OAuth, native tool dispatch, Durable storage/tasks and RPC shutdown remain independent supported features. Disabling Codemode/MCP does not repair or accept risks in those core paths.
