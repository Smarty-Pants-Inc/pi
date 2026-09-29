#!/usr/bin/env bash
# usage: record.sh <profile_dir> <port> <model> <usage_log>
# Real pty recording: smarty-video-proof tty runs `tmux attach -r` under script(1); Pi runs in that tmux session and
# gets keys through tmux send-keys. The primer curl starts right before Enter; the key log has UTC times.
set -u
D=~/.local/state/dev-lead-posts/pi83-real; SVP=/home/paul/smarty/smarty-pants/bin/smarty-video-proof
s=pi83real; cd "$D"
keys="$D/tui-keys.log"; : > "$keys"; : > tui-usage.txt; : > tui-primer.log
key() { echo "$(date -u +%FT%T.%3NZ) $*" >> "$keys"; }
n0=$(wc -l < "$4" 2>/dev/null || echo 0)
tmux new-session -d -s "$s" -x 110 -y 30 "sleep 1.5; bash $D/pane.sh $1 $2 $3"
tmux set -t "$s" status off >/dev/null
env -u TMUX nice -n 19 "$SVP" tty "$D/tui.webm" -- tmux attach -r -t "$s" & rec=$!
sleep 9
tmux send-keys -t "$s" "Reply with only OK."
key "primer curl start"
"$D/primer.sh" "$2" "$3" "$D/tui-primer.log" &
sleep 0.3
key "Enter (prompt 'Reply with only OK.')"
tmux send-keys -t "$s" Enter
sleep 25
tmux capture-pane -t "$s" -p > tui-final-screen.txt
tail -n +$((n0+1)) "$4" | grep '"dev-lead-pi83"' > tui-usage.txt
key "C-d (exit pi)"
tmux send-keys -t "$s" C-d
wait "$rec"; echo "recorder exit=$?"
wait
echo "--- keys"; cat "$keys"; echo "--- primer"; cat tui-primer.log; echo "--- usage"; cat tui-usage.txt; echo "--- screen"; cat tui-final-screen.txt
