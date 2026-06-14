#!/bin/bash
# Read-only production health diagnostic. It checks the infra pieces that make
# cross-j swaps possible and prints actionable logs when a gate is red.

set -euo pipefail

REMOTE="${1:-${XLN_PROD_SSH:-root@xln.finance}}"
PUBLIC_URL="${XLN_PROD_URL:-https://xln.finance}"

if [ "$REMOTE" = "--help" ] || [ "$REMOTE" = "-h" ]; then
  echo "Usage: $0 [ssh-host]"
  echo "Default ssh-host: root@xln.finance or XLN_PROD_SSH"
  exit 0
fi

ssh "$REMOTE" "XLN_PROD_URL='$PUBLIC_URL' bash -s" <<'REMOTE_SCRIPT'
set -uo pipefail

PUBLIC_URL="${XLN_PROD_URL:-https://xln.finance}"
REPO_ROOT="${XLN_PROD_REPO_ROOT:-/root/xln}"
failures=0
failed_processes=()

section() {
  printf '\n== %s ==\n' "$1"
}

ok() {
  printf '[ok] %s\n' "$1"
}

fail() {
  printf '[fail] %s\n' "$1"
  failures=$((failures + 1))
}

remember_process() {
  local name="$1"
  for existing in "${failed_processes[@]}"; do
    [ "$existing" = "$name" ] && return 0
  done
  failed_processes+=("$name")
}

check_pm2_process() {
  local name="$1"
  if ! command -v pm2 >/dev/null 2>&1; then
    fail "pm2 is not installed"
    return 1
  fi
  if pm2 jlist 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const name = process.argv[1];
      const list = JSON.parse(input || "[]");
      const proc = list.find((entry) => entry.name === name);
      if (!proc) process.exit(2);
      process.exit(proc.pm2_env?.status === "online" ? 0 : 1);
    });
  ' "$name"; then
    ok "pm2 $name online"
  else
    fail "pm2 $name is missing or not online"
    remember_process "$name"
  fi
}

check_port() {
  local port="$1"
  local label="$2"
  local owner="${3:-}"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(:|\\])${port}$"; then
      ok "$label listens on :$port"
    else
      fail "$label is not listening on :$port"
      [ -n "$owner" ] && remember_process "$owner"
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -ti TCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      ok "$label listens on :$port"
    else
      fail "$label is not listening on :$port"
      [ -n "$owner" ] && remember_process "$owner"
    fi
  else
    fail "neither ss nor lsof is available for port checks"
  fi
}

check_rpc_chain() {
  local url="$1"
  local expected="$2"
  local label="$3"
  local owner="${4:-}"
  local body
  body="$(curl -sS -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
    "$url" 2>/dev/null || true)"
  if printf '%s' "$body" | grep -q "\"result\":\"$expected\""; then
    ok "$label chainId $expected"
  else
    fail "$label chainId mismatch or RPC unavailable; got: ${body:-<empty>}"
    [ -n "$owner" ] && remember_process "$owner"
  fi
}

check_watchtower() {
  local url="$1"
  local body
  body="$(curl -fsS "$url" 2>/dev/null || true)"
  if [ -z "$body" ]; then
    fail "watchtower health unavailable at $url"
    remember_process "xln-watchtower"
    return 0
  fi
  if node -e '
    const payload = JSON.parse(process.argv[1]);
    process.exit(payload?.ok === true && payload?.service === "xln-watchtower" && typeof payload?.towerId === "string" ? 0 : 1);
  ' "$body"; then
    ok "watchtower health green"
  else
    fail "watchtower health red: $body"
    remember_process "xln-watchtower"
  fi
}

check_jurisdictions() {
  local file="$REPO_ROOT/db/runtime/prod-mesh/jurisdictions.json"
  if [ ! -f "$file" ]; then
    fail "jurisdictions file missing: $file"
    return 0
  fi
  if node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    const jurisdictions = payload.jurisdictions || payload;
    const testnet = jurisdictions.testnet || jurisdictions.Testnet;
    const tron = jurisdictions.tron || jurisdictions.Tron;
    const testnetOk = !!testnet && Number(testnet.chainId ?? testnet.chainID ?? 31337) === 31337;
    const tronOk = !!tron && Number(tron.chainId ?? tron.chainID) === 31338;
    process.exit(testnetOk && tronOk ? 0 : 1);
  ' "$file"; then
    ok "jurisdictions contain Testnet and Tron"
  else
    fail "jurisdictions do not contain expected Testnet/Tron chain ids"
  fi
}

