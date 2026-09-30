# PR #92 round 2 — checked repair evidence

**ACCEPTANCE_AUDIT: PASS — READY-FOR-RE-REVIEW ONLY**, finalized06:28Z. The parent accepted the terminal independent audit and reviewed the public text and actual images. This folder is released to the lead for the existing authorized evidence-branch publication. Named exact-head review/security/CI, landing and installation remain required; this is not an installed-release claim.

Repair head: `bfc93f278218534d72803f779093b2e5c875f1f1`. Reviewed baseline: `8c14be9775e59147c8f1e1c906a36b547c281fd4`.

## Inventory and exact binding

- [65 source/test hashes](source/source-hashes.json), [commit binding](source/commit-binding.json): this preparation independently matched current files and committed blobs, 65/65 each. Hash-only metadata; no source bundle.
- [3,351 dist hashes](source/dist-hashes.json), [artifact receipt](source/artifact-receipt.json): independently matched local dist files and archive hash. No raw bundle, tarball or dependencies copied.
- Frozen artifact tar SHA256: `065633d867a3e4acceaebc52522402a7e611ff409a470996123721f2d03cf392`.
- Actual compiled CLI SHA256: `8189b66abc4f9f431dbb70941dcba690d76d040de1fbfff212886be35a53639d`.
- CLI report snapshot annotation `0f3f23729ca020c5d4d61e62db1d7a446ca67fbc25ddcdab22fde7e1b8565a74` predates later Forge gate annotations `d9b80a6cf2473207daf18a79226876b3025f75bb568f647fdb6d496f00bde214`. The 65 source hashes, 3,351 dist hashes and frozen tar are unchanged; these annotation hashes are not interchangeable.

[Acceptance inventory](acceptance-inventory.json): **22 blocking IDs**, plus log hardening:

`F15`, `F16`, `F17`, `F13`, `A11`, `F18`, `F19`, `F20`, `F21`, `F22`, `F23`, `F24`, `F25`, `F26`, `Astra8`, `Astra9`, `OAUTH-R1`, `OAUTH-R2`, `R2-ASTRA-1`, `R2-ASTRA-2`, `R2-ASTRA-3`, `R2-ASTRA-4`.

MCP log hardening (`inventory-log`) is additional hardening, **not a 23rd blocker**. Refinements reuse their existing IDs. [Repair response](response-draft.redacted.md) and [independent audit](acceptance-audit.redacted.md) retain scoped before/fixed/control claims; overlapping target counts must not be summed. The response is the evidence-copy version, with relative links and without the live issue WAIT line. The lead posts the separately pinned whole-round comment.

## Exact-head Forge receipts — not rerun by this preparer

[Verification](forge/verification.redacted.json): producer ran clean `npm ci --ignore-scripts`, `npm run check`, `npm run build:offline`, isolated `./test.sh`, and `npm run check:package-install`, 05:59:24–06:01:30Z. Every phase exited **0**. Product source diffs were both empty in the producer receipt.

- [Full ci log](forge/ci.log): exit 0, with retained engine/deprecation warnings; not a warning-free claim.
- [Full check log](forge/check.log): 1,796 files, no fixes.
- [Full build log](forge/build.log).
- [Full raw-format test log, path-redacted](forge/tests.redacted.log): ANSI and all original lines retained except path substitution; **not byte-identical raw evidence**.
- [Readable producer test log, path-redacted](forge/tests-readable.redacted.txt).
- [Full ANSI-stripped test derivative](forge/tests-full-ansi-stripped.redacted.txt): every dot/diagnostic retained; separate derivative, not raw bytes.
- [Full consumer log, path-redacted](forge/consumer.redacted.log): actual packed SDK and bundled/unbundled CLI smoke.

**7,411 Vitest PASS / 912 intentional SKIP; 25 script PASS; 1,182 TUI dot-reporter passes**, tests phase exit 0. Original raw log hashes remain in verification and [provenance](provenance.json); copied-byte hashes are separate. No raw log hash is claimed to match a modified copy.

[Common-observer Astra report](reviews/common-observer-astra.redacted.md): **PASS — THIS GROUP ONLY**, bound to loop/test hashes now matching the repair head. Review read source, hashes and retained receipts; no reviewer test rerun or whole-round clearance. Before 4 native-first failures / 4 inverse controls / 24 filtered; fixed 32 owned passes, 84 Agent passes, 4 selected F1 passes / 5 filtered, 2 synchronous probes. These receipts overlap.

## Released actual CLI evidence — FAKE fixtures only

