#!/bin/bash

read_dev_process_start_identity() {
  local pid="$1"
  local identity
  if ! identity="$(LC_ALL=C ps -ww -p "$pid" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"; then
    return 1
  fi
  if [[ -z "$identity" || "$identity" == *$'\t'* || "$identity" == *$'\n'* ]]; then
    return 1
  fi
  printf '%s' "$identity"
}

dev_process_start_identity() {
  local pid="$1"
  local identity
  if ! identity="$(read_dev_process_start_identity "$pid")"; then
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
  if ! live_start="$(read_dev_process_start_identity "$pid")"; then
    # The process may exit between kill -0 and ps. That is successful cleanup,
    # not an ownership failure. A still-live process without a provable start
    # identity remains a hard stop so cleanup can never signal a foreign PID.
    if ! kill -0 "$pid" 2>/dev/null; then
      return 3
    fi
    echo "DEV_PROCESS_START_IDENTITY_UNAVAILABLE:pid=${pid}" >&2
    return 1
  fi
  if [[ "$live_start" != "$expected_start" ]]; then
    echo "DEV_PROCESS_START_IDENTITY_MISMATCH:pid=${pid} expected=${expected_start} actual=${live_start}" >&2
    return 1
  fi
  if ! command_line="$(LC_ALL=C ps -ww -p "$pid" -o command= 2>/dev/null)" || [[ -z "$command_line" ]]; then
    if ! kill -0 "$pid" 2>/dev/null; then
      return 3
    fi
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
  local identity_status
  if assert_owned_dev_process_identity "$pid" "$process_start" "$repo_root" "$role"; then
    identity_status=0
  else
    identity_status=$?
  fi
  [[ "$identity_status" -eq 3 ]] && return 0
  [[ "$identity_status" -eq 0 ]] || return "$identity_status"
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
        local identity_status
        if assert_owned_dev_process_identity "$pid" "$process_start" "$repo_root" "$role"; then
          remaining+=("$record")
        else
          identity_status=$?
          [[ "$identity_status" -eq 3 ]] || return "$identity_status"
        fi
      fi
    done
    [[ "${#remaining[@]}" -eq 0 ]] && return 0
    records=("${remaining[@]}")
    sleep 0.1
    attempts=$((attempts - 1))
  done
  echo "[dev:clean] force-stopping owned dev processes" >&2
  for record in "${records[@]}"; do signal_owned_dev_record KILL "$record" || return 1; done
  attempts=20
  while [[ "$attempts" -gt 0 ]]; do
    local live_count=0
    for record in "${records[@]}"; do
      IFS=$'\t' read -r pid process_start repo_root role <<< "$record"
      kill -0 "$pid" 2>/dev/null && live_count=$((live_count + 1))
    done
    [[ "$live_count" -eq 0 ]] && return 0
    sleep 0.1
    attempts=$((attempts - 1))
  done
  echo "DEV_PROCESS_FORCE_STOP_TIMEOUT:count=${#records[@]}" >&2
  return 1
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
    local identity_status
    if assert_owned_dev_process_identity "$pid" "$process_start" "$repo_root" "$role"; then
      identity_status=0
    else
      identity_status=$?
    fi
    if [[ "$identity_status" -eq 3 ]]; then
      rm -f "$pid_file"
      continue
    fi
    [[ "$identity_status" -eq 0 ]] || return "$identity_status"
    owned_records+=("$pid"$'\t'"$process_start"$'\t'"$repo_root"$'\t'"$role")
  done
  [[ "${#owned_records[@]}" -eq 0 ]] && return 0
  echo "[dev:clean] stopping owned dev processes"
  stop_owned_dev_process_batch "${owned_records[@]}"
}

dev_single_line() {
  tr '\t\r\n' '   ' | sed -e 's/[[:space:]][[:space:]]*/ /g' -e 's/^ //' -e 's/ $//'
}

describe_dev_port_listener() {
  local port="$1" pid="$2" pid_dir="$3"
  local ppid pgid process_start cwd command ownership pid_file
  ppid="$(LC_ALL=C ps -p "$pid" -o ppid= 2>/dev/null | dev_single_line || true)"
  pgid="$(LC_ALL=C ps -p "$pid" -o pgid= 2>/dev/null | dev_single_line || true)"
  process_start="$(read_dev_process_start_identity "$pid" 2>/dev/null || printf 'unavailable')"
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | dev_single_line || true)"
  command="$(LC_ALL=C ps -ww -p "$pid" -o command= 2>/dev/null | dev_single_line || true)"
  ownership='none'
  for pid_file in "$pid_dir"/*.pid; do
    [[ -e "$pid_file" ]] || continue
    local owner_id stored_pid stored_start repo_root role extra
    IFS=$'\t' read -r owner_id stored_pid stored_start repo_root role extra < "$pid_file" || continue
    if [[ "$stored_pid" == "$pid" ]]; then
      ownership="role=${role},record=$(basename "$pid_file")"
      break
    fi
  done
  echo "DEV_PORT_BUSY_PROCESS:port=${port} pid=${pid} ppid=${ppid:-unavailable} pgid=${pgid:-unavailable} start=${process_start} cwd=${cwd:-unavailable} ownership=${ownership} command=${command:-unavailable}" >&2
}
