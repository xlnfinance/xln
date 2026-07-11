#!/bin/sh
set -eu

REPO_ROOT="${XLN_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BUDGET_GIB="${ANVIL_STORAGE_BUDGET_GIB:-10}"
BUDGET_KIB=$((BUDGET_GIB * 1024 * 1024))

measure_kib() {
  du -sk \
    "$REPO_ROOT/data/anvil-state.json" \
    "$REPO_ROOT/data/anvil2-state.json" \
    "$REPO_ROOT/data/anvil-tmp" \
    "$HOME/.foundry/anvil/tmp" \
    2>/dev/null | awk '{ total += $1 } END { print total + 0 }'
}

for tmp_dir in "$REPO_ROOT/data/anvil-tmp" "$HOME/.foundry/anvil/tmp"; do
  [ -d "$tmp_dir" ] || continue
  find "$tmp_dir" -mindepth 1 -mmin +180 -exec rm -rf {} +
done

used_kib="$(measure_kib)"
if [ "$used_kib" -gt "$BUDGET_KIB" ]; then
  for tmp_dir in "$REPO_ROOT/data/anvil-tmp" "$HOME/.foundry/anvil/tmp"; do
    [ -d "$tmp_dir" ] || continue
    find "$tmp_dir" -mindepth 1 -exec rm -rf {} +
  done
  used_kib="$(measure_kib)"
fi

if [ "$used_kib" -gt "$BUDGET_KIB" ]; then
  echo "ANVIL_STORAGE_BUDGET_EXCEEDED: used=${used_kib}KiB budget=${BUDGET_KIB}KiB" >&2
  exit 1
fi

echo "anvil storage budget: used=${used_kib}KiB / ${BUDGET_KIB}KiB"
