#!/usr/bin/env bash
# usage: pane.sh <profile_dir> <port> <model>  -- runs inside the recorded tmux pane: interactive Pi against the real gateway.
set -u
WT=~/.local/state/dev-lead-posts/wt-pi-throttle
echo "\$ git -C wt-pi-throttle rev-parse HEAD  # $(git -C "$WT" rev-parse HEAD)"
echo "\$ node wt-pi-throttle/packages/coding-agent/dist/cli.js --provider smartygw --model $3 --no-session --no-tools"
echo "  (real metered gateway 127.0.0.1:$2, billing identity test-org-2, X-Smarty-Member: dev-lead-pi83;"
echo "   a curl primer POST is sent just before the prompt so Pi's first request is throttled)"
sleep 2
cd "$1"
PI_CODING_AGENT_DIR="$1/agent" nice -n 19 node "$WT"/packages/coding-agent/dist/cli.js --provider smartygw --model "$3" --no-session --no-tools
clear
echo "--- pi exited. usage-log lines for member dev-lead-pi83 (this run):"
cat ~/.local/state/dev-lead-posts/pi83-real/tui-usage.txt 2>/dev/null
sleep 5
