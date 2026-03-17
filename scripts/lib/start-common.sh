#!/bin/bash

xln_kill_by_port() {
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
  mkdir -p "$(dirname "$jurisdictions_path")"
  if [ ! -f "$jurisdictions_path" ]; then
    cp /root/xln/jurisdictions/jurisdictions.json "$jurisdictions_path"
  fi
}
