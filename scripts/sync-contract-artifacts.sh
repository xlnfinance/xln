#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

export PATH="$ROOT_DIR/node_modules/.bin:$HOME/.bun/bin:$PATH"

echo "[contracts-sync] compiling jurisdictions contracts"
cd "$ROOT_DIR/jurisdictions"
npx hardhat clean
npx hardhat compile --force
node scripts/generate-typechain.cjs

echo "[contracts-sync] copying fresh contract artifacts to frontend/static"
cd "$ROOT_DIR/frontend"
node copy-static-files.js

echo "[contracts-sync] done"
