#!/usr/bin/env bash
# usage: CASE=throttled|plain setup-profile.sh -- temp Pi agent dir: Node-gateway compat, member header, no key.
set -eu; . "$(dirname "$0")/env.sh"
mkdir -p "$PROF/agent"
cat > "$PROF/agent/models.json" <<J
{"providers":{"smartygw":{"baseUrl":"http://127.0.0.1:$PORT/v1","api":"openai-completions","apiKey":"node-gateway",
 "compat":{"maxTokensField":"max_tokens","supportsStore":false,"supportsDeveloperRole":false,"supportsReasoningEffort":false,"supportsUsageInStreaming":true},
 "headers":{"X-Smarty-Member":"$MEMBER"},
 "models":[{"id":"$MODEL","name":"Flash (net-lead temp gateway, $CASE)","reasoning":false,"input":["text"],"contextWindow":32000,"maxTokens":256,
 "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}
J
