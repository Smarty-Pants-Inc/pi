#!/usr/bin/env bash
# usage: CASE=throttled primer.sh <log>  -- one tiny chat POST with the same member header; logs start/end UTC, status, trace.
. "$(dirname "$0")/env.sh"; B=$W/primer-body.$$
S=$(ts)
out=$(curl -sS -m 60 -D - -o "$B" -w '%{http_code}' -H 'content-type: application/json' -H "X-Smarty-Member: $MEMBER" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"Say hi.\"}]}" "http://127.0.0.1:$PORT/v1/chat/completions")
E=$(ts)
{ echo "$S primer POST start (curl, X-Smarty-Member: $MEMBER)"; echo "$out" | tr -d '\r' | grep -iE '^(HTTP|retry-after|x-smarty-trace)' | sed "s/^/$E primer /"; echo "$E primer body: $(head -c 300 "$B")"; } >> "$1"
rm -f "$B"
