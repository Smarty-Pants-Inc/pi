## Whole-round repair — `bfc93f278218534d72803f779093b2e5c875f1f1`

**READY FOR RE-REVIEW.** Independent acceptance passed for this exact source and artifact. Named review/security, CI, landing and installation remain required.

I agree with the Astra and named security findings on `8c14be9775e59147c8f1e1c906a36b547c281fd4`. This single repair commit closes the **22 blocking IDs plus MCP log hardening**, while retaining all 146 fork commits, the previous 26 repairs, MAX50/LRU compaction and lazy-tail resume. The delayed [named security report](https://github.com/Smarty-Pants-Inc/pi/pull/92#issuecomment-5904824438) repeats F16/F17/F21/F23 and log hardening; it is not a new-head pass.

fits: retain upstream v0.99.1 and the fork's supported CLI/SDK paths, then repair the actual failures without changing legacy extension scheduling. Paul and the install owner need a secure working runtime, not a green build alone.

### Repairs and countercases

The [evidence index](README.md) contains the detailed remediation ledger, commands, source bindings and receipts. Counts below are scoped and overlap; they are not summed.

| IDs | Repair and the behavior retained |
|---|---|
| F15 | Watched-generation merge/deletion/array comparisons use own data only. Reserved keys, edits, array changes and settlement still work. Actual prototype mutation reproduced before repair. |
| F16, F17, log hardening | Under umask022, new spill/log/config directories are0700 and files0600; fresh files are exclusive. Existing managed permissions stay unchanged. Unsafe retained literal credentials are refused, project literals warn without values, and whole references/ordinary headers/removal controls remain. Mixed Cookie/clientSecret templates are classified by field. |
| A11, F18 | Explicit effect tools use shared/exclusive admission; orchestration parents do not take a parallel shared ticket. Native results/idle/abort join accepted children and completion hooks; retired contexts refuse admission. Both cousin arrival orders, ancestor reentry, real atomic writes and unawaited-child controls pass. |
| F19, F24 | Host store quotas validate snapshots and effective completion writes outside the guest. Callback-local close requests retirement without self-joining; external close still drains effects/hooks. Exact limits, replacements/deletions and arbitrary own keys remain. |
| F13 | Synchronous registry mutation invalidates the exact lifetime before asynchronous observers. Construction, publication and captured calls are fenced; shutdown joins pending owners. Identical-config replacement, healthy replacement and unrelated servers pass. |
| F20, F23, F26 | Duplicate active IDs cannot replace controllers. Catalogues cap100 pages/10,000 items/16MiB serialized UTF-8 results before retention, with a nonrenewable60s whole-call deadline. All close callers join one retirement/DELETE. Distinct IDs, bounded paging and native descendant controls remain. |
| F21, F22, F25 | OAuth bodies cap1MiB and diagnostics4096 bytes; header/body discovery chains have cancellable15s network deadlines, not human-wait deadlines. Attempt/grant revisions fence stale save/invalidation; callback close retires spare sockets and joins shutdown. Four separate-process stale refresh/browser races preserve the newer usable grant and its next rotation. |
| Astra8, Astra9 | SDK provider→native-provider→virtual bootstrap plus offline availability precedes restoration. Explicit model refresh requires successful same-provider registration; custom/unrelated/failed cases remain. Classifier cold cancellation is caller-owned; warm cache/retry controls remain. |
| OAUTH-R1/R2 | Queued sign-in cancellation retires callbacks without abandoning later lock acquisition or cancelling the holder. First-file initialization runs inside both storage lock paths; successful-open-before-first-write corruption was reproduced and fixed. |
| R2-ASTRA-1–4 | Parallel failure drains every started native entry and accepted update; reader cancellation joins accepted I/O/process retirement before admission release; dispatch pins the admitted callable; bare wrapped calls release their own tickets while native calls retain completion-hook custody. |

The final first-cause countercase is concrete: release P/native-end then Q/update synchronously while Q/U1 stays held. Before repair, public order is P→Q but final rejection is Q. Identical new tests produced **4 native-first failures / 4 inverse controls passing**. A common original-delivery-promise observer now retains the first observed cause, including `undefined`, while every update and sibling drains. Final scoped results: **32 own, 84 Agent, 4 selected F1 and 2 synchronous-event probes pass**. Synchronous update throws retain ordinary callback normalization. Scoped Astra reports **PASS — THIS GROUP ONLY** on the committed bytes; it is not the named new-head security review.

### Compatibility contract

The additive, fork-only `executionKind?: "effect" | "orchestration"` is optional. **Absent means today's legacy writer-only admission: no new shared lease or wait.** Explicit parallel effects take shared admission; sequential effects and sequential orchestration retain exclusive subtree custody. Parallel orchestration takes no own shared ticket. Effect callbacks must not delegate to or wait for unrelated tools.

The deadlock counterexample remains allowed: legacy composite B waits for a cousin writer before its first `ctx.executeTool`; it completes. Annotated generic effect leaves are excluded in both arrival orders. Native admission begins at execute and covers completion hooks, not prepare/before-hook side effects. Unannotated custom readers retain their existing overlap behavior.

External annotations remain tracked in [smarty-dev#2376](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/2376): `inbox_add`, `inbox_resolve`, `inbox_list`, `fabric_reply`. Mixed dispatcher `fabric_exec` is **not** an effect leaf; orchestration/owned-boundary or split-effect design remains open outside this fork. No external annotation fix is claimed here.

### Exact-head checks and real proof

[Full logs and hash bindings](README.md): forge,05:59:24–06:01:30Z, Node24.18.0. Clean `npm ci --ignore-scripts`, `npm run check` (**1,796 files, no fixes**), complete `npm run build:offline`, isolated `./test.sh`, and packed `npm run check:package-install` all exit0. Tests: **7,411 Vitest passes / 912 intentional skips;25 script passes;1,182 TUI dot-reporter passes**. Actual SDK and bundled/unbundled CLI consumers pass. Both post-check/final source diffs are empty. Existing static rg/fd and an owned short TMPDIR are explicit environment prerequisites, not product workarounds.

[CLI contact sheet](cli/contactsheet.png) · [full-resolution final PNG](cli/final.png) · [WebM](cli/proof.webm) · [steps](cli/steps.jsonl)

Starting state: a fresh isolated disposable project/profile, fake literal `FAKE`, loopback port9, umask022. Twelve typed native controlling-PTY steps show add→700/600 modes→explicit fixture trust setup→redacted list warning→chmod644→refused retained-literal write→unchanged content SHA and unchanged644→final warning. The list exits1 because the fake server intentionally does not exist; this is not a healthy-server claim. Capture, verification and byte-timed replay exit0;26 scoped checks pass. Parent inspected the complete transcript and actual sheet/final/mode PNGs. The video is real terminal-byte replay, not mock terminal output.

[Dev1 fleet receipt](fleet/receipt.redacted.json): the exact dist archive SHA`065633d867a3e4acceaebc52522402a7e611ff409a470996123721f2d03cf392` was verified and extracted over a clean exact-head worktree. Current production packages/extensions loaded; one nice19 Pi at a time. Actual Fabric returned42, the real guard refused the deliberate command, better-compaction completed through its extension, and resume retained identical **46,604-byte context /511 cold entries**. Codemode remains registered but inactive by default. The fresh profile includes FabricB67 and gateway`f6929d122…`; it is not the earlier gateway snapshot.

Independent whole-round [acceptance audit](acceptance-audit.redacted.md): **ACCEPTANCE_AUDIT: PASS — READY-FOR-RE-REVIEW ONLY**, finalized06:28Z. Original private audit SHA256 `ebb1ac60ba223069ee0c9b9aa7b3badc688ea92c9386069109791beea79c41b7`; the public redacted derivative has its own hash. All65 committed source/test blobs and3,351 dist/tar-member hashes match. Public evidence is fake/redacted; private provenance and credential profiles are excluded.

Keep `hold` and `needs-security-pass`. Named exact-head `review/astra`, `review/security`, CI, merge queue, installation and installed-artifact verification remain separate gates. The install owner must preserve the schema-v2 inventory/drain/consistent-v1-backup and exact81eb324f artifact rollback boundary; code-only SQLite rollback is not data-compatible.


This comment is AI-generated by upstream-sync-0991.
