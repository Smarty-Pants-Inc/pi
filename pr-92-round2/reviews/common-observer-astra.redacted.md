# R1b-C1 common-observer final adversarial recheck

## Verdict and scope

**PASS — THIS GROUP ONLY.** The prior adjacent native-end-first countercase is repaired at the common delivery-promise failure-observation boundary. No remaining source-derived concrete finding was identified in this group. This is not a guarantee about unknowable hidden promise-creation/rejection timestamps, detached work, or native preparation ownership.

Reviewer: `gpt-6-astra`, `xhigh`, confirmed from `PI_MODEL` / `PI_REASONING_LEVEL`. First timestamped guard: **2026-09-30 05:42:50 UTC**; post-write guard and manifest recheck: **05:48:24 UTC**, within the 12-minute bound. Only this report was written. No source/test writes, Git mutation, GH/network/credential/provider operations, spawning, tests, check or build were performed. Executed checks were read-only source/diff/hash inspections; test/probe outcomes below are retained receipts, not reviewer reruns.

- Root: `<SOURCE_ROOT>`.
- Origin: `https://github.com/Smarty-Pants-Inc/pi.git`.
- HEAD remained `d07351589d30bfc28ac973db8de6da41e0d0d3ae` through the post-write guard inspection.
- The released loop/test are the two working-tree changes relative to that HEAD. They are **not** the old loop/test blobs in `d073515`.
- A later parent-only two-path commit may carry this review only if its blobs match the release hashes below. No unseen HEAD advancement is presumed verified.

## Exact release and before/fixed binding

| Path | RELEASE SHA-256 |
| --- | --- |
| `packages/agent/src/agent-loop.ts` | `5acd01b7e3a069e3ce57cb6acf98f50c5c8d40c3005b30aca77319b8b18fddd2` |
| `packages/coding-agent/test/suite/security-round2-native-failure-join.test.ts` | `7e7c43208a5ccdc80de57b225308eed5c8c745012f3e2ec98a2e7e94270bd5a1` |

Independently verified the release manifest **13/13** and baseline manifest **3/3**, including fresh terminal receipts. `cmp` returned 0 for current loop versus `snapshot/fixed-agent-loop.ts` and current test versus `snapshot/repro-test.ts`. The before/fixed reproduction therefore has identical retained test bytes. Package Vitest aliases resolve agent-core to `packages/agent/src/index.ts`, which exports `agent-loop.ts`; the direct probe's source resolver reads the root TypeScript paths and likewise selects source, not stale dist.

The saved baseline loop hashes to `94345de95c0a55bd4b5a2b5ac3a647878d717b8c1674b57ee6c3cd072219bb6b`; the original 24-case test hashes to `5e2c5fcff736d14fbf1b79abfc2bb2d550623c25f8382972d0b0a85f4875403a`. Both independently match their `d073515` blobs. Diff inspection confirms the new test adds the P-end gate and eight adjacent cases without removing historical assertions. Source changes are private common-observer plumbing and removal of the now-redundant private execution recorder parameter.

Manifest paths are under `.local/`:

- `round2-common-event-first-cause-files.sha256`: `10cee2d6b9f884c342e5162374bb66bc3c549a6e9725717ee20320876fa3a255`.
- `round2-common-event-first-cause-baseline.sha256`: `97d2f00d59a173dc39d7fe816f7a15d6e8fde49cf5c6fcf3a57b9300e1fa48e9`.

## Actual receiver/bootstrap attribution

1. `test/suite/harness.ts:149-249` creates the faux-backed Agent, loads inline factories through `test/utilities.ts:198-249`, and constructs the real AgentSession. `extensions/loader.ts:301-334,625-646,776-785` registers the handlers/tools and initializes those exact factories. No mocked replacement event dispatcher is involved.
2. `agent-session.ts:577-589,4274-4454` installs `_handleAgentEvent`, builds the ExtensionRunner, scopes the registered definitions and wraps them with real tool contexts. The native request projection (`883-925`) adds completion ownership. `nested-tool-calls.ts:305-349,414-489` reserves accepted children before awaiting, drains them before the parent returns, and retains the child through public after-hook/end completion. The fixture's gated write calls the actual `writeFileAtomic`, not a simulated state change.
3. Native loop delivery calls the Agent's original `processEvents` promise (`agent.ts:514-521,649-708`). Agent awaits its session receiver in subscription order. Session awaits `_emitExtensionEvent` and only then calls synchronous public listeners (`agent-session.ts:1179-1196,1265-1312,1532-1551`). ExtensionRunner awaits each registered handler (`extensions/runner.ts:1092-1128`).
4. The gates are awaited extension handlers; the injected failures are **public session listener throws**, after those gates. Runner normally catches extension-handler errors, so this report does not misattribute those throws to the gate handlers. A public listener throw rejects `_handleAgentEvent`, then the awaited `processEvents` delivery promise returned to the loop. That original delivery promise is what the new common observer receives.

