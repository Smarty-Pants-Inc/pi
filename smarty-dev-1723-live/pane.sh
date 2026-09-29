#!/usr/bin/env bash
# usage: pane.sh <profile_dir> <port> <model> <out_dir>  -- runs inside the recorded tmux pane: live ~/.local/bin/pi against the real gateway.
set -u
echo "\$ readlink -f ~/.local/bin/pi"
echo "  $(readlink -f ~/.local/bin/pi | sed 's#.*/releases/\([0-9a-f]\{8\}\)[0-9a-f]*/#…/releases/\1…/#')"
echo "\$ pi --provider smartygw --model $3 --no-session --no-tools"
echo "  (real metered gateway 127.0.0.1:$2, billing identity test-org-3, X-Smarty-Member: devlead-pi1723)"
sleep 2
cd "$1"
PI_CODING_AGENT_DIR="$1/agent" ~/.local/bin/pi --provider smartygw --model "$3" --no-session --no-tools
clear
echo "--- pi exited. usage-log lines for member devlead-pi1723 (this run):"
cat "$4/tui-usage.txt" 2>/dev/null
sleep 5
