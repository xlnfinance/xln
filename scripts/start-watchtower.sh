#!/bin/bash
# XLN standalone watchtower startup script.
# Runs as a separate process from the main runtime/orchestrator so backup and
# rescue logs stay isolated from consensus/runtime logs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/lib/start-common.sh"

export PATH="${HOME}/.bun/bin:$PATH"
export XLN_WATCHTOWER_PORT="${XLN_WATCHTOWER_PORT:-9100}"
export XLN_WATCHTOWER_HOST="${XLN_WATCHTOWER_HOST:-127.0.0.1}"
export XLN_WATCHTOWER_DB_PATH="${XLN_WATCHTOWER_DB_PATH:-$REPO_ROOT/db/watchtower/prod-main}"
export XLN_WATCHTOWER_MAX_BYTES="${XLN_WATCHTOWER_MAX_BYTES:-10240}"
export XLN_WATCHTOWER_MAX_BUNDLES="${XLN_WATCHTOWER_MAX_BUNDLES:-3}"
export XLN_WATCHTOWER_ID="${XLN_WATCHTOWER_ID:-xln-official-watchtower}"

mkdir -p "$(dirname "$XLN_WATCHTOWER_DB_PATH")"
xln_kill_by_port "$XLN_WATCHTOWER_PORT" start-watchtower

exec "${HOME}/.bun/bin/bun" runtime/watchtower/standalone-server.ts \
  --host "$XLN_WATCHTOWER_HOST" \
  --port "$XLN_WATCHTOWER_PORT" \
  --db "$XLN_WATCHTOWER_DB_PATH" \
  --quota-bytes "$XLN_WATCHTOWER_MAX_BYTES" \
  --max-bundles "$XLN_WATCHTOWER_MAX_BUNDLES"
