#!/usr/bin/env bash
set -euo pipefail

CDP_HTTP="${CDP_HTTP:-http://127.0.0.1:9222}"

json_version() {
  curl -fsS "${CDP_HTTP}/json/version"
}

json_list() {
  curl -fsS "${CDP_HTTP}/json/list"
}

browser_ws_url() {
  json_version | jq -r '.webSocketDebuggerUrl'
}

first_tab_ws_url() {
  json_list | jq -r 'map(select(.type=="page")) | .[0].webSocketDebuggerUrl'
}

first_tab_id() {
  json_list | jq -r 'map(select(.type=="page")) | .[0].id'
}

first_tab_ws_url
