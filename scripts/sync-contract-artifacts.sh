#!/bin/bash
set -euo pipefail

# RELEASE INVARIANT: Solidity source changes necessarily change canonical ABI/bytecode.
# Always rebuild and commit both frontend/static/contracts and jurisdictions/typechain-types
# with the Solidity change. Stale generated artifacts are a release blocker, never a cache.

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

# Hardhat needs a Node runtime, not the Bun one that runs the rest of the repo.
# Hardhat 3 supports Node 22.13+ and subsequent even major releases. Validate
# that policy directly so an odd default or an older Node 22 cannot slip in,
# while a newly supported even major does not require another hard-coded list.
node_supports_hardhat() {
  "$1" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major % 2 === 0 && (major > 22 || (major === 22 && minor >= 13)) ? 0 : 1);
  ' 2>/dev/null
}

choose_supported_node() {
  local candidates=()
  if [[ -n "${XLN_NODE_BIN:-}" ]]; then
    candidates+=("$XLN_NODE_BIN")
  fi
  candidates+=(
    "$ROOT_DIR/.node/bin/node"
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
    "$HOME/.cache/codex-runtimes/codex-primary-core/dependencies/node/bin/node"
    "/opt/homebrew/opt/node@26/bin/node"
    "/opt/homebrew/opt/node@24/bin/node"
    "/opt/homebrew/opt/node@22/bin/node"
    "$(command -v node || true)"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -z "$candidate" || ! -x "$candidate" ]]; then
      continue
    fi
    if node_supports_hardhat "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done

  echo "[contracts-sync] ERROR: Hardhat 3 needs Node 22.13+ on a supported even major. Current node: $(node -v 2>/dev/null || echo missing). Set XLN_NODE_BIN to a supported node binary." >&2
  return 1
}

NODE_BIN="$(choose_supported_node)"
export PATH="$(dirname "$NODE_BIN"):$ROOT_DIR/node_modules/.bin:$HOME/.bun/bin:$PATH"
echo "[contracts-sync] using Node $("$NODE_BIN" --version) at $NODE_BIN"

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
rsync -a --checksum --exclude='/index.ts' "$TYPECHAIN_BUILD_PATH/" "$TYPECHAIN_PUBLISH_PATH/"
if ! cmp -s "$TYPECHAIN_BUILD_PATH/index.ts" "$TYPECHAIN_PUBLISH_PATH/index.ts"; then
  cp "$TYPECHAIN_BUILD_PATH/index.ts" "$TYPECHAIN_PUBLISH_PATH/.index.ts.next"
  mv "$TYPECHAIN_PUBLISH_PATH/.index.ts.next" "$TYPECHAIN_PUBLISH_PATH/index.ts"
fi
rsync -a --checksum --delete-after --exclude='/index.ts' "$TYPECHAIN_BUILD_PATH/" "$TYPECHAIN_PUBLISH_PATH/"
echo "[contracts-sync] published complete TypeChain generation dependencies-first"

echo "[contracts-sync] copying fresh contract artifacts to frontend/static"
cd "$ROOT_DIR/frontend"
"$NODE_BIN" copy-static-files.js

echo "[contracts-sync] verifying compiler immutable metadata parity"
bun "$ROOT_DIR/core/scripts/checks/contracts/check-contract-artifact-immutables.ts"

echo "[contracts-sync] done"