## Discriminating sequence and inverse controls

The eight new cases (`security-round2-native-failure-join.test.ts:495-614`) hold Q/U1 and Q/U2, release Q's callback into its accepted-update drain, and finish P's actual atomic write and child public after-hook. P/native-end is then held in an awaited extension handler. Both failure receivers have entered before either gate is released.

At `566-577`, the test releases P-end then Q/U2 **in one synchronous continuation with no yield between releases**, and asserts the actual public sequence `[P, U2]`. U1 remains held. The inverse control releases Q/U2 then P-end and asserts `[U2, P]`. Each direction covers Error/undefined first and `[P,Q]`/`[Q,P]` assistant source order.

- **Before:** native-end failure went through helper/entry unwinding before the shared recorder; the update observer could record Q first. The retained run fails all four native-first cases only at final cause (`600`), after public-order, real-write/hook, pending prompt/idle/controller, held-U1 and joined-terminal assertions. All four inverse controls pass.
- **Fixed:** `agent-loop.ts:646-658` synchronously invokes the original sink, then directly observes its returned delivery promise with the same rejection handler for both event kinds. P's common observer records P before any native helper/entry unwind; Q cannot replace it. Reversing common observation order retains Q instead. `pipelineFailure ??= { error }` and `728` preserve an actual `undefined` cause, rather than treating it as an unset sentinel.
- **Custody:** each update still has a non-rejecting local join (`932-936`); execution closes update admission (`943`) and awaits every accepted delivery (`946`) before propagating failure. The started-entry fallback observer remains (`714-719`), and batch failure still awaits all started entries (`727`) before throwing the retained cause. U1 must finish before run retirement in either order.

This selects the first failure **observed at the common sink boundary**. It does not infer order from when a receiver privately created a promise. A synchronous non-update sink throw is recorded immediately when observed; a pending asynchronous rejection is not retroactively earlier merely because hidden work failed first.

## Acceptance ledger

| Required behavior | Review result / discriminating evidence |
| --- | --- |
| Error/undefined first, both arrival and source orders | **PASS.** Eight adjacent cases; original separated-arrival controls retained. Common sink observer precedes unequal downstream unwind depths. |
| Accepted updates and every started sibling join | **PASS.** Both joins and fallback remain. Held-U1 cases assert pending prompt, Agent idle wait, session idle wait, controller custody and zero terminal events before release; then one terminal pair and no post-terminal tool events. |
| Ordinary callback errors / after-hook policy | **PASS.** Execution catch retains callback error, joins accepted updates, then normalizes; successful/ordinary-error paths still finalize and invoke after-hook. Async update-pipeline failure drains then skips that tool's after-hook. P/Q callback controls retain children and source-ordered result messages. |
| Synchronous update sink versus other synchronous events | **PASS.** `651` excludes only synchronous update throws from the batch latch and rethrows synchronously into normal callback handling. Other synchronous event throws latch. The two saved low-level probes normalize P's synchronous update error and run P's after-hook, then retain P's Error/undefined native-end failure despite a later asynchronous Q update failure. Q's held delivery must finish first. This distinguishes low-level synchronous sink throws from public Session throws inside its asynchronous receiver. |
| Source-order results / sequential behavior / direct `runToolCall` | **PASS.** Ordered `Promise.all` results still drive result publication (`730-735`). Sequential path is unchanged and does not install the wrapper; configuration/descriptor controls refuse the suffix after sink failure, while callback errors still drain and continue. Direct calls also bypass the wrapper; Error/undefined async cases retain their local cause after joining, and synchronous sink/callback controls assert `update-done → normalize → after`. |
| Controller, idle waits and abort | **PASS for this group.** Agent holds the active run through executor/failure handling (`585-639`); Session awaits dispatch before settlement (`2032-2131`). Abort reaches the original Agent and awaits session idle (`2961-2978`). Retained write/hook and U1 abort controls pass; repair adds no abort race or early cleanup. |
| Public symbols, registrations, configuration | **UNCHANGED.** Mechanically confirmed `AgentEventSink`, `ToolCallHooks`, `RunToolCallOptions`, `runToolCall`, private `ToolUpdateSink`, Agent listener/update callback signatures and wildcard loop export. `emitBatchEvent` covers parallel starts, immediate/aborted/normal ends, updates and result-message delivery. No new public registration/configuration entry is required. |

