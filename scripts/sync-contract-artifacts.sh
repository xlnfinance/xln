#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCK_DIR="$ROOT_DIR/.tmp/contracts-sync.lock"
TYPECHAIN_BUILD_DIR=".typechain-types-build-$$"
TYPECHAIN_BUILD_PATH="$ROOT_DIR/jurisdictions/$TYPECHAIN_BUILD_DIR"
TYPECHAIN_PUBLISH_PATH="$ROOT_DIR/jurisdictions/typechain-types"

acquire_contract_sync_lock() {
  mkdir -p "$ROOT_DIR/.tmp"
  local attempts=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [[ -f "$LOCK_DIR/pid" ]]; then
      local owner
      owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
      if [[ "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
        rm -rf "$LOCK_DIR"
        continue
      fi
    fi
    attempts=$((attempts + 1))
    if (( attempts >= 1200 )); then
      echo "[contracts-sync] ERROR: timed out waiting for contract generation lock" >&2
      return 1
    fi
    sleep 0.1
  done
  echo "$$" > "$LOCK_DIR/pid"
}

cleanup_contract_sync() {
  rm -rf "$TYPECHAIN_BUILD_PATH"
  if [[ "$(cat "$LOCK_DIR/pid" 2>/dev/null || true)" == "$$" ]]; then
    rm -rf "$LOCK_DIR"
  fi
}

acquire_contract_sync_lock
trap cleanup_contract_sync EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export XLN_TYPECHAIN_OUT_DIR="$TYPECHAIN_BUILD_DIR"

choose_supported_node() {
  local candidates=()
  if [[ -n "${XLN_NODE_BIN:-}" ]]; then
    candidates+=("$XLN_NODE_BIN")
  fi
  candidates+=(
    "$ROOT_DIR/.node/bin/node"
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
    "/opt/homebrew/opt/node@24/bin/node"
    "/opt/homebrew/opt/node@22/bin/node"
    "/opt/homebrew/opt/node@20/bin/node"
    "$(command -v node || true)"
  )

  local candidate major
  for candidate in "${candidates[@]}"; do
    if [[ -z "$candidate" || ! -x "$candidate" ]]; then
      continue
    fi
    major="$("$candidate" -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
    case "$major" in
      20|22|24)
        echo "$candidate"
        return 0
        ;;
    esac
  done

  echo "[contracts-sync] ERROR: Hardhat requires Node 20, 22, or 24. Current node: $(node -v 2>/dev/null || echo missing). Set XLN_NODE_BIN to a supported node binary." >&2
  return 1
}

NODE_BIN="$(choose_supported_node)"
export PATH="$(dirname "$NODE_BIN"):$ROOT_DIR/node_modules/.bin:$HOME/.bun/bin:$PATH"

echo "[contracts-sync] compiling jurisdictions contracts"
cd "$ROOT_DIR/jurisdictions"
rm -rf "$ROOT_DIR/jurisdictions/node_modules"
HARDHAT_EXPERIMENTAL_ALLOW_NON_LOCAL_INSTALLATION=true "$ROOT_DIR/node_modules/.bin/hardhat" clean
HARDHAT_EXPERIMENTAL_ALLOW_NON_LOCAL_INSTALLATION=true "$ROOT_DIR/node_modules/.bin/hardhat" compile --force
"$NODE_BIN" scripts/generate-typechain.cjs

if [[ ! -f "$TYPECHAIN_BUILD_PATH/index.ts" ]]; then
  echo "[contracts-sync] ERROR: generated TypeChain index is missing" >&2
  exit 1
fi
mkdir -p "$TYPECHAIN_PUBLISH_PATH"
# Keep the old index and every file it references until all files for the new
# generation exist. Then switch the sole runtime entrypoint atomically and
# delete stale files only after the new index is visible.
rsync -a --exclude='/index.ts' "$TYPECHAIN_BUILD_PATH/" "$TYPECHAIN_PUBLISH_PATH/"
cp "$TYPECHAIN_BUILD_PATH/index.ts" "$TYPECHAIN_PUBLISH_PATH/.index.ts.next"
mv "$TYPECHAIN_PUBLISH_PATH/.index.ts.next" "$TYPECHAIN_PUBLISH_PATH/index.ts"
rsync -a --delete-after --exclude='/index.ts' "$TYPECHAIN_BUILD_PATH/" "$TYPECHAIN_PUBLISH_PATH/"
echo "[contracts-sync] published complete TypeChain generation dependencies-first"

echo "[contracts-sync] copying fresh contract artifacts to frontend/static"
cd "$ROOT_DIR/frontend"
"$NODE_BIN" copy-static-files.js

echo "[contracts-sync] verifying compiler immutable metadata parity"
bun "$ROOT_DIR/runtime/scripts/check-contract-artifact-immutables.ts"

echo "[contracts-sync] done"
