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
