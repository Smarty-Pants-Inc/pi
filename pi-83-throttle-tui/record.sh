#!/usr/bin/env bash
# usage: record.sh <case: retry|esc> <port>
# Real pty recording: smarty-video-proof tty runs `tmux attach -r` under script(1); the interactive Pi runs in that
# tmux session and gets keys through tmux send-keys. Keeps the stub request log and a key log with UTC times.
set -u
P=~/.local/state/dev-lead-posts/pi83-proof
SVP=/home/paul/smarty/smarty-pants/bin/smarty-video-proof
c=$1; port=$2; s=pi83$c
cd "$P"
./setup-case.sh "$c" "$port"
keys="$P/$c/keys.log"; : > "$keys"
key() { echo "$(date -u +%FT%T.%3NZ) $*" >> "$keys"; }
node stub.mjs "$port" "$c/stub.log" true 8 & stub=$!
echo "$stub" > "$c/stub.pid"
tmux new-session -d -s "$s" -x 100 -y 28 "sleep 1.5; bash $P/pane.sh $c $port"
tmux set -t "$s" status off >/dev/null
env -u TMUX nice -n 19 "$SVP" tty "$P/$c/proof.webm" -- tmux attach -r -t "$s" & rec=$!
sleep 9
key "type 'Reply with only OK.' Enter"
tmux send-keys -t "$s" "Reply with only OK." Enter
if [ "$c" = esc ]; then
  sleep 3.5
  key "Escape (during countdown)"
  tmux send-keys -t "$s" Escape
  sleep 14   # well past the 8 s wait: a retry, if any, would reach the stub here
else
  sleep 13
fi
tmux capture-pane -t "$s" -p > "$c/final-screen.txt"
key "C-d (exit pi)"
tmux send-keys -t "$s" C-d
wait "$rec"; echo "recorder exit=$?"
kill "$stub"; wait "$stub" 2>/dev/null
rm -f "$c/stub.pid"
echo "--- $c stub.log"; cat "$c/stub.log"; echo "--- keys.log"; cat "$keys"
