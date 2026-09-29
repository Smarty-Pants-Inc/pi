#!/usr/bin/env bash
# usage: print.sh <profile_dir> <port> <model>  -- primer curl, then Pi --print right after; stdout/stderr timestamped.
set -u
D=~/.local/state/dev-lead-posts/pi83-real; WT=~/.local/state/dev-lead-posts/wt-pi-throttle
T="$D/print-transcript.txt"; : > "$T"
echo "$(date -u +%FT%T.%3NZ) head $(git -C "$WT" rev-parse HEAD)" >> "$T"
"$D/primer.sh" "$2" "$3" "$T" &
sleep 0.3
echo "$(date -u +%FT%T.%3NZ) START pi --provider smartygw --model $3 --no-session --no-tools --print 'Reply with only OK.'" >> "$T"
cd "$1"
{ PI_CODING_AGENT_DIR="$1/agent" nice -n 19 node "$WT/packages/coding-agent/dist/cli.js" --provider smartygw --model "$3" --no-session --no-tools --print 'Reply with only OK.' \
   2> >(node "$D/tsr.mjs" ERR >> "$T"); echo "exit=$?" >&2; } | node "$D/tsr.mjs" OUT >> "$T"
wait
sleep 0.5
echo "$(date -u +%FT%T.%3NZ) END" >> "$T"
sort -s -k1,1 "$T" -o "$T"; cat "$T"
