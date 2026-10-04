# Real CLI/TUI boundary recording (pi#137 round 3)

Run from `packages/coding-agent`, at low priority:

```sh
nice -n 19 node ../../node_modules/vitest/dist/cli.js --run test/real-entry-boundaries.test.ts
```

Prerequisites: Linux, Python 3, libX11, Xvfb, tmux and the repository's shipped Linux native clipboard helper. Missing terminal utilities skip this native test; that is not a proof result.

The test starts the actual source CLI (`src/experimental/cli.ts` with the source resolver), not an SDK session or mocked TUI. The environment contains no model credentials, uses an isolated home/work directory, and disables extension/skill discovery, telemetry and local models. Only the checked test extension is loaded. No provider request is made.

The X11 fixture owns a real clipboard selection containing a PNG and a file URI. The existing Linux helper reads the PNG through X11. The CLI receives Ctrl+V through tmux, inserts the image path into ordinary text, then into `!ls ` with a temporary directory containing spaces, `$()` and a single quote. Submitting must show the successful `ls` output and must not create the injection marker. This fails against the round-3 base with Bash's unmatched-quote error and exit 2 (A17).

For A15's fullscreen starting state, `/proof-image` installs a component with an unregistered Kitty image placement (`r=9007199254740991`) and a row above it. `/proof-redraw` changes only that preceding row. The actual fullscreen renderer must redraw promptly. The fixture checks both the displayed changed row and the raw image/render bytes.

When `TASK_OUT` is set, `real-entry-boundaries/` retains raw `.ansi` streams, pane captures and `steps.json` containing exact argv and environment. Scratch processes are stopped and waited; the temporary home/work directory is removed.

## Limits

This proves source-CLI behavior and raw fullscreen output, not visual fidelity of an actual Kitty/WezTerm graphics terminal. tmux supplies the real TTY; the image protocol is selected explicitly.

Native copied-file path paste remains unproved on this Linux lane. Both the Linux source and shipped helper export only `getText` and `getImage`; `getFilePaths` is exported by the Darwin helper. The steps record that exclusion as `passed: false`. A native Darwin real-app recording is still required to close all of A15. Unit tests, this image-fallback recording and `--version` do not replace it.
