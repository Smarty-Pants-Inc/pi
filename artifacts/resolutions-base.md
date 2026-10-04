# Base conflict resolutions

Scope: packages/ai, packages/agent-core, root, and docs/tests paths assigned to this lane.

| Path | Upstream intent | Fork intent | Choice and reason |
|---|---|---|---|
| .github/workflows/build-binaries.yml | Restore upstream binary build changes | Keep reviewed runner/source-policy and trusted-publishing controls | ours — fleet CI governance is fork-owned and explicitly protected in upstream-notes.md. |
| .github/workflows/ci.yml | Upstream CI/conformance workflow | Existing fork CI policy | ours — zero-hunk conflict; retain committed fork workflow for later integration review. |
| .github/workflows/npm-audit.yml | Upstream audit workflow | Fork audit policy and accepted advisory handling | ours — zero-hunk conflict; retain committed fork workflow. |
| packages/agent/src/harness/compaction/branch-summarization.ts | Remove experimental agent harness | Retain fork harness compaction | ours — zero-hunk conflict; fork harness exports are still intentional and used by this branch. |
| packages/agent/src/harness/compaction/compaction.ts | Remove experimental agent harness | Retain fork harness compaction | ours — zero-hunk conflict; preserve fork functionality pending core-lane integration. |
| packages/agent/src/harness/compaction/utils.ts | Remove experimental agent harness | Retain fork harness utilities | ours — zero-hunk conflict; preserve fork functionality pending core-lane integration. |
| packages/agent/src/index.ts | Stop exporting the experimental harness | Keep harness/session/telemetry exports | ours — the fork’s ordinary-owner/harness surface is not equivalent to upstream durable migration and must not be dropped silently. |
| packages/ai/package.json | Use standard tsc build | Preserve fork tsgo build and executable mode | ours — fork build tooling and CLI mode are intentional. |
| packages/ai/scripts/generate-models.ts | Group provider model data for JSON output | Filter explicitly omitted providers | combined — both helpers are used: upstream grouping plus fork omission policy. |
| packages/ai/test/anthropic-empty-thinking-signature-compat.test.ts | Update upstream Anthropic fixtures | Preserve fork compatibility coverage | ours — retain fork regression expectations. |
| packages/ai/test/anthropic-sse-parsing.test.ts | Update upstream catalog fixture | Preserve fork parser regression | ours — parser behavior is fork coverage and remains compatible with current models. |
| packages/ai/test/fireworks-models.test.ts | Update/remove upstream Fireworks models | Keep current catalog and fallback assertions | ours — fork model catalog policy is authoritative for this branch. |
| packages/ai/test/providers.test.ts | Update provider catalog expectations | Preserve optional-provider behavior | ours — retain fork optional provider policy. |
| packages/ai/test/supports-xhigh.test.ts | Replace removed upstream model | Preserve fork-supported model matrix | ours — retain fork catalog policy and supported-level coverage. |
| packages/ai/test/together-models.test.ts | Replace old Together model | Preserve Together K3/reasoning and endpoint regressions | ours — explicitly protected by fork notes and commits. |
| packages/ai/test/total-tokens.test.ts | Update old Together fixture | Test Together K3 accounting | ours — preserve fork K3 reasoning regression. |
| packages/coding-agent/CHANGELOG.md | Add v1.0.1 upstream release entries | Keep fork release and regression notes | combined-in-place — retain the fork changelog block while the upstream release text remains in the surrounding committed history. |
| packages/coding-agent/test/experimental-remote-runtime.test.ts | Test durable remote runtime | Preserve fork remote custody/terminal publication tests | ours — fork ordinary-owner and cancellation semantics must survive upstream durable changes. |
| packages/coding-agent/test/experimental-transcript-provider.test.ts | Test durable transcript view | Preserve fork transcript sanitization and tool_end regressions | ours — retain pi#51 and smarty-dev#890 safety coverage. |
| packages/coding-agent/test/fixtures/faux-session-worker.ts | Use durable Harness worker | Keep AgentHarness worker fixture and terminal publication gate | ours — fixture exercises fork-owned remote lifecycle behavior. |
| packages/coding-agent/test/rpc-prompt-response-semantics.test.ts | Add upstream handled/queued disposition tests | Preserve fork RPC IDs, startup, cancellation, and shutdown tests | ours — fork RPC contract is broader; core lane must integrate disposition separately. |
| packages/coding-agent/test/session-manager/file-operations.test.ts | Add temp-directory fixture coverage | Preserve fork file-operation checks | ours — no conflicting behavior required by this lane. |
| packages/coding-agent/test/suite/harness.ts | Add reusable sessionManager option | Preserve prepareRequest and persistent-session setup | combined — both options are retained and sessionManager takes precedence. |
| packages/coding-agent/test/suite/regressions/5943-session-start-notify.test.ts | Reuse shared UI context helper | Preserve explicit notification regression fixture | ours — local fixture keeps the regression self-contained. |
| packages/tui/test/terminal-image.test.ts | Add upstream Kitty/iTerm2 distortion coverage | Preserve fork Herdr/URL-link coverage | ours — retain fork terminal-link regression tests; upstream image cases remain an integration risk. |

## Choice counts

- ours: 23
- upstream: 0
- combined: 2
- zero-hunk retained ours: 5 (included in ours count above)

## Check evidence

Package check commands were attempted with `nice -n 19 npm run check` from this worktree. They stopped before typechecking because `node_modules/.bin/biome` is absent: `sh: 1: biome: not found`. No package-local type errors were produced.
