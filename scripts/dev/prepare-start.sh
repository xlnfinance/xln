#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd -P)"
DEV_DATA_ROOT="${XLN_DEV_DATA_ROOT:-$ROOT_DIR/db/dev}"
DEV_RDB_ROOT="$DEV_DATA_ROOT/rdb"
DEV_JDB_ROOT="$DEV_DATA_ROOT/jdb"
DEV_PID_DIR="$DEV_DATA_ROOT/pids"
DEV_OWNER_FILE="$DEV_DATA_ROOT/process-owner"
CONTRACT_FINGERPRINT_FILE="$DEV_DATA_ROOT/contract-artifacts.sha256"
CANONICAL_J_PATH="$ROOT_DIR/jurisdictions/jurisdictions.json"

case "$DEV_DATA_ROOT" in
  ""|"/"|"$ROOT_DIR")
    echo "DEV_DATA_ROOT_UNSAFE:${DEV_DATA_ROOT}" >&2
    exit 1
    ;;
esac

source "$ROOT_DIR/scripts/dev/process-owner.sh"
stop_owned_dev_processes "$DEV_OWNER_FILE" "$DEV_PID_DIR" "$ROOT_DIR"
rm -f "$DEV_OWNER_FILE" "$DEV_PID_DIR"/*.pid

"$ROOT_DIR/scripts/sync-contract-artifacts.sh"

contract_fingerprint="$(
  {
    printf '%s\n' 'xln-dev-state-v2'
    shasum -a 256 \
      "$ROOT_DIR/frontend/static/contracts/Account.json" \
      "$ROOT_DIR/frontend/static/contracts/Depository.json" \
      "$ROOT_DIR/frontend/static/contracts/EntityProvider.json" \
      "$ROOT_DIR/frontend/static/contracts/HankoVerifier.json" \
      "$ROOT_DIR/frontend/static/contracts/DeltaTransformer.json"
  } | shasum -a 256 | awk '{print $1}'
)"
previous_fingerprint="$(cat "$CONTRACT_FINGERPRINT_FILE" 2>/dev/null || true)"

if [[ "$previous_fingerprint" != "$contract_fingerprint" ]] && {
  [[ -d "$DEV_RDB_ROOT" ]] || compgen -G "$DEV_JDB_ROOT/anvil-*-state.json" >/dev/null;
}; then
  echo "[dev:setup] contract bytecode changed; resetting only local JDB/RDB"
  rm -rf -- "$DEV_RDB_ROOT" "$DEV_JDB_ROOT"
fi

mkdir -p "$DEV_RDB_ROOT" "$DEV_JDB_ROOT" "$DEV_PID_DIR"
if [[ ! -f "$DEV_RDB_ROOT/jurisdictions.json" ]]; then
  cp "$CANONICAL_J_PATH" "$DEV_RDB_ROOT/jurisdictions.json"
fi
fingerprint_tmp="${CONTRACT_FINGERPRINT_FILE}.tmp.$$"
printf '%s\n' "$contract_fingerprint" > "$fingerprint_tmp"
mv "$fingerprint_tmp" "$CONTRACT_FINGERPRINT_FILE"
echo "[dev:setup] local contract state compatible"
