#!/usr/bin/env bash
# usage: record.sh <profile_dir> <port> <model> <usage_log> <out_dir>
# Real pty recording: smarty-video-proof tty runs `tmux attach -r` under script(1); the live Pi runs in that tmux session
# and gets keys through tmux send-keys. The key log has UTC times. No primer: every request is refused.
set -u
D="$5"; SVP=/home/paul/smarty/smarty-pants/bin/smarty-video-proof
s=devlead-pi1723-tui; cd "$D"
keys="$D/tui-keys.log"; : > "$keys"; : > tui-usage.txt
key() { echo "$(date -u +%FT%T.%3NZ) $*" >> "$keys"; }
n0=$(wc -l < "$4")
tmux new-session -d -s "$s" -x 110 -y 30 "sleep 1.5; bash $D/pane.sh $1 $2 $3 $D"
tmux set -t "$s" status off >/dev/null
env -u TMUX nice -n 19 "$SVP" tty "$D/tui.webm" -- tmux attach -r -t "$s" & rec=$!
sleep 9
tmux send-keys -t "$s" "Reply with only OK."
sleep 0.3
key "Enter (prompt 'Reply with only OK.')"
tmux send-keys -t "$s" Enter
sleep 20
tmux capture-pane -t "$s" -p > tui-final-screen.txt
key "screen captured (20 s after Enter)"
tail -n +$((n0+1)) "$4" | grep '"devlead-pi1723"' > tui-usage.txt
key "C-d (exit pi)"
tmux send-keys -t "$s" C-d
wait "$rec"; echo "recorder exit=$?"
echo "--- keys"; cat "$keys"; echo "--- usage"; cat tui-usage.txt; echo "--- screen"; cat tui-final-screen.txt
