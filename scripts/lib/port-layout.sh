#!/bin/bash

xln_port_base_enabled() {
  [ -n "${XLN_PORT_BASE:-}" ]
}

xln_port_number() {
  local raw="$1"
  case "$raw" in
    ''|*[!0-9]*)
    echo "[xln-port-layout] invalid port: $raw" >&2
    return 1
    ;;
  esac
  printf '%s' "$raw"
}

xln_derived_port() {
  local legacy="$1"
  local offset="$2"
  if xln_port_base_enabled; then
    local base
    base="$(xln_port_number "$XLN_PORT_BASE")" || return 1
    printf '%s' "$((base + offset))"
    return 0
  fi
  xln_port_number "$legacy"
}

xln_rpc_port() {
  xln_derived_port 8545 0
}

xln_api_port() {
  xln_derived_port 8082 2
}

xln_web_port() {
  xln_derived_port 8080 4
}

xln_custody_port() {
  xln_derived_port 8087 7
}

xln_custody_daemon_port() {
  xln_derived_port 8088 8
}