## Fresh retained receipts

All paths below start `.local/round2-common-event-first-cause-`; each receipt was read in full and passed its release-manifest hash check.

| Receipt | Terminal evidence |
| --- | --- |
| `before.log` | 05:32:38; EXIT=1; **4 native-first FAIL / 4 inverse PASS / 24 filtered**. Only final-cause mismatches: Q instead of P or `undefined`. |
| `own-final.log` | 05:38:15; EXIT=0; **32/32 PASS**, 3.45s. |
| `agent-final.log` | 05:38:15; EXIT=0; **84/84 PASS**, three files, 1.02s. Named targets: agent-loop, Agent, lifecycle observer. |
| `f1-final.log` | 05:38:15; EXIT=0; **4 PASS / 5 filtered**, 3.09s. Public Agent hook direct/Codemode controls, not the entire nine-case file. |
| `probe.log` | EXIT=0; **two synchronous-event probes PASS**, Error and undefined retained. Saved probe source was fully read. |
| `biome-final.log` | EXIT=0; two files checked, no fixes. |

**No adjacent-target timeout blocker remains.** Old partial/timeout receipts from the prior review are not substituted for these final receipts, nor are these counts presented as a full suite.

## Supporting source hashes

Full current loop/test, saved baseline loop/original test, both requested reports, Agent/types/export, all 5,213 Session lines, nested runner, extension loader/runner/wrappers, harness/utilities, write/atomic-write/mutation queue, F1 test and source-resolution configuration were read. Core receiver/custody hashes:

| Path | SHA-256 |
| --- | --- |
| `packages/agent/src/agent.ts` | `84a3a344e95541d92e1c677bd0c586365897aff2be8cd8ea4797af903224d590` |
| `packages/agent/src/types.ts` | `fda3e11616a31e710c6d47f463e2a58bf9321d68fe44436b403f9956a2f31f8e` |
| `packages/agent/src/index.ts` | `452df9eeee4bec0cf0fcfee3864e09465a818ab4edc175e4d07c7081a2b8b6cd` |
| `packages/coding-agent/src/core/agent-session.ts` | `d47f12b8cf8b67cdc0096217bfa10c5d185c083b6ec3375a0e6fa23bed0bbe09` |
| `packages/coding-agent/src/core/nested-tool-calls.ts` | `d5b7bfc88b227399422a03c37f5c4b00933c10928b4aa5672590f74aa624ba90` |
| `packages/coding-agent/src/core/extensions/loader.ts` | `8ef4f0deb62e31e1c25a2a446154892573b3d65d7f14154d31b495ea28de9dc7` |
| `packages/coding-agent/src/core/extensions/runner.ts` | `4821366ecdffdc497371bc8c9d9d7856c4522b66af1261a4b5f1f460292f9be9` |
| `packages/coding-agent/src/core/extensions/wrapper.ts` | `7783d9e41dcb99fd10ebdd4e3d7aa4cef84fcf387f42be95265a5b7f6dcee14b` |
| `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` | `177cc7fb378c26497ac5dc24cded4266019c1860fdf6f18b528c8bd36e67b3ac` |
| `packages/coding-agent/test/suite/harness.ts` | `a4ae62f420ea3bfad94b08e4abbe24cd9baf18844f574714cff1e6d7511a7afc` |

**Closure boundary:** R1b-C1 only is clear on the exact release bytes. No same-source full suite has been established by this review. The user-reported historical `d073515` 7,403 PASS is not clearance for the new loop. Parent root verification, the hash-matching appended commit, remote Forge full/consumer verification, and later UI/fleet checks remain separate and uncleared here.
