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
CONTRACT_INPUT_CACHE="$ROOT_DIR/.tmp/contracts-sync-input.sha256"
CONTRACT_OUTPUT_CACHE="$ROOT_DIR/.tmp/contracts-sync-output.sha256"

hash_contract_inputs() {
  (
    cd "$ROOT_DIR"
    find \
      scripts/sync-contract-artifacts.sh \
      jurisdictions/contracts \
      jurisdictions/scripts/generate-typechain.cjs \
      jurisdictions/hardhat.config.ts \
      jurisdictions/package.json \
      jurisdictions/tsconfig.json \
      package.json bun.lock \
      -type f -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 shasum -a 256 \
      | shasum -a 256 \
      | awk '{print $1}'
  )
}

hash_contract_outputs() {
  if [[ ! -d "$ROOT_DIR/jurisdictions/artifacts/contracts" \
    || ! -f "$TYPECHAIN_PUBLISH_PATH/index.ts" ]]; then
    echo missing
    return
  fi
  (
    cd "$ROOT_DIR"
    find jurisdictions/artifacts/contracts jurisdictions/typechain-types \
      -type f -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 shasum -a 256 \
      | shasum -a 256 \
      | awk '{print $1}'
  )
}

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

# Hardhat uses the current configured Node. Do not silently select an older
# Homebrew installation or a harness-private runtime ahead of the user's PATH.
NODE_BIN="${XLN_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "[contracts-sync] ERROR: Node is required; set XLN_NODE_BIN or install it on PATH" >&2
  exit 1
fi
NODE_VERSION="$("$NODE_BIN" --version)"
echo "[contracts-sync] node=$NODE_BIN version=$NODE_VERSION"

export PATH="$(dirname "$NODE_BIN"):$ROOT_DIR/node_modules/.bin:$HOME/.bun/bin:$PATH"

contract_input_hash="$( { hash_contract_inputs; printf '%s\n' "$NODE_VERSION"; } | shasum -a 256 | awk '{print $1}')"
contract_output_hash="$(hash_contract_outputs)"
cached_input_hash="$(cat "$CONTRACT_INPUT_CACHE" 2>/dev/null || true)"
cached_output_hash="$(cat "$CONTRACT_OUTPUT_CACHE" 2>/dev/null || true)"
if [[ "$contract_input_hash" == "$cached_input_hash" \
  && "$contract_output_hash" == "$cached_output_hash" ]]; then
  echo "[contracts-sync] verified cache hit; Solidity artifacts and TypeChain unchanged"
else
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
  printf '%s\n' "$contract_input_hash" > "$CONTRACT_INPUT_CACHE.next"
  hash_contract_outputs > "$CONTRACT_OUTPUT_CACHE.next"
  mv "$CONTRACT_INPUT_CACHE.next" "$CONTRACT_INPUT_CACHE"
  mv "$CONTRACT_OUTPUT_CACHE.next" "$CONTRACT_OUTPUT_CACHE"
fi

echo "[contracts-sync] copying fresh contract artifacts to frontend/static"
cd "$ROOT_DIR/frontend"
"$NODE_BIN" copy-static-files.js --contracts-only --require-all-contract-sources

echo "[contracts-sync] verifying compiler immutable metadata parity"
bun "$ROOT_DIR/core/scripts/checks/contracts/check-contract-artifact-immutables.ts"

echo "[contracts-sync] done"
