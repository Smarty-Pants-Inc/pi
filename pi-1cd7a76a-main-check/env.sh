W=/home/paul/.local/state/dev-lead-posts/pi-1cd7a76a-check.R3mdZY
PI=/home/paul/.local/share/smarty-dev/pi-runtime/releases/1cd7a76af2cdaab66d68ec9378e9898bff362dac/node/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
MODEL=nemotron-3-super
case "$CASE" in
 throttled) PORT=18403; MEMBER=devlead-main-throttled; ULOG=/tmp/tmp.YUsWcNlPbo/test-org-2/usage/model.jsonl;;
 plain) PORT=18405; MEMBER=devlead-main-plain; ULOG=/tmp/tmp.YUsWcNlPbo/test-org-3/usage/model.jsonl;;
esac
PROF=$W/prof-$CASE
ts() { date -u +%FT%T.%3NZ; }
