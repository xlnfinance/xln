#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

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

echo "[contracts-sync] copying fresh contract artifacts to frontend/static"
cd "$ROOT_DIR/frontend"
"$NODE_BIN" copy-static-files.js

echo "[contracts-sync] done"
