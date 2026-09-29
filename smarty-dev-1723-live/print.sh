#!/usr/bin/env bash
# usage: print.sh <profile_dir> <port> <model> <usage_log>  -- live ~/.local/bin/pi --print; stdout/stderr timestamped;
# (run 2: no strace; pi capped at 90 s by timeout(1) so a hang is visible as exit=124). Then 20 s quiet check of the usage log.
set -u
D=/home/paul/.local/state/dev-lead-posts/pi1723-live.9WfwKl
T="$D/print-transcript.txt"; : > "$T"
n0=$(wc -l < "$4")
echo "$(date -u +%FT%T.%3NZ) pi $(readlink -f ~/.local/bin/pi)" >> "$T"
echo "$(date -u +%FT%T.%3NZ) START pi --provider smartygw --model $3 --no-session --no-tools --print 'Reply with only OK.'" >> "$T"
cd "$1"
{ PI_CODING_AGENT_DIR="$1/agent" timeout -k 5 90 ~/.local/bin/pi --provider smartygw --model "$3" --no-session --no-tools --print 'Reply with only OK.' \
   2> >(node "$D/tsr.mjs" ERR >> "$T"); echo "exit=$?" >&2; } 2> >(node "$D/tsr.mjs" EXIT >> "$T") | node "$D/tsr.mjs" OUT >> "$T"
sleep 0.5
echo "$(date -u +%FT%T.%3NZ) EXITED; waiting 20 s for any further devlead-pi1723 line" >> "$T"
sleep 20
echo "$(date -u +%FT%T.%3NZ) END quiet window" >> "$T"
tail -n +$((n0+1)) "$4" | grep '"devlead-pi1723"' > "$D/print-usage.txt"
echo "$(date -u +%FT%T.%3NZ) devlead-pi1723 usage lines this run: $(wc -l < "$D/print-usage.txt")" >> "$T"
sort -s -k1,1 "$T" -o "$T"; cat "$T"; echo "--- usage"; cat "$D/print-usage.txt"