check_health() {
  local url="$1"
  local label="$2"
  local body
  body="$(curl -fsS "$url" 2>/dev/null || true)"
  if [ -z "$body" ]; then
    fail "$label health unavailable at $url"
    remember_process "xln-server"
    return 0
  fi
  node -e '
    const label = process.argv[1];
    const payload = JSON.parse(process.argv[2]);
    const failures = [];
    const hubs = Array.isArray(payload.hubs) ? payload.hubs : [];
    const cross = payload.marketMaker?.cross || {};
    if (payload.coreOk !== true) failures.push("coreOk=false");
    if (payload.systemOk !== true) failures.push("systemOk=false");
    if (payload.system?.runtime !== true) failures.push("runtime=false");
    if (payload.system?.relay !== true) failures.push("relay=false");
    if (payload.hubMesh?.ok !== true) failures.push("hubMesh.ok=false");
    if (payload.marketMaker?.ok !== true) failures.push("marketMaker.ok=false");
    if (payload.bootstrapReserves?.ok !== true) failures.push("bootstrapReserves.ok=false");
    if (payload.custody?.ok !== true) failures.push("custody.ok=false");
    if (hubs.length < 3) failures.push(`hubs.length=${hubs.length}`);
    for (const hub of hubs) {
      if (hub.online !== true) failures.push(`${hub.name || hub.runtimeId || "hub"}.online=false`);
      if (hub.selfRelayPresence !== true) failures.push(`${hub.name || hub.runtimeId || "hub"}.selfRelayPresence=false`);
    }
    if (payload.marketMaker?.startupPhase && payload.marketMaker.startupPhase !== "ready") {
      failures.push(`marketMaker.phase=${payload.marketMaker.startupPhase}`);
    }
    if (cross.applicable === false) failures.push("cross.applicable=false");
    if (!(Number(cross.expectedRoutes) > 0)) failures.push(`cross.expectedRoutes=${cross.expectedRoutes ?? "<missing>"}`);
    if (cross.ok !== true) failures.push("cross.ok=false");
    const summary = {
      coreOk: payload.coreOk,
      systemOk: payload.systemOk,
      degraded: payload.degraded,
      relay: payload.system?.relay,
      hubMesh: payload.hubMesh?.ok,
      marketMaker: {
        ok: payload.marketMaker?.ok,
        phase: payload.marketMaker?.startupPhase,
        cross,
      },
      hubs: hubs.map((hub) => ({
        name: hub.name,
        online: hub.online,
        selfRelayPresence: hub.selfRelayPresence,
        jurisdictionName: hub.jurisdictionName,
      })),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length) {
      console.error(`${label} health failed: ${failures.join(", ")}`);
      process.exit(1);
    }
  ' "$label" "$body"
  local status=$?
  if [ "$status" -eq 0 ]; then
    ok "$label health green"
  else
    fail "$label health red"
    remember_process "xln-server"
  fi
}

check_public_ws() {
  local url="$1"
  local label="$2"
  if ! command -v bun >/dev/null 2>&1; then
    fail "bun is not installed; cannot check $label websocket"
    return 0
  fi
  if bun -e '
    const url = process.argv[1];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      process.exit(1);
    }, 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      process.exit(0);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      process.exit(1);
    };
  ' "$url" >/dev/null 2>&1; then
    ok "$label websocket reachable"
  else
    fail "$label websocket unreachable at $url"
  fi
}

section "processes"
check_pm2_process "anvil"
check_pm2_process "anvil2"
check_pm2_process "xln-server"
check_pm2_process "xln-watchtower"

section "ports"
check_port 8545 "Testnet RPC" "anvil"
check_port 8546 "Tron RPC" "anvil2"
check_port 8080 "orchestrator" "xln-server"
check_port 9100 "watchtower" "xln-watchtower"
check_port 8087 "custody" "xln-server"
check_port 8088 "custody daemon" "xln-server"

section "rpc"
check_rpc_chain "http://127.0.0.1:8545" "0x7a69" "Testnet RPC" "anvil"
check_rpc_chain "http://127.0.0.1:8546" "0x7a6a" "Tron RPC" "anvil2"

section "state"
check_jurisdictions

section "health"
check_health "http://127.0.0.1:8080/api/health" "local"
check_watchtower "http://127.0.0.1:9100/api/tower/healthz"
check_health "$PUBLIC_URL/api/health" "public"

section "public direct mesh"
check_public_ws "wss://xln.finance:8090/ws" "orchestrator"
check_public_ws "wss://xln.finance:8091/ws" "H1"
check_public_ws "wss://xln.finance:8092/ws" "H2"
check_public_ws "wss://xln.finance:8093/ws" "H3"

if [ "$failures" -gt 0 ]; then
  section "recent logs"
  for proc in "${failed_processes[@]}"; do
    echo "-- pm2 logs $proc --"
    pm2 logs "$proc" --lines 120 --nostream 2>/dev/null || true
  done
  echo
  echo "prod diagnose failed with $failures issue(s)"
  exit 1
fi

echo
echo "prod diagnose passed"
REMOTE_SCRIPT
