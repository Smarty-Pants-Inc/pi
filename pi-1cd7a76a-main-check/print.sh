#!/usr/bin/env bash
# usage: CASE=throttled|plain print.sh  -- (throttled: primer curl first) then staged Pi --print; timestamped; then 20 s quiet watch.
set -u; . "$(dirname "$0")/env.sh"
T="$W/print-$CASE-transcript.txt"; : > "$T"; n0=$(wc -l < "$ULOG")
echo "$(ts) binary $PI" >> "$T"
if [ "$CASE" = throttled ]; then "$W/primer.sh" "$T" & sleep 0.3; fi
echo "$(ts) START pi --provider smartygw --model $MODEL --no-session --no-tools --print 'Reply with only OK.'" >> "$T"
cd "$PROF"
{ PI_CODING_AGENT_DIR="$PROF/agent" "$PI" --provider smartygw --model "$MODEL" --no-session --no-tools --print 'Reply with only OK.' \
   2> >(node "$W/tsr.mjs" ERR >> "$T"); echo "exit=$?" >&2; } 2>&1 | node "$W/tsr.mjs" OUT >> "$T"
wait
echo "$(ts) pi exited; watching usage log 20 s" >> "$T"; sleep 20
echo "$(ts) END" >> "$T"
sort -s -k1,1 "$T" -o "$T"
tail -n +$((n0+1)) "$ULOG" | grep "\"member\":\"$MEMBER\"" > "$W/print-$CASE-usage.txt"
cat "$T"; echo "--- usage ($MEMBER)"; cat "$W/print-$CASE-usage.txt"
