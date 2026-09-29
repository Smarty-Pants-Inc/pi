#!/usr/bin/env bash
# usage: CASE=throttled|plain record.sh -- real pty recording via smarty-video-proof tty + tmux attach -r.
set -u; . "$(dirname "$0")/env.sh"; SVP=/home/paul/smarty/smarty-pants/bin/smarty-video-proof
s=dl-pi1cd7-$CASE; cd "$W"
keys="$W/tui-$CASE-keys.log"; P="$W/tui-$CASE-primer.log"; : > "$keys"; : > "$W/tui-$CASE-usage.txt"; : > "$P"
key() { echo "$(ts) $*" >> "$keys"; }
n0=$(wc -l < "$ULOG")
tmux new-session -d -s "$s" -x 110 -y 30 "sleep 1.5; CASE=$CASE bash $W/pane.sh"
tmux set -t "$s" status off >/dev/null
env -u TMUX nice -n 19 "$SVP" tty "$W/tui-$CASE.webm" -- tmux attach -r -t "$s" & rec=$!
sleep 9
tmux send-keys -t "$s" "Reply with only OK."
if [ "$CASE" = throttled ]; then key "primer curl start"; "$W/primer.sh" "$P" & sleep 0.3; fi
key "Enter (prompt 'Reply with only OK.')"
tmux send-keys -t "$s" Enter
if [ "$CASE" = throttled ]; then sleep 25; else sleep 22; fi
tmux capture-pane -t "$s" -p > "$W/tui-$CASE-final-screen.txt"
tail -n +$((n0+1)) "$ULOG" | grep "\"member\":\"$MEMBER\"" > "$W/tui-$CASE-usage.txt"
key "C-d (exit pi)"
tmux send-keys -t "$s" C-d
wait "$rec"; echo "recorder exit=$?"
wait
echo "--- keys"; cat "$keys"; echo "--- primer"; cat "$P"; echo "--- usage"; cat "$W/tui-$CASE-usage.txt"; echo "--- screen"; cat "$W/tui-$CASE-final-screen.txt"
