# Streamed partial tool result redaction — round 2

Refs smarty-dev#13239 and smarty-dev#13219. Refs pi#264.

## Findings

- Reject malformed non-undefined `tool_partial_result` handler returns before another handler or consumer can receive the raw snapshot. `ToolPartialResultEventResult.partialResult` is optional: `undefined`, `{}`, and `{ partialResult: undefined }` remain documented no-ops; null, primitives, arrays, and invalid replacements fail closed.
- Preserve tool/turn cancellation by composing the existing agent-loop signal with session shutdown via `AbortSignal.any`; no agent API change.

## Decision C

| Test | Keep reason / why the named E2E cannot cover it now | Named E2E | Owner | Pass condition | Date |
| --- | --- | --- | --- | --- | --- |
| `packages/coding-agent/test/suite/tool-partial-result.test.ts` and runner regressions | Data safety at the extension/consumer trust boundary. In the supplied inputs E2E-8976 covers installed-guard inventory/performance, but has no real-model request / streamed partial update / session-file driver. The offline faux-provider harness covers direct and nested consumers and cancellation without credentials until that driver exists. | E2E-8976 | factory-repair | A real model request and session file stay clean of a planted secret streamed through a partial tool update. | 2026-10-17 |

## Checks

Targeted suite: `node ../../node_modules/vitest/dist/cli.js --run test/extensions-runner.test.ts test/suite/tool-partial-result.test.ts` from `packages/coding-agent`. Local execution depends on pre-existing dependencies; no installs are authorized. Exact outcomes are in the task's `tests.log`.
