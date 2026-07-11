#!/bin/sh
set -eu

REPO_ROOT="${XLN_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
JDB_ROOT="${XLN_JDB_ROOT:-$REPO_ROOT/data}"
BUDGET_GIB="${ANVIL_STORAGE_BUDGET_GIB:-10}"
BUDGET_KIB=$((BUDGET_GIB * 1024 * 1024))
PROBE_TIMEOUT_SECONDS="${ANVIL_STORAGE_PROBE_TIMEOUT_SECONDS:-5}"

run_bounded() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$PROBE_TIMEOUT_SECONDS" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$PROBE_TIMEOUT_SECONDS" "$@"
  else
    perl -e '$seconds = shift; alarm $seconds; exec @ARGV' "$PROBE_TIMEOUT_SECONDS" "$@"
  fi
}

measure_path_kib() {
  local target="$1"
  local output
  [ -e "$target" ] || {
    echo 0
    return 0
  }
  if output="$(run_bounded du -sk "$target" 2>/dev/null)"; then
    echo "$output" | awk '{ print $1 + 0 }'
    return 0
  fi
  return 124
}

state_kib=0
for state_file in "$JDB_ROOT/anvil-state.json" "$JDB_ROOT/anvil2-state.json"; do
  path_kib="$(measure_path_kib "$state_file")" || {
    echo "ANVIL_STORAGE_STATE_PROBE_TIMEOUT: path=$state_file timeout=${PROBE_TIMEOUT_SECONDS}s" >&2
    exit 1
  }
  state_kib=$((state_kib + path_kib))
done

tmp_kib=0
for tmp_dir in "$JDB_ROOT/tmp" "$HOME/.foundry/anvil/tmp"; do
  [ -d "$tmp_dir" ] || continue
  if path_kib="$(measure_path_kib "$tmp_dir")"; then
    tmp_kib=$((tmp_kib + path_kib))
    continue
  fi
  echo "anvil storage probe exceeded ${PROBE_TIMEOUT_SECONDS}s; clearing temp path: $tmp_dir" >&2
  rm -rf "$tmp_dir"
  install -d -m 700 "$tmp_dir"
done

used_kib=$((state_kib + tmp_kib))
if [ "$used_kib" -gt "$BUDGET_KIB" ]; then
  for tmp_dir in "$JDB_ROOT/tmp" "$HOME/.foundry/anvil/tmp"; do
    [ -d "$tmp_dir" ] || continue
    rm -rf "$tmp_dir"
    install -d -m 700 "$tmp_dir"
  done
  used_kib="$state_kib"
fi

if [ "$used_kib" -gt "$BUDGET_KIB" ]; then
  echo "ANVIL_STORAGE_BUDGET_EXCEEDED: used=${used_kib}KiB budget=${BUDGET_KIB}KiB" >&2
  exit 1
fi

echo "anvil storage budget: used=${used_kib}KiB / ${BUDGET_KIB}KiB"
