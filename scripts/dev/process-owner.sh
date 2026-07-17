#!/bin/bash

dev_process_start_identity() {
  local pid="$1"
  local identity
  if ! identity="$(LC_ALL=C ps -ww -p "$pid" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"; then
    echo "DEV_PROCESS_START_IDENTITY_UNAVAILABLE:pid=${pid}" >&2
    return 1
  fi
  if [[ -z "$identity" || "$identity" == *$'\t'* || "$identity" == *$'\n'* ]]; then
    echo "DEV_PROCESS_START_IDENTITY_INVALID:pid=${pid}" >&2
    return 1
  fi
  printf '%s' "$identity"
}

dev_role_allowed() {
  case "$1" in
    anvil|anvil2|stack|mesh|watchtower|runtime|vite|vite-http) return 0 ;;
    *) return 1 ;;
  esac
}

dev_repo_root_canonical() {
  local requested="$1"
  local canonical
  if ! canonical="$(cd "$requested" 2>/dev/null && pwd -P)"; then
    echo "DEV_PROCESS_REPO_ROOT_INVALID:${requested}" >&2
    return 1
  fi
  if [[ "$canonical" != /* || "$canonical" == *$'\t'* || "$canonical" == *$'\n'* ]]; then
    echo "DEV_PROCESS_REPO_ROOT_INVALID:${requested}" >&2
    return 1
  fi
  printf '%s' "$canonical"
}

assert_owned_dev_process_identity() {
  local pid="$1" expected_start="$2" repo_root="$3" role="$4"
  local live_start command_line expected_script
  live_start="$(dev_process_start_identity "$pid")" || return 1
  if [[ "$live_start" != "$expected_start" ]]; then
    echo "DEV_PROCESS_START_IDENTITY_MISMATCH:pid=${pid} expected=${expected_start} actual=${live_start}" >&2
    return 1
  fi
  if ! command_line="$(LC_ALL=C ps -ww -p "$pid" -o command= 2>/dev/null)" || [[ -z "$command_line" ]]; then
    echo "DEV_PROCESS_COMMAND_UNAVAILABLE:pid=${pid}" >&2
    return 1
  fi
  expected_script="$repo_root/scripts/dev/run-dev-child.sh"
  if [[ "$command_line" != *"$expected_script $role" && "$command_line" != *"$expected_script $role "* ]]; then
    echo "DEV_PROCESS_REPO_ROLE_MISMATCH:pid=${pid} expected=${expected_script} role=${role} actual=${command_line}" >&2
    return 1
  fi
}

register_owned_dev_process() {
  local role="$1" requested_repo_root="$2"
  if [[ -z "${XLN_DEV_OWNER_ID:-}" || -z "${XLN_DEV_PID_DIR:-}" ]]; then
    echo "DEV_PROCESS_OWNER_ENV_REQUIRED:${role}" >&2
    return 1
  fi
  dev_role_allowed "$role" || { echo "DEV_PROCESS_ROLE_INVALID:${role}" >&2; return 1; }
  local repo_root process_start pid_file temp_file
  repo_root="$(dev_repo_root_canonical "$requested_repo_root")" || return 1
  process_start="$(dev_process_start_identity "$$")" || return 1
  mkdir -p "$XLN_DEV_PID_DIR"
  pid_file="$XLN_DEV_PID_DIR/${role}.pid"
  temp_file="${pid_file}.tmp.$$"
  (umask 077; printf '%s\t%s\t%s\t%s\t%s\n' "$XLN_DEV_OWNER_ID" "$$" "$process_start" "$repo_root" "$role" > "$temp_file")
  if ! ln "$temp_file" "$pid_file" 2>/dev/null; then
    rm -f "$temp_file"
    echo "DEV_PROCESS_ROLE_ALREADY_REGISTERED:${role}" >&2
    return 1
  fi
  rm -f "$temp_file"
}

remove_owned_dev_process_registration() {
  local role="$1" requested_repo_root="$2"
  local pid_file="$XLN_DEV_PID_DIR/${role}.pid"
  [[ -f "$pid_file" ]] || return 0
  local owner_id pid process_start repo_root stored_role extra live_start expected_repo
  if ! IFS=$'\t' read -r owner_id pid process_start repo_root stored_role extra < "$pid_file"; then
    echo "DEV_PROCESS_REGISTRATION_INVALID:${pid_file}" >&2
    return 1
  fi
  expected_repo="$(dev_repo_root_canonical "$requested_repo_root")" || return 1
  live_start="$(dev_process_start_identity "$$")" || return 1
  if [[ "$owner_id" != "$XLN_DEV_OWNER_ID" || "$pid" != "$$" || "$process_start" != "$live_start" \
    || "$repo_root" != "$expected_repo" || "$stored_role" != "$role" || -n "$extra" ]]; then
    echo "DEV_PROCESS_REGISTRATION_MISMATCH:${pid_file}" >&2
    return 1
  fi
  rm -f "$pid_file"
}

signal_owned_dev_record() {
  local signal="$1" record="$2"
  local pid process_start repo_root role
  IFS=$'\t' read -r pid process_start repo_root role <<< "$record"
  kill -0 "$pid" 2>/dev/null || return 0
  assert_owned_dev_process_identity "$pid" "$process_start" "$repo_root" "$role" || return 1
  if ! kill "-$signal" "$pid" 2>/dev/null && kill -0 "$pid" 2>/dev/null; then
    echo "DEV_PROCESS_SIGNAL_FAILED:pid=${pid} signal=${signal}" >&2
    return 1
  fi
}

stop_owned_dev_process_batch() {
  local records=("$@")
  local record pid process_start repo_root role attempts
  for record in "${records[@]}"; do signal_owned_dev_record TERM "$record" || return 1; done
  attempts=50
  while [[ "$attempts" -gt 0 ]]; do
    local remaining=()
    for record in "${records[@]}"; do
      IFS=$'\t' read -r pid process_start repo_root role <<< "$record"
      if kill -0 "$pid" 2>/dev/null; then
        assert_owned_dev_process_identity "$pid" "$process_start" "$repo_root" "$role" || return 1
        remaining+=("$record")
      fi
    done
    [[ "${#remaining[@]}" -eq 0 ]] && return 0
    records=("${remaining[@]}")
    sleep 0.1
    attempts=$((attempts - 1))
  done
  echo "[dev:clean] force-stopping owned dev processes" >&2
  for record in "${records[@]}"; do signal_owned_dev_record KILL "$record" || return 1; done
}

stop_owned_dev_processes() {
  local owner_file="$1" pid_dir="$2" requested_repo_root="$3"
  [[ -f "$owner_file" ]] || return 0
  local expected_owner expected_repo pid_file owner_id pid process_start repo_root role extra
  expected_owner="$(tr -d '\r\n' < "$owner_file")"
  expected_repo="$(dev_repo_root_canonical "$requested_repo_root")" || return 1
  if [[ ! "$expected_owner" =~ ^[0-9a-f]{32}$ ]]; then
    echo "DEV_PROCESS_OWNER_FILE_INVALID:${owner_file}" >&2
    return 1
  fi
  local owned_records=()
  for pid_file in "$pid_dir"/*.pid; do
    [[ -e "$pid_file" ]] || continue
    if ! IFS=$'\t' read -r owner_id pid process_start repo_root role extra < "$pid_file"; then
      echo "DEV_PROCESS_OWNER_RECORD_INVALID:${pid_file}" >&2
      return 1
    fi
    if [[ "$owner_id" != "$expected_owner" || ! "$pid" =~ ^[1-9][0-9]*$ || "$repo_root" != "$expected_repo" \
      || -z "$process_start" || -n "$extra" ]] || ! dev_role_allowed "$role"; then
      echo "DEV_PROCESS_OWNER_MISMATCH:${pid_file}" >&2
      return 1
    fi
    if ! kill -0 "$pid" 2>/dev/null; then rm -f "$pid_file"; continue; fi
    assert_owned_dev_process_identity "$pid" "$process_start" "$repo_root" "$role" || return 1
    owned_records+=("$pid"$'\t'"$process_start"$'\t'"$repo_root"$'\t'"$role")
  done
  [[ "${#owned_records[@]}" -eq 0 ]] && return 0
  echo "[dev:clean] stopping owned dev processes"
  stop_owned_dev_process_batch "${owned_records[@]}"
}
