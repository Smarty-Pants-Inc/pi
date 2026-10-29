# Native maintenance validation

These are local component/process checks, not whole-host recovery qualification.
The production default B2/B4/B5 host composition remains unresolved in the Fabric
continuation; the cross-repository lifecycle fixture is not a production host.

## Build the candidate before CLI tests

From the repository root, run `npm run build:offline`. This uses checked-in model
data, builds the workspace dependencies and invokes coding-agent's own `build`
script (`build:unbundled`, asset copy, then `build-coding-agent-bundle.mjs`). It does
not fetch a model catalog or require provider credentials. Do not fabricate a
`dist/cli.js` or exclude the built-CLI tests when the build output is absent.

Then, from `packages/coding-agent`, run the bounded recovery/compaction regression
selection, including `test/session-recovery-lifecycle.test.ts`,
`test/session-recovery-control.test.ts`, `test/session-recovery-entrypoints.test.ts`,
`test/session-manager-recovery-append.test.ts` and the affected session-manager,
interactive compaction/tree and model-switch suites. Do not select the full suite:
provider e2e tests remain credential-gated.

For the real B5/B6 lifecycle component boundary, set `B3_B5_SOURCE` to the pinned
B5 source root and `B3_FABRIC_SOURCE` to this candidate's Fabric source root. The
fixture explicitly skips real-owner cases when those roots are absent. The SDK
reopen path is now the actual `createAgentSession`; no copied SDK or expected-red
marker is needed. Its native file must remain byte-identical during construction
until retained maintenance records have been authenticated by startup.

The continuation's unfiltered selection passed 558 tests with 16 explicit skips:
15 provider-key-gated e2e tests and the existing deployed-owned-addon/physical
power-off qualification placeholder. Both built-CLI cases executed and passed:
`SIGKILL at first-delta reloads only committed history` and
`SIGKILL at before-delta reloads only committed history`. Neither is a substitute
for an ACTIVE maintenance crash, receiver reboot, physical exclusion or cohort
recovery within 120 seconds.

## Open-input repair is still blocked

The added active-input regression uses a deliberately non-cooperative original
provider. `/compact` reserves and interrupts, but does not call repair or start a
summary until the original promise actually joins. Its late native assistant
entry is retained with the original input authority and exact B6 bytes. The
logical input has a lifecycle-interrupt outcome, not a fabricated settlement or
user cancellation.

That run exposes a concrete composition conflict with read-only B5 pin
`6993174850bfd1460f2d3be2ca3f40376c63d1c5`: native passes the post-join leaf to
`repairMaintenance` and requires the returned `executionBranchEntryId` to equal
that leaf. B5 `recordRecoveryRepair` instead requires the immutable original
`delivery.executionBranchEntryId`; B5 maintenance admission also requires its
`baseLeafId` to equal the repair reference. A late assistant/result append makes
those IDs different. The regression asserts that difference on real JSONL and
B5 history. It does not rewrite the original delivery commitment, rewind the
branch or invent an original-generation receipt to bypass the conflict.

Thus the positive active-input repair, actual automatic-failure retry and its
cross-process original-input retry-slot qualification remain missing. Resolving
the anchor/leaf contract and supplying genuine B4 repair/cut/terminal ports are
caller dependencies; a passing negative refusal test is not that qualification.
