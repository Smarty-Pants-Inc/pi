# Staged Pi 1cd7a76a pre-activation check (host Pi vs net-lead temp gateways): FAIL, incomplete

Binary: staged release 1cd7a76af2cd…/node/node_modules/@earendil-works/pi-coding-agent/dist/cli.js, exec'd via its
`#!/usr/bin/env node` shebang (same as ~/.local/bin/pi, a bare symlink to the active release's cli.js). Not activated.

- A plain (test-org-3, :18405), print: PASS. 1 request (429 limit/too_large), message shown verbatim, exit 1, no retry, 0 more lines in 20 s.
- A plain, TUI: behaviour PASS (error once, no countdown, no retry, nothing more in 22 s); usage line lost because the gateway dir was deleted mid-run.
- B throttled (test-org-2, :18403), print: NOT EXERCISED. Primer admitted (200, but body = upstream Nvidia 503 overloaded);
  Pi's request was refused limit/period throttled:false (not throttled), and Pi correctly showed it once, no retry.
  A follow-up curl at 01:18:32Z got the same period refusal, retry-after 2586494 (resets 2026-10-28T23:46:46Z).
- B throttled, TUI: NOT RUN. Both gateways were torn down around 01:19:35Z (/tmp/tmp.YUsWcNlPbo removed, ports closed).
