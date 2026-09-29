#!/usr/bin/env bash
# usage: record.sh CASE PRIMER(0|1)
# Records Pi's TUI running INSIDE test-org's Node: the fleet's Node Herdr client (deploy/node/herdr.sh test-org) runs in
# tmux session devlead-pinode-rec; smarty-video-proof tty records `tmux attach -r` to it. Pi runs in the Node's Herdr
# pane $P (workspace created with --env SMARTY_MEMBER=devlead-pinode); keys go through `herdr.sh test-org pane send-*`.
# PRIMER=1: right before Enter, one admitted Pi --print runs in a second Node pane $P2; Enter is sent as soon as its
# usage-log line (200) appears, so Pi's TUI request lands within the gateway's 10 s throttle window.
# The split pane $P2 does not inherit the workspace's --env SMARTY_MEMBER (seen in attempt 1), so the primer sets it.
set -u
D=$(cd "$(dirname "$0")" && pwd); cd "$D"; . ./env
C=$1; PRIMER=$2; s=devlead-pinode-rec; SVP=/home/paul/smarty/smarty-pants/bin/smarty-video-proof
U=$(sed -n 2p ../pi-node-gw); n0=$(wc -l < "$U")
keys="$D/$C-tui-keys.log"; : > "$keys"
key() { echo "$(date -u +%FT%T.%3NZ) $*" >> "$keys"; }
mine() { tail -n +$((n0+1)) "$U" | grep '"member":"devlead-pinode"'; }
h() { "$H" test-org "$@" >/dev/null; }
h pane run "$P" "clear; echo '\$ id; command -v pi; cat /var/lib/smarty-org-sandbox/test-org/pi/RELEASE | cut -c1-40; echo SMARTY_MEMBER=\$SMARTY_MEMBER'; id; command -v pi; cut -c1-40 /var/lib/smarty-org-sandbox/test-org/pi/RELEASE; echo SMARTY_MEMBER=\$SMARTY_MEMBER"
sleep 1
env -u TMUX TMPDIR="$D" nice -n 19 "$SVP" tty "$D/$C-tui.webm" -- tmux attach -r -t "$s" & rec=$!
sleep 4
key "pane run: pi --model node-gateway/nemotron-3-super"
h pane run "$P" "pi --model node-gateway/nemotron-3-super"
sleep 7
h pane send-text "$P" "Reply with only OK."
sleep 1
if [ "$PRIMER" = 1 ]; then
  key "primer: pane $P2 run: SMARTY_MEMBER=devlead-pinode pi --model node-gateway/nemotron-3-super --print 'Say hi.'"
  h pane run "$P2" "SMARTY_MEMBER=devlead-pinode pi --model node-gateway/nemotron-3-super --print 'Say hi.'"
  for i in $(seq 1 100); do [ "$(mine | wc -l)" -ge 1 ] && break; sleep 0.1; done
  key "primer usage line seen: $(mine | head -1 | grep -o '"status":[0-9]*')"
fi
key "Enter (prompt 'Reply with only OK.')"
h pane send-keys "$P" enter
sleep ${WAIT:-25}
"$H" test-org pane read "$P" --source visible > "$C-tui-final-screen.txt"
mine > "$C-tui-usage.txt"
key "ctrl+d (exit pi)"
h pane send-keys "$P" ctrl+d
sleep 2
{ echo "clear; echo '--- fleet-side usage log (gateway $(basename "$U")), lines for member devlead-pinode in this run, copied in by dev-lead:'"
  mine | sed -E 's/.*"time":"[0-9-]+T([^"]+)".*"trace":"([^"]+)","status":([0-9]+).*"end":"([a-z]+)"(,"refused":"([a-z_]+)")?.*/\1 status \3 \4 \6  trace \2/' | sed "s/^/echo '/; s/\$/'/"; } > "$C-show.sh"
h pane run "$P" "$(paste -sd';' "$C-show.sh")"
sleep 6
tmux detach-client -s "$s"
wait "$rec"; echo "recorder exit=$?"
echo "--- keys"; cat "$keys"; echo "--- usage"; cat "$C-tui-usage.txt"; echo "--- screen"; cat "$C-tui-final-screen.txt"
