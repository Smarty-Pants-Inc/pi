# Round 2 MCP CLI final capture — actual execution complete; RELEASE

Exclusive ownership of `.local/mcp-cli-proof/run.L0ANVSmM/**` is RELEASED. No waiter or capture/renderer child remains from this execution. Prepared scripts were reused without modification, reinstall, source change, or build. No Git mutation, fleet mesh, agents, real credentials, paid provider, external network, GitHub, or publication was used.

This is a successful scoped capture and local verification, NOT whole-round readiness, a full check, independent acceptance, or security clearance. Parent exact-head Forge verification was PENDING in the notification; this task does not establish its later state. Parent/independent auditor must read the actual images before any acceptance PASS.

## Exact identity and artifact guard

- cwd: `<SOURCE_ROOT>`
- origin: `https://github.com/Smarty-Pants-Inc/pi.git`
- HEAD: `bfc93f278218534d72803f779093b2e5c875f1f1`
- Parent and proof-root notifications match: FINAL_ARTIFACT_READY; proof execution released, readiness false.
- Artifact tar SHA256: `065633d867a3e4acceaebc52522402a7e611ff409a470996123721f2d03cf392`
- Full snapshot was parsed/read mechanically; all 65 source and 3351 dist entries were independently hashed before and after capture. All matched. Manifest SHA256: `0f3f23729ca020c5d4d61e62db1d7a446ca67fbc25ddcdab22fde7e1b8565a74`.
- Actual compiled CLI: `packages/coding-agent/dist/cli.js`, SHA256 `8189b66abc4f9f431dbb70941dcba690d76d040de1fbfff212886be35a53639d`.
- CLI/config source and compiled identities are recorded in `artifacts/receipt.json`; their post-capture checks pass.
- Reused pinned Playwright 1.63.0, xterm 5.5.0, pngjs 7.0.0; actual renderer Chromium 153.0.8010.12.

## Starting state and fixture boundary

Fresh isolated HOME, agent profile, project cwd, and TMPDIR inside the proof root; agent directory and project `.pi` absent before capture. No real user profile was consulted. The shell is a native `/usr/bin/bash --noprofile --norc -i` controlling PTY, 132 columns by 42 rows. The private `pi` wrapper executes the actual compiled CLI with `/usr/local/bin/node`. Commands are typed character-by-character through the PTY, not direct MCP facade calls.

Exactly as authorized: a disposable fake-only project. Global and project MCP entries contain the literal string `FAKE` and only URL `http://127.0.0.1:9/mcp`. At step 5, the user-typed fixture script trusts this disposable project and writes empty auth/settings and empty packages/extensions directories. This fixture trust setup is not represented as an interactive trust flow. Before that step the add output explicitly reports that the project is not trusted. No healthy MCP server is claimed: both list commands show `fetch failed` for both fake entries and exit 1.

## Actual ordered commands and exits

The shell appends `rc=$?; printf '\nEXIT_CODE=%s\n' "$rc"` to each typed command. Full commands, output offsets, and native timing are in `artifacts/steps.jsonl` and `artifacts/receipt.json`.

| Step | Typed command | Exit |
|---|---|---:|
| 1 | `umask 022` | 0 |
| 2 | `pi mcp add fake-global --url http://127.0.0.1:9/mcp --header Authorization=FAKE` | 0 |
| 3 | `pi mcp add -l fake-private --url http://127.0.0.1:9/mcp --header Authorization=FAKE` | 0 |
| 4 | `stat -c '%a %n' ../agent ../agent/mcp.json .pi .pi/mcp.json` | 0 |
| 5 | `python3 ../setup-profile.py` | 0 |
| 6 | `pi mcp list` | 1, expected loopback connection failure |
| 7 | `sha256sum .pi/mcp.json \| tee ../artifacts/original-content.sha256` | 0 |
| 8 | `chmod 644 .pi/mcp.json; stat -c '%a %n' .pi/mcp.json` | 0 |
| 9 | `pi mcp add -l fake-second --url http://127.0.0.1:9/mcp` | 1, expected retained-literal refusal |
| 10 | `sha256sum -c ../artifacts/original-content.sha256; sha256sum .pi/mcp.json` | 0 |
| 11 | `stat -c '%a %n' .pi/mcp.json` | 0 |
| 12 | `pi mcp list` | 1, expected loopback connection failure |

Observed initial modes: agent and project `.pi` directories 700, MCP files 600. Refusal identifies `fake-private` and `headers.Authorization` without printing the value. No fake-second entry was added. File remains deliberately mode 644. Original and final project-content SHA256 both `8aae90339aa5256b5d927e970a5c9cadd7c5144ad83eb6a1208c159e0faea2c3`.