[Release report](cli/capture-release.redacted.md), [video](cli/proof.webm), [contact sheet](cli/contactsheet.png), [final image](cli/final.png), [12 frames](cli/frames/), [transcript](cli/transcript.redacted.txt), [steps](cli/steps.jsonl), [receipt](cli/receipt.redacted.json), [replay](cli/replay.json), [26-check verification](cli/verification.json).

Native shell PTY typed 12 steps under umask `022`: fresh directories `700` and files `600`; literal-project warning; fixture-only trust setup; deliberate file mode `644`; retained-literal refusal without changing content; unchanged SHA; retained `644`; final warning. Both lists exit **1** for expected connection failure to `http://127.0.0.1:9/mcp`, **not healthy MCP service proof**. `Authorization=FAKE` is a disposable literal, not a real token. No agent/project/config input files are included.

Video, sheet, final image and frames are **unchanged released bytes/pixels**, authorized after parent review. They visibly retain disposable fixture filesystem locations; this is disclosed, not claimed as pixel redaction. This preparer read the entire transcript and actual sheet/final/all 12 images. Terminal text covers replay content; no full video decoder or replay-byte revalidation was run by this preparer. Parent producer's equality and secret checks are retained claims, not substituted fresh executions.

- Video SHA256 `9017d85fb88edb195fb19b61127c168e01a7504d326bf9d8a4066fcdb5419836`.
- Sheet SHA256 `d66158d80c142b2be7cdf315e167cdd4a9f2bf34ee98a0fcb759e33b70387571`.
- Final PNG SHA256 `53f426a89042a334e03cd1fd97fe521a4410006bfc286626824dbb7bc8d7037e`.

[Original producer evidence manifest](cli/evidence.sha256) is retained provenance. It includes hashes for files/scripts intentionally **not copied** and original hashes of now-redacted text. Do not run it as the public-folder checksum list; use `SHA256SUMS` here instead.

## Released fresh Dev1 fleet evidence

[Concise result](fleet/result.json), [redacted receipt](fleet/receipt.redacted.json), [redacted run](fleet/run.redacted.log), [semantic inspect extract](fleet/inspect.semantic.log). No raw config, credential command, session, mesh or provider/RPC payload is copied.

Producer proof: guard refusal before shell execution; `fabric_exec` returns 42; extension compaction `fromExtension=true` with configured same-endpoint fallback success; lazy resume context SHA256 `bc12627aed8362b2130fea285ff9ed3834cea88f4af245bc10132423e002fc6f`, 46,604 bytes, 511 cold entries; CodeMode registered but off by default. Source/tar/CLI identities match above. Parent verified 17 artifact/script entries and runner; this preparer independently rehashed all 12 retained artifact entries without copying raw RPC files.

This fresh prepare/run used gateway `f6929d12204b864c17b71ccd0c7a295f4f1e1641`, **not the older `26653` profile inventory**. Profile release IDs in the concise result come from fresh prepare metadata; no private profile content is published. Proof phase exit 0 is scoped execution evidence; the independently released whole-round audit accepts it for readiness, not installation.

## Historical links and remaining gates

Keep the [pinned round-1 README](https://github.com/Smarty-Pants-Inc/pi/blob/16d791613bf9a68a6fcf0c60ae12894c5a6a2f69/pr-92-round1/README.md) unchanged, **only for unchanged TTY rendering**. This preparation neither replaces its assets nor renews affected CLI/fleet proof from historical links.

- **Independent whole-round audit: PASS — READY-FOR-RE-REVIEW ONLY.** [Released report, private paths redacted](acceptance-audit.redacted.md). Original report SHA256 `ebb1ac60ba223069ee0c9b9aa7b3badc688ea92c9386069109791beea79c41b7`; the public derivative has a separate checksum in provenance and SHA256SUMS.
- This local packet is released for the lead's evidence-branch push; the whole-round PR comment must use that returned immutable evidence commit and register its live WAIT. No source or artifact bytes changed during packaging.
- Named exact-head review/security/CI, merge and installation remain separate gates; this folder makes no claim that they have passed. External annotations remain OPEN in smarty-dev#2376.

[Preparation checks](preparation-checks.json), [parent finalization checks](publication-checks.json), [original/copied-byte provenance](provenance.json), `SHA256SUMS`, and `hash-inventory.json` describe the local packet and its final reconciliation. The unchanged producer artifact receipt retains its earlier readiness:false hold; the terminal audit supersedes that readiness hold without changing bytes. Automated pattern scanning is a backstop, not a guarantee or independent acceptance. Original CLI pixels/video are unchanged; raw fleet RPC, private profiles and upstream-origin inventories are excluded.
