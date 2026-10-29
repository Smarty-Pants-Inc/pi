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

## Native JSONL maintenance process crash matrix

The lifecycle suite also runs four original-process loss points with real B5
admission and B6 storage: ACTIVE (provider promise not joined), native prepare
before its B5 ACK, B5 PREPARED, and checkpoint B6 commit before native receives
its durable ACK. Each case then kills a successor immediately after durable B5
adoption, reconstructs and settles in a third process, and kills/reopens that
receiver in a fourth process. No process-loss case runs cleanup in the killed
process; every stop is SIGKILL and the parent waits for actual process exit.

Receivers use `SessionManager.openForRecoveryAfterExclusion` with a test-only
witness that the predecessor PID no longer exists, and require B6 to recover its
existing binding. That witness is local process death, **not** B2 physical
exclusion or exclusive custody on another host. All receivers retain the
original request, epoch, IDs, view hash and deadline. A lost ACTIVE summary is
consumed as failed without successor provider inference. Prepared operations
finish the exact original native plan without successor provider inference.

Checks include the original native byte prefix and IDs, one prepare, exactly one
compaction for prepared success (none for ACTIVE failure), exact planned append
bytes only once, real B6 bytes and sequence receipts, and
byte-identical native history/B5 completion/B6 receipts on the final reboot.
Set `B3_TEST_ARTIFACTS` to retain per-process stdout/stderr, gate snapshots and
copies of all native JSONL/B5/B6 stores, including after assertion failure.
Windows is explicitly outside this local SIGKILL harness.

The continuation's expanded unfiltered selection passed 563 tests with the same
16 explicit skips and both built-CLI cases executed. After strengthening the
receiver guard to assert zero provider-request attempts as well as zero calls,
the four crash cases passed again (29 other lifecycle tests filtered by name,
not counted as runtime skips). Root `npm run check` also passed; its 16 existing
informational template-literal suggestions were unchanged.

This covers maintenance with no original input selected. It does not establish
a cross-process original-input retry slot, B4 repair, a physical receiver reboot,
an owned-addon deployment, whole-host power loss, cross-host transfer, complete
cohort/peak load or the 120-second fleet bar. No passing component/process count
may be relabeled as those missing proofs.

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
