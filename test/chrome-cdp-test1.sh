#!/usr/bin/env bash
set -euo pipefail

CDP_HTTP="${CDP_HTTP:-http://127.0.0.1:9222}"
TAB_WS="${TAB_WS:-$(curl -fsS "${CDP_HTTP}/json/list" | jq -r 'map(select(.type=="page")) | .[0].webSocketDebuggerUrl')}"
URL="${1:-https://wrobo.io}"

echo "TAB_WS: ${TAB_WS}"
echo "URL: ${URL}"

cat <<EOF | websocat "${TAB_WS}" | jq .
{"id":1,"method":"Page.enable"}
{"id":2,"method":"Page.navigate","params":{"url":"${URL}"}}
EOF
