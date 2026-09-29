#!/usr/bin/env bash
# usage: pane.sh <case> <port>  -- runs inside the recorded tmux pane: interactive Pi against the stub, then the stub log.
set -u
P=~/.local/state/dev-lead-posts/pi83-proof
WT=~/.local/state/dev-lead-posts/wt-pi-throttle
case_dir="$P/$1"
echo "\$ git -C wt-pi-throttle rev-parse HEAD  # $(git -C "$WT" rev-parse HEAD)"
cd "$case_dir"
echo "\$ node wt-pi-throttle/packages/coding-agent/dist/cli.js --provider stubnet --model flash --no-session"
echo "  (interactive; stub 127.0.0.1:$2 answers the 1st POST 429 smarty_limit throttled:true Retry-After 8)"
sleep 2
PI_CODING_AGENT_DIR="$case_dir/agent" nice -n 19 node "$WT"/packages/coding-agent/dist/cli.js --provider stubnet --model flash --no-session
clear
echo "--- pi exited. stub request log ($case_dir/stub.log):"
cat "$case_dir/stub.log"
sleep 4
