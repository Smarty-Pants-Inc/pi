#!/usr/bin/env bash
# usage: primer.sh <port> <model> <log>  -- one tiny chat POST with the same member header; logs start/end UTC, status, trace.
S=$(date -u +%FT%T.%3NZ)
out=$(curl -sS -m 60 -D - -o /tmp/pi83-primer-body.$$ -w '%{http_code}' -H 'content-type: application/json' -H 'X-Smarty-Member: dev-lead-pi83' \
  -d "{\"model\":\"$2\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"Say hi.\"}]}" "http://127.0.0.1:$1/v1/chat/completions")
E=$(date -u +%FT%T.%3NZ)
{ echo "$S primer POST start (curl, X-Smarty-Member: dev-lead-pi83)"; echo "$out" | grep -iE '^(HTTP|retry-after|x-smarty-trace)' | sed "s/^/$E primer /"; echo "$E primer body: $(head -c 300 /tmp/pi83-primer-body.$$)"; } >> "$3"
rm -f /tmp/pi83-primer-body.$$