## Executed proof commands and logs

All commands executed nice19 with finite 300-second deadlines. Each log is complete, with a sibling `.exit` file. All five commands exit 0; native shell exit 0; capture 12 steps, 3909 raw bytes, 22.844 seconds.

From the proof root:

1. `nice -n 19 timeout 300s python3 guard.py` — `artifacts/guard.log`, `artifacts/guard.exit`.
2. `nice -n 19 timeout --kill-after=10s 300s python3 capture.py` — `artifacts/capture.log`, `artifacts/capture.exit`.
3. `nice -n 19 timeout --kill-after=10s 300s python3 verify.py` — `artifacts/verify.log`, `artifacts/verify.exit`; 26/26 scoped checks pass.
4. `HOME="$PWD/renderer-home" TMPDIR="$PWD/tmp" PLAYWRIGHT_BROWSERS_PATH="$PWD/browsers" nice -n 19 timeout --kill-after=10s 300s node render.mjs` — `artifacts/render.log`, `artifacts/render.exit`.
5. `nice -n 19 timeout 300s python3 finalize.py` — `artifacts/finalize.log`, `artifacts/finalize.exit`; full source/dist post-check, raw chunk equality, final done trace, warning/failure and secret-pattern scans pass.
6. `sha256sum -c artifacts/evidence.sha256` — exit 0, all 43 entries OK.

`guard.py` and `finalize.py` are new proof-only checks in the exclusively assigned root. No product code was edited, so no new product check/build/test was run.

## Actual image and transcript inspection

I read the actual `artifacts/contactsheet.png` and `artifacts/final.png` with the image read tool, and read the entire `artifacts/transcript.txt`. The final PNG visibly shows the unsafe-mode refusal, unchanged SHA confirmation, mode 644, retained redacted warning, and both loopback fetch failures. The contact sheet uses unmodified terminal screenshots for steps 2/3/4/6/8/9/10/12 in that order (row-major, two columns).

The WebM records xterm replay of the actual PTY byte chunks and their timings; idle gaps are capped at one second. No mock browser terminal content, product change, content overlay, or substituted CLI output is used. Full replay chunk bytes equal `terminal.raw` mechanically. Transcript inspection covers all replay text, not merely contact-sheet samples. Secret-pattern scan reports zero matches; FAKE appears only in the two typed commands, never CLI output. These are known disposable fake values, not redacted live credentials. This is a terminal replay proof, not a live browser UI/network proof or fleet-session proof.

## Evidence for parent and independent auditor

Base: `<FAKE_PROOF_ROOT>/artifacts/`

- Video: `proof.webm`
- Final actual PNG: `final.png`
- Actual sheet, steps 2/3/4/6/8/9/10/12: `contactsheet.png`
- Full-resolution step frames: `frames/01.png` through `frames/12.png`
- Full transcript: `transcript.txt`; raw input/output: `terminal.raw`
- Byte/timing evidence: `chunks.json`; ordered commands/exits: `steps.jsonl`
- CLI/source identity and environment: `receipt.json`
- Replay/browser identity: `replay.json`
- Scoped results: `verification.json`, `redaction-scan.json`, `guard.json`
- All proof files/frames/scripts hashes: `evidence.sha256`

### SHA256

| Actual artifact | SHA256 |
|---|---|
| proof.webm | `9017d85fb88edb195fb19b61127c168e01a7504d326bf9d8a4066fcdb5419836` |
| contactsheet.png | `d66158d80c142b2be7cdf315e167cdd4a9f2bf34ee98a0fcb759e33b70387571` |
| final.png | `53f426a89042a334e03cd1fd97fe521a4410006bfc286626824dbb7bc8d7037e` |
| transcript.txt | `9c88ba5ad64725a92e37dc710d586917c4e828171c006d47b8cd0dddc757955a` |
| chunks.json | `5d7aa4234870fa6fefc30d74341044a9e9f9710c73d1236eaca0d72a71704492` |
| steps.jsonl | `a257b3807ed41b804d4152140a63dea6e4494f9c6d4b25b892176af623ed0a64` |
| receipt.json | `80fdf843f6abba1b21e5f777290e9e163bbeecaca0019127e06a4d759258b172` |
| replay.json | `58f2135d8703c54afdb7e814d80b7c5f04f3233743a85b3f1b40aa54b07ff73d` |
| evidence.sha256 | `9231d181fd65d678bc2b4903bb3ffd0f83bc8812d11fe7c7017b130398368205` |

RELEASE: actual capture completed inside the 20-minute box; no pending task launched, no source/build/install ownership retained. Parent owns readiness/fullcheck/security gates and independent image acceptance.
