#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

watch_bundle() {
  local entry="$1"
  local output="$2"
  bun --no-orphans build "$entry" \
    --target=browser \
    --outfile="$output" \
    --minify \
    --external http --external https --external zlib \
    --external fs --external path \
    --external stream --external buffer --external url \
    --external net --external tls --external os --external util \
    --external node:module \
    --watch 2>&1 | while IFS= read -r line; do
      if [[ -n "${line//[[:space:]]/}" ]]; then
        printf '%s\n' "$line"
      fi
    done
}

watch_bundle core/api/public/browser.ts frontend/static/runtime.js &
runtime_watch_pid=$!
watch_bundle core/rscore/ts-worker/worker.ts frontend/static/account-worker.js &
account_watch_pid=$!

stop_watchers() {
  kill "$runtime_watch_pid" "$account_watch_pid" 2>/dev/null || true
  wait "$runtime_watch_pid" "$account_watch_pid" 2>/dev/null || true
}
trap stop_watchers EXIT INT TERM

while kill -0 "$runtime_watch_pid" 2>/dev/null && kill -0 "$account_watch_pid" 2>/dev/null; do
  sleep 0.2
done
exit 1
