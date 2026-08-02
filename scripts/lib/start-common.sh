#!/bin/bash

XLN_START_ASSERT_ONLY_ACTIVE=0

xln_configure_start_policy() {
  local requested_repo_root="$1"
  local names=(
    XLN_LOCAL_TEST_LEASE_MODE XLN_LOCAL_TEST_LEASE_POOL XLN_LOCAL_TEST_LEASE_BASE
    XLN_LOCAL_TEST_LEASE_GUARD XLN_LOCAL_TEST_LEASE_OWNER_PID XLN_LOCAL_TEST_LEASE_REPO_ROOT
  )
  local present=0 name
  for name in "${names[@]}"; do [[ -n "${!name:-}" ]] && present=$((present + 1)); done
  [[ "$present" -gt 0 ]] || return 0
  if [[ "$present" -ne "${#names[@]}" ]]; then
    echo "LOCAL_TEST_LEASE_ENV_INCOMPLETE:${present}/${#names[@]}" >&2
    return 1
  fi
  if [[ "$XLN_LOCAL_TEST_LEASE_MODE" != "assert-only-v1" || "$XLN_LOCAL_TEST_LEASE_POOL" != "local-test-stack-v1" ]]; then
    echo "LOCAL_TEST_LEASE_POLICY_INVALID" >&2
    return 1
  fi
  local canonical_repo
  canonical_repo="$(cd "$requested_repo_root" 2>/dev/null && pwd -P)" || {
    echo "LOCAL_TEST_LEASE_REPO_INVALID:${requested_repo_root}" >&2
    return 1
  }
  if [[ "$XLN_LOCAL_TEST_LEASE_REPO_ROOT" != "$canonical_repo" ]]; then
    echo "LOCAL_TEST_LEASE_REPO_MISMATCH" >&2
    return 1
  fi
  if [[ ! "$XLN_LOCAL_TEST_LEASE_BASE" =~ ^[0-9]+$ || ! "$XLN_LOCAL_TEST_LEASE_GUARD" =~ ^[0-9]+$ \
    || ! "$XLN_LOCAL_TEST_LEASE_OWNER_PID" =~ ^[1-9][0-9]*$ ]]; then
    echo "LOCAL_TEST_LEASE_NUMBER_INVALID" >&2
    return 1
  fi
  case "$XLN_LOCAL_TEST_LEASE_BASE" in
    20000|20020|20040|20060|20080|20100|20120) ;;
    *) echo "LOCAL_TEST_LEASE_BASE_INVALID:${XLN_LOCAL_TEST_LEASE_BASE}" >&2; return 1 ;;
  esac
  if [[ "$XLN_LOCAL_TEST_LEASE_GUARD" -ne $((XLN_LOCAL_TEST_LEASE_BASE + 19)) \
    || "$XLN_LOCAL_TEST_LEASE_OWNER_PID" -ne "$PPID" ]] || ! kill -0 "$XLN_LOCAL_TEST_LEASE_OWNER_PID" 2>/dev/null; then
    echo "LOCAL_TEST_LEASE_OWNER_INVALID" >&2
    return 1
  fi
  local guard_pids guard_status
  if guard_pids="$(lsof -nP -a -sTCP:LISTEN -t -iTCP:"$XLN_LOCAL_TEST_LEASE_GUARD" 2>/dev/null)"; then
    guard_status=0
  else
    guard_status=$?
  fi
  if [[ "$guard_status" -ne 0 || "$(printf '%s\n' "$guard_pids" | sort -u)" != "$XLN_LOCAL_TEST_LEASE_OWNER_PID" ]]; then
    echo "LOCAL_TEST_LEASE_GUARD_INVALID:status=${guard_status}" >&2
    return 1
  fi
  XLN_PORT_BASE="$XLN_LOCAL_TEST_LEASE_BASE"
  export XLN_PORT_BASE
  XLN_START_ASSERT_ONLY_ACTIVE=1
}

xln_assert_port_available() {
  local port="$1" prefix="${2:-xln-start}" pids status
  if pids="$(lsof -nP -a -sTCP:LISTEN -t -iTCP:"$port" 2>/dev/null)"; then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -eq 1 && -z "$pids" ]]; then return 0; fi
  if [[ "$status" -ne 0 ]]; then
    echo "XLN_START_PORT_SCAN_FAILED:port=${port}:status=${status}" >&2
    return 1
  fi
  echo "XLN_START_PORT_BUSY:port=${port}:pids=$(printf '%s' "$pids" | tr '\n' ',') prefix=${prefix}" >&2
  return 1
}

xln_assert_ports_available() {
  local prefix="$1" port
  shift
  for port in "$@"; do xln_assert_port_available "$port" "$prefix" || return 1; done
}

xln_kill_by_port() {
  if [[ "$XLN_START_ASSERT_ONLY_ACTIVE" -eq 1 ]]; then
    echo "LOCAL_TEST_PROCESS_KILL_FORBIDDEN:port" >&2
    return 1
  fi
  local port="$1"
  local prefix="${2:-xln-start}"
  local pids
  pids="$(lsof -ti TCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "[${prefix}] killing stale listeners on :${port} -> ${pids}"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

xln_kill_by_pattern() {
  if [[ "$XLN_START_ASSERT_ONLY_ACTIVE" -eq 1 ]]; then
    echo "LOCAL_TEST_PROCESS_KILL_FORBIDDEN:pattern" >&2
    return 1
  fi
  local pattern="$1"
  local prefix="${2:-xln-start}"
  local pids
  pids="$(pgrep -f -- "$pattern" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "[${prefix}] killing stale process pattern '$pattern' -> ${pids}"
    echo "$pids" | xargs kill -TERM 2>/dev/null || true
    sleep 1
    pids="$(pgrep -f -- "$pattern" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      echo "$pids" | xargs kill -KILL 2>/dev/null || true
    fi
  fi
}

xln_ensure_jurisdictions_path() {
  local jurisdictions_path="$1"
  local script_dir
  local repo_root
  local source_jurisdictions
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$script_dir/../.." && pwd)"
  source_jurisdictions="$repo_root/jurisdictions/jurisdictions.json"
  mkdir -p "$(dirname "$jurisdictions_path")"
  if [ ! -f "$jurisdictions_path" ]; then
    cp "$source_jurisdictions" "$jurisdictions_path"
  fi
}

xln_read_or_create_operator_seed() {
  local seed_path="$1"
  mkdir -p "$(dirname "$seed_path")"
  if [ ! -f "$seed_path" ]; then
    umask 077
    openssl rand -hex 32 > "$seed_path"
  fi
  chmod 600 "$seed_path"
  local seed
  seed="$(tr -d '\r\n' < "$seed_path")"
  if [ "${#seed}" -ne 64 ] || [[ ! "$seed" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "operator seed file is invalid: $seed_path" >&2
    return 1
  fi
  printf '%s' "$seed"
}
