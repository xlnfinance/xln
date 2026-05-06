#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

PACKAGES=(
  "packages/npm/xln-cli"
  "packages/npm/xlnfinance"
  "packages/npm/create-xln"
  "packages/npm/xln-scoped-cli"
)

if [[ "$DRY_RUN" == "0" ]]; then
  npm whoami >/dev/null
fi

for package_dir in "${PACKAGES[@]}"; do
  echo "==> ${package_dir}"
  if [[ "$DRY_RUN" == "1" ]]; then
    (cd "$ROOT/$package_dir" && npm publish --dry-run --access public)
  else
    (cd "$ROOT/$package_dir" && npm publish --access public)
  fi
done

