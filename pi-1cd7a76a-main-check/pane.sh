#!/usr/bin/env bash
# runs inside the recorded tmux pane: staged Pi TUI against the real gateway.
set -u; . "$(dirname "$0")/env.sh"
echo "\$ readlink ~/.local/bin/pi   # active release (NOT under test): $(readlink ~/.local/bin/pi | grep -o 'releases/[0-9a-f]\{8\}')"
echo "\$ <staged release 1cd7a76a>/…/pi-coding-agent/dist/cli.js --provider smartygw --model $MODEL --no-session --no-tools"
echo "  (net-lead temp gateway 127.0.0.1:$PORT, case $CASE, X-Smarty-Member: $MEMBER)"
[ "$CASE" = throttled ] && echo "  (a curl primer POST is sent just before the prompt so Pi's first request is throttled)"
sleep 2
cd "$PROF"
PI_CODING_AGENT_DIR="$PROF/agent" "$PI" --provider smartygw --model "$MODEL" --no-session --no-tools
clear
echo "--- pi exited. usage-log lines for member $MEMBER (this run):"
cat "$W/tui-$CASE-usage.txt" 2>/dev/null
sleep 5
