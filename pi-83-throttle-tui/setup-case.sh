#!/usr/bin/env bash
# usage: setup-case.sh <case> <port>  -- agent dir with the stub provider, empty stub log.
set -eu
P=~/.local/state/dev-lead-posts/pi83-proof
mkdir -p "$P/$1/agent"
cat > "$P/$1/agent/models.json" <<EOF
{"providers":{"stubnet":{"baseUrl":"http://127.0.0.1:$2/v1","api":"openai-completions","apiKey":"stub-key",
 "compat":{"supportsStore":false,"maxTokensField":"max_tokens"},
 "models":[{"id":"flash","name":"Flash stub","reasoning":false,"input":["text"],"contextWindow":32000,"maxTokens":1024,
 "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}
EOF
: > "$P/$1/stub.log"
