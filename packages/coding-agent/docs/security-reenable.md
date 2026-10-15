# Codemode and MCP reviewed re-enable

## Codemode: re-enabled after pi#203

smarty-dev#4506 step 2 re-enables Codemode after the pi#203 internal repair, merged as `ef99dfc1`. The repaired implementation remains in the shared host/VM execution path:

- P1-3: every execution, including deterministic `start()`, has a finite host deadline (at most 30 minutes). Bridge budgets bound message and total characters, started calls, and in-flight calls; tool replies count too. Both the VM and host check the bridge. Cancelled model calls leave the limiter queue immediately.
- P1-4: spills and saved images use a process-owned output directory (0700), exclusive read-only files (0400), a shared 512 MiB bound, failed-write cleanup, and process-exit cleanup.
- P2-4: the host validates store values, deletion keys, and merged size, then coding-agent checks the current branch store immediately before appending successful writes.

The CLI again loads the replaceable `builtin:codemode` extension. It registers the tool **inactive**: activate it with `--tools codemode`, `defaultTools: ["+codemode"]`, or the session tool API. `-builtin:codemode`, `noExtensions`, and normal tool allow/exclude policies still apply. Explicit `-e builtin:codemode`, the SDK `createCodemodeExtension()` factory, the standalone worker/inline/remote sandboxes, and the Cloudflare entry share the restored admission.

Scripts run inside QuickJS, not Node. Their injected tools still execute with Pi's operating-system permissions and pass through the normal nested-tool policy; enabling Codemode does not grant new native tool permissions or enable MCP. See [Codemode](codemode.md) and [Run Pi safely](security.md).

The restored offline suites exercise the real sandbox and the faux-provider session harness, not a mocked admission or VM. Release still requires the `needs-security-pass` gate and an installed-session real-model check; an offline test is not that release evidence.

## MCP: still refused

The PR #131 cutoff remains for MCP. This is not a settings default that old configuration or an environment variable can bypass. The following requests remain **refused**:

- Global or trusted-project `extensions: ["+builtin:mcp"]` and CLI `-e builtin:mcp`.
- SDK `createMcpExtension()` factory activation.
- Standalone `pi mcp` commands, existing `mcp.json`, configuration reads/writes, and extension `registerMcpServer` / `unregisterMcpServer` mutations.
- Standalone MCP clients, stdio/HTTP transports, OAuth providers, callback servers, discovery, authorization, registration, exchange, refresh, and auth adaptation.

The diagnostic remains `MCP_SECURITY_REVIEW_REQUIRED`. No runtime opt-in is accepted. Do not edit local settings, add a secret loader, or import an internal module as a workaround.

### Scoped MCP follow-up

MCP has separate dormant client, stdio/HTTP transport, OAuth, configuration/registry, extension/session, and CLI paths. pi#203 repaired Codemode, not those paths. Later MCP repairs include OAuth HTTPS/redirect/issuer/endpoint-origin validation (pi#173, pi#178), OAuth lifecycle follow-ups (pi#184), and HTTP redirect credential handling (pi#244); these do not by themselves establish that every deferred boundary is ready.

Before re-enabling MCP, complete a separate boundary review and real-path offline test restoration across all retained entry points. In particular, bound HTTP JSON and error-body reads before buffering them (`transports/streamable-http.ts`), bound OAuth metadata/registration/token-response reads (`oauth/discovery.ts`, `oauth/flow.ts`), and enforce a finite host-owned request ceiling (`client.ts` currently lets non-finite or non-positive timeouts omit the timer). Keep client/transport, OAuth, CLI/registry mutation, cancellation, and session suites in that scope. Do not remove the MCP refusal piecemeal.

Project trust and tool allow/exclude policy are additional boundaries, not replacements for security admission. AI OAuth, native tool dispatch, Durable storage/tasks, and RPC shutdown remain independent supported features.
