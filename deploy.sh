#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

REMOTE_HOST=""
PUSH=0
FRESH=0
BUILD_FRONTEND=1
FRONTEND_ONLY=0
PRODUCTION=0
RESET_PRODUCTION_MESH=0
PREBUILT_FRONTEND_ARCHIVE=""

cleanup_local_deploy_artifacts() {
  if [ -n "$PREBUILT_FRONTEND_ARCHIVE" ]; then
    rm -f "$PREBUILT_FRONTEND_ARCHIVE"
  fi
}

trap cleanup_local_deploy_artifacts EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --remote)
      REMOTE_HOST="${2:-}"
      shift 2
      ;;
    --push)
      PUSH=1
      shift
      ;;
    --fresh)
      FRESH=1
      shift
      ;;
    --frontend)
      BUILD_FRONTEND=1
      shift
      ;;
    --frontend-only)
      BUILD_FRONTEND=1
      FRONTEND_ONLY=1
      shift
      ;;
    --runtime-only)
      BUILD_FRONTEND=0
      shift
      ;;
    --production)
      PRODUCTION=1
      shift
      ;;
    --reset-mesh)
      RESET_PRODUCTION_MESH=1
      shift
      ;;
    --code-only)
      RESET_PRODUCTION_MESH=0
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: ./deploy.sh [--remote host] [--push] [--fresh] [--frontend|--frontend-only|--runtime-only] [--production] [--code-only|--reset-mesh]" >&2
      exit 1
      ;;
  esac
done

if [ "$FRONTEND_ONLY" = "1" ] && [ -z "$REMOTE_HOST" ]; then
  echo "FRONTEND_ONLY_REQUIRES_REMOTE" >&2
  exit 1
fi

ensure_main_branch_for_push() {
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != "main" ]; then
    echo "Refusing --push from branch '$branch'. Switch to main first." >&2
    exit 1
  fi
}

ensure_clean_worktree_for_push() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Refusing --push with uncommitted tracked changes. Commit or stash them first." >&2
    exit 1
  fi
  if [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "Refusing --push with untracked files. Commit, ignore, or remove them first." >&2
    exit 1
  fi
}

build_remote_frontend_archive() {
  local deploy_build_number
  deploy_build_number="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)"
  echo "[deploy] building production frontend locally: $deploy_build_number"
  bun install --frozen-lockfile
  ./scripts/sync-contract-artifacts.sh
  ./scripts/build-runtime.sh
  (
    cd frontend
    bun install --frozen-lockfile
    XLN_BUILD_NUMBER="$deploy_build_number" bun run build
  )
  PREBUILT_FRONTEND_ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/xln-frontend-build.XXXXXX.tar.gz")"
  COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C frontend -czf "$PREBUILT_FRONTEND_ARCHIVE" build
}

wait_for_rpc_chain() {
  local rpc_url="$1"
  local expected_chain_hex="$2"
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body
    body="$(curl --max-time 10 -sS -X POST -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
      "$rpc_url" || true)"
    if printf '%s' "$body" | grep -q "\"result\":\"$expected_chain_hex\""; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_anvil_state_checkpoint() {
  local state_file="$1"
  local deadline=$((SECONDS + 120))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -s "$state_file" ] && bun -e 'JSON.parse(await Bun.file(process.argv[1]).text())' "$state_file" >/dev/null 2>&1; then
      echo "[deploy] durable Anvil checkpoint ready: $state_file"
      return 0
    fi
    sleep 2
  done
  echo "ANVIL_STATE_CHECKPOINT_TIMEOUT:file=${state_file}" >&2
  return 1
}

ensure_production_foundry() {
  local expected_version="${XLN_FOUNDRY_VERSION:-v1.7.1}"
  local expected_number="${expected_version#v}"
  export PATH="$HOME/.foundry/bin:$PATH"

  if anvil --version 2>/dev/null | head -1 | grep -Fq "Version: ${expected_number}"; then
    echo "[deploy] Foundry already pinned at ${expected_version}"
    return 0
  fi
  if ! command -v foundryup >/dev/null 2>&1; then
    echo "FOUNDRYUP_MISSING:expected=${expected_version}" >&2
    return 1
  fi

  if command -v pm2 >/dev/null 2>&1; then
    for service in anvil anvil2; do
      local service_pid
      service_pid="$(pm2 pid "$service" 2>/dev/null | tail -1 | tr -d '[:space:]')"
      if [[ "$service_pid" =~ ^[1-9][0-9]*$ ]]; then
        echo "[deploy] stopping ${service} pid=${service_pid} for Foundry upgrade"
        pm2 stop "$service" >/dev/null
        local stop_deadline=$((SECONDS + 60))
        while kill -0 "$service_pid" 2>/dev/null && [ "$SECONDS" -lt "$stop_deadline" ]; do
          sleep 1
        done
        if kill -0 "$service_pid" 2>/dev/null; then
          echo "FOUNDRY_UPGRADE_ANVIL_STOP_TIMEOUT:service=${service}:pid=${service_pid}" >&2
          return 1
        fi
      fi
    done
  fi

  echo "[deploy] upgrading Foundry to immutable release ${expected_version}"
  foundryup --install "$expected_version"
  hash -r
  for binary in anvil cast forge; do
    if ! "$binary" --version 2>/dev/null | head -1 | grep -Fq "${expected_number}"; then
      echo "FOUNDRY_VERSION_MISMATCH:binary=${binary}:expected=${expected_version}" >&2
      return 1
    fi
  done
  echo "[deploy] Foundry verified at ${expected_version}"
}

wait_for_public_rpc_chain() {
  local path="$1"
  local expected_chain_hex="$2"
  local deadline="$3"
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body
    body="$(curl --max-time 10 -ksS -X POST -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
      "https://xln.finance${path}" || true)"
    if printf '%s' "$body" | grep -q "\"result\":\"$expected_chain_hex\""; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_public_rpc_placeholder() {
  local path="$1"
  local deadline="$2"
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body
    local status
    body="$(curl --max-time 10 -ksS -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
      "https://xln.finance${path}" || true)"
    status="$(printf '%s' "$body" | tail -1)"
    body="$(printf '%s' "$body" | sed '$d')"
    if [ "$status" = "503" ] && printf '%s' "$body" | grep -q 'RPC upstream is not configured'; then
      return 0
    fi
    if [ "$status" = "200" ] && printf '%s' "$body" | grep -q '"result"'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_main_stack() {
  bun scripts/watch-prod-bootstrap.ts http://127.0.0.1:8080/api/health 0
}

wait_for_http_status() {
  local url="$1"
  local expected_status="$2"
  local deadline="$3"
  while [ "$SECONDS" -lt "$deadline" ]; do
    local status
    status="$(curl --max-time 10 -ksS -o /dev/null -w '%{http_code}' "$url" || true)"
    if [ "$status" = "$expected_status" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_http_content_type() {
  local url="$1"
  local expected_substring="$2"
  local deadline="$3"
  while [ "$SECONDS" -lt "$deadline" ]; do
    local headers
    headers="$(curl --max-time 10 -ksSI "$url" || true)"
    if printf '%s' "$headers" | grep -iq "^content-type: .*${expected_substring}"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_public_ws() {
  local ws_url="$1"
  local deadline="$2"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if bun -e "
      const url = process.argv[1];
      const timeoutMs = 5000;
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        process.exit(1);
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        process.exit(0);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        process.exit(1);
      };
    " "$ws_url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_public_direct_mesh() {
  local deadline=$((SECONDS + 120))
  local endpoints=(
    "wss://xln.finance:8090/ws"
    "wss://xln.finance:8091/ws"
    "wss://xln.finance:8092/ws"
    "wss://xln.finance:8093/ws"
  )
  for endpoint in "${endpoints[@]}"; do
    if ! wait_for_public_ws "$endpoint" "$deadline"; then
      echo "[deploy] public direct ws not reachable: $endpoint" >&2
      return 1
    fi
  done
  return 0
}

wait_for_public_production_stack() {
  local deadline=$((SECONDS + 300))
  wait_for_http_json_field \
    "https://xln.finance/api/health" \
    "return payload?.coreOk === true && payload?.systemOk === true && payload?.system?.runtime === true && payload?.system?.relay === true && payload?.hubMesh?.ok === true && payload?.marketMaker?.ok === true && payload?.bootstrapReserves?.ok === true && payload?.custody?.ok === true && Array.isArray(payload?.hubs) && payload.hubs.length >= 3;" \
    "$deadline" \
    || return 1

  wait_for_http_status "https://xln.finance/" "200" "$deadline" || return 1
  wait_for_http_status "https://xln.finance/app" "200" "$deadline" || return 1
  wait_for_http_content_type "https://xln.finance/app" "text/html" "$deadline" || return 1
  wait_for_http_json_field \
    "https://xln.finance/api/tower/healthz" \
    "return payload?.ok === true && payload?.service === 'xln-watchtower' && typeof payload?.towerId === 'string' && payload.towerId.length > 0;" \
    "$deadline" \
    || return 1
  wait_for_public_rpc_chain "/rpc" "0x7a69" "$deadline" || return 1
  wait_for_public_rpc_chain "/rpc2" "0x7a6a" "$deadline" || return 1
  for rpc_index in 3 4 5 6 7 8; do
    wait_for_public_rpc_placeholder "/rpc${rpc_index}" "$deadline" || return 1
  done
  return 0
}

wait_for_watchtower() {
  local deadline=$((SECONDS + 120))
  wait_for_http_json_field \
    "http://127.0.0.1:9100/api/tower/healthz" \
    "return payload?.ok === true && payload?.service === 'xln-watchtower' && typeof payload?.towerId === 'string' && payload.towerId.length > 0;" \
    "$deadline"
}

wait_for_http_json_field() {
  local url="$1"
  local js_expr="$2"
  local deadline="$3"
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body
    body="$(curl --max-time 10 -fsS "$url" || true)"
    if [ -n "$body" ] && node -e "
      const payload = JSON.parse(process.argv[1]);
      const ok = (() => { ${js_expr} })();
      process.exit(ok ? 0 : 1);
    " "$body"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_http_json_field_insecure() {
  local url="$1"
  local js_expr="$2"
  local deadline="$3"
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body
    body="$(curl --max-time 10 -kfsS "$url" || true)"
    if [ -n "$body" ] && node -e "
      const payload = JSON.parse(process.argv[1]);
      const ok = (() => { ${js_expr} })();
      process.exit(ok ? 0 : 1);
    " "$body"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_custody() {
  local deadline=$((SECONDS + 240))
  wait_for_http_json_field \
    "http://127.0.0.1:8080/api/health" \
    "return payload?.custody?.ok === true;" \
    "$deadline" \
    || return 1

  wait_for_http_json_field \
    "http://127.0.0.1:8087/api/me" \
    "return typeof payload?.custody?.entityId === 'string' && payload.custody.entityId.length > 0;" \
    "$deadline"
}

ensure_production_nginx_site_consistency() {
  local available="/etc/nginx/sites-available/xln"
  local enabled="/etc/nginx/sites-enabled/xln"

  [ -f "$available" ] || {
    echo "[deploy] missing nginx site: $available" >&2
    return 1
  }

  rm -f "$enabled"
  ln -s "$available" "$enabled"

  if ! grep -q 'location = /resetdb {' "$available"; then
    python3 - "$available" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
marker = """    location = /app {
        root /root/xln/frontend/build;
        try_files /index.html =404;
        default_type text/html;
        add_header Content-Security-Policy "frame-ancestors 'self' https://xln.finance https://app.xln.finance https://custody.xln.finance https://localhost:* http://localhost:*" always;
    }

"""
block = """    location = /resetdb {
        default_type text/plain;
        add_header Cache-Control "no-store, max-age=0" always;
        add_header Clear-Site-Data '"*"' always;
        add_header Refresh "0;url=/app" always;
        return 200 "Resetting local data";
    }

"""
if marker in text:
    text = text.replace(marker, marker + block, 1)
    path.write_text(text)
PY
  fi

  if ! grep -q 'location /api/tower/' "$available"; then
    python3 - "$available" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
marker = "    location /api/ {\n"
block = """    location /api/tower/ {
        proxy_pass http://127.0.0.1:9100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

"""
if marker in text and "location /api/tower/" not in text:
    text = text.replace(marker, block + marker, 1)
    path.write_text(text)
PY
  fi

  if ! grep -q 'location /api/recovery/' "$available"; then
    python3 - "$available" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
marker = "    location /api/ {\n"
block = """    location /api/recovery/ {
        proxy_pass http://127.0.0.1:9100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

"""
if marker in text and "location /api/recovery/" not in text:
    text = text.replace(marker, block + marker, 1)
    path.write_text(text)
PY
  fi

  python3 - "$available" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
common_headers = """        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
"""
primary = f"""    location = /rpc {{
        proxy_pass http://127.0.0.1:8080;
{common_headers}    }}
"""
extra = f"""
    location ~ ^/rpc[2-8]$ {{
        proxy_pass http://127.0.0.1:8080;
{common_headers}    }}
"""
if re.search(r"\n    location = /rpc \{\n(?:        .*\n)*?    \}\n", text):
    text = re.sub(r"\n    location = /rpc \{\n(?:        .*\n)*?    \}\n", "\n" + primary, text, count=1)
elif "    location /api/ {\n" in text:
    text = text.replace("    location /api/ {\n", primary + "\n    location /api/ {\n", 1)

if "location ~ ^/rpc[2-8]$" not in text:
    marker = primary
    if marker in text:
        text = text.replace(marker, marker + extra, 1)
    elif "    location /api/ {\n" in text:
        text = text.replace("    location /api/ {\n", extra + "\n    location /api/ {\n", 1)

path.write_text(text)
PY

  python3 - "$available" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = re.sub(r"\n    location /api/watchtower/ \{\n(?:        .*\n)*?    \}\n", "\n", text)
path.write_text(text)
PY

  # Route custody.xln.finance/rpc to the custody radapter daemon (:8088) so the wallet can connect
  # to the custody runtime. Idempotent: only injects when the /rpc upstream is missing.
  if ! grep -q 'proxy_pass http://127.0.0.1:8088;' "$available"; then
    python3 - "$available" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
anchor = "    server_name custody.xln.finance;"
idx = text.find(anchor)
if idx != -1:
    loc = text.find("    location / {", idx)
    if loc != -1:
        block = (
            "    location /rpc {\n"
            "        proxy_pass http://127.0.0.1:8088;\n"
            "        proxy_http_version 1.1;\n"
            "        proxy_set_header Upgrade $http_upgrade;\n"
            "        proxy_set_header Connection upgrade;\n"
            "        proxy_set_header Host $host;\n"
            "        proxy_set_header X-Real-IP $remote_addr;\n"
            "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
            "        proxy_set_header X-Forwarded-Proto $scheme;\n"
            "        proxy_read_timeout 300s;\n"
            "        proxy_connect_timeout 75s;\n"
            "    }\n\n"
        )
        text = text[:loc] + block + text[loc:]
        path.write_text(text)
PY
  fi

  if grep -q 'proxy_pass https://127.0.0.1:8087;' "$available"; then
    echo "[deploy] invalid custody upstream scheme in nginx config: expected http://127.0.0.1:8087" >&2
    return 1
  fi

  if ! grep -q 'proxy_pass http://127.0.0.1:8088;' "$available"; then
    echo "[deploy] custody /rpc daemon upstream missing from nginx config" >&2
    return 1
  fi

  if ! grep -q 'proxy_pass http://127.0.0.1:8087;' "$available"; then
    echo "[deploy] custody upstream missing from nginx config" >&2
    return 1
  fi

  if grep -q 'proxy_pass http://127.0.0.1:8545' "$available"; then
    echo "[deploy] public /rpc must proxy through orchestrator safety filter, not directly to anvil" >&2
    return 1
  fi

  if ! grep -q 'location ~ \^/rpc\[2-8\]\$' "$available"; then
    echo "[deploy] /rpc2-/rpc8 public proxy block missing from nginx config" >&2
    return 1
  fi

  if grep -q 'return 301 https://$server_name$request_uri;' "$available"; then
    echo "[deploy] invalid HTTP redirect target in nginx config: expected \$host, found \$server_name" >&2
    return 1
  fi

  if ! grep -q 'return 301 https://$host$request_uri;' "$available"; then
    echo "[deploy] HTTP redirect host rule missing from nginx config" >&2
    return 1
  fi

  if ! grep -q 'location = /resetdb {' "$available"; then
    echo "[deploy] /resetdb location missing from nginx config" >&2
    return 1
  fi

  if ! grep -Fq "add_header Clear-Site-Data '\"*\"' always;" "$available"; then
    echo "[deploy] Clear-Site-Data header missing from /resetdb nginx config" >&2
    return 1
  fi

  nginx -t
  systemctl reload nginx

  local resetdb_headers=""
  local resetdb_header_ok=0
  for _attempt in 1 2 3 4 5; do
    resetdb_headers="$(curl -ksSI --max-time 10 'https://xln.finance/resetdb?returnTo=%2Fapp' | tr -d '\r' || true)"
    if printf '%s\n' "$resetdb_headers" | grep -iq '^clear-site-data: "\*"$'; then
      resetdb_header_ok=1
      break
    fi
    sleep 1
  done
  if [ "$resetdb_header_ok" != "1" ]; then
    echo "[deploy] /resetdb Clear-Site-Data header not visible on public endpoint" >&2
    printf '%s\n' "$resetdb_headers" >&2
    return 1
  fi
}

pretty_print_json() {
  node -e '
    const raw = process.argv[1] || "";
    try {
      console.log(JSON.stringify(JSON.parse(raw), null, 2));
    } catch {
      console.log(raw);
    }
  ' "${1:-}"
}

debug_dump_http_json() {
  local label="$1"
  local url="$2"
  local body

  echo "[deploy][debug] ${label}: ${url}"
  body="$(curl -ksS --max-time 10 "$url" || true)"
  if [ -z "$body" ]; then
    echo "[deploy][debug] ${label} unavailable"
    return 0
  fi
  pretty_print_json "$body"
}

debug_dump_http_head() {
  local label="$1"
  local url="$2"

  echo "[deploy][debug] ${label}: ${url}"
  curl -ksSI --max-time 10 "$url" || echo "[deploy][debug] ${label} unavailable"
}

debug_dump_ports() {
  echo "[deploy][debug] listening ports"
  lsof -nP \
    -iTCP:8545 \
    -iTCP:8546 \
    -iTCP:8080 \
    -iTCP:9100 \
    -iTCP:8087 \
    -iTCP:8088 \
    -iTCP:18090 \
    -iTCP:18091 \
    -iTCP:18092 \
    -iTCP:18093 \
    -sTCP:LISTEN 2>/dev/null || true
}

debug_dump_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    return 0
  fi

  echo "[deploy][debug] pm2 list"
  pm2 ls || true
  echo "[deploy][debug] pm2 describe xln-server"
  pm2 describe xln-server || true
  echo "[deploy][debug] pm2 describe anvil"
  pm2 describe anvil || true
  echo "[deploy][debug] pm2 describe anvil2"
  pm2 describe anvil2 || true
}

debug_dump_runtime_logs() {
  if ! command -v pm2 >/dev/null 2>&1; then
    return 0
  fi

  echo "[deploy][debug] pm2 logs xln-server"
  pm2 logs xln-server --lines 200 --nostream || true
  echo "[deploy][debug] pm2 logs anvil"
  pm2 logs anvil --lines 120 --nostream || true
  echo "[deploy][debug] pm2 logs anvil2"
  pm2 logs anvil2 --lines 120 --nostream || true
}

debug_dump_nginx() {
  if command -v nginx >/dev/null 2>&1; then
    echo "[deploy][debug] nginx -t"
    nginx -t || true
  fi

  if command -v systemctl >/dev/null 2>&1; then
    echo "[deploy][debug] systemctl status nginx"
    systemctl status nginx --no-pager --lines 60 || true
  fi
}

dump_production_debug_snapshot() {
  echo "[deploy][debug] ===== production debug snapshot ====="
  debug_dump_http_json "local main health" "http://127.0.0.1:8080/api/health"
  debug_dump_http_json "local main info" "http://127.0.0.1:8080/api/info"
  debug_dump_http_json "local watchtower health" "http://127.0.0.1:9100/api/tower/healthz"
  debug_dump_http_json "local custody daemon health" "http://127.0.0.1:8088/api/health"
  debug_dump_http_json "local custody me" "http://127.0.0.1:8087/api/me"
  debug_dump_http_json "public health" "https://xln.finance/api/health"
  debug_dump_http_head "public root" "https://xln.finance/"
  debug_dump_http_head "public app" "https://xln.finance/app"
  debug_dump_ports
  debug_dump_pm2
  debug_dump_runtime_logs
  debug_dump_nginx
  echo "[deploy][debug] ===== end production debug snapshot ====="
}

fail_deploy_with_debug() {
  local reason="$1"
  echo "[deploy] ${reason}" >&2
  dump_production_debug_snapshot >&2
  exit 1
}

run_or_fail_deploy() {
  local reason="$1"
  shift
  if ! "$@"; then
    fail_deploy_with_debug "$reason"
  fi
}

ensure_production_direct_hub_ports() {
  cat > /etc/nginx/conf.d/xln-direct-ports.conf <<'EOF'
server {
  listen 8090 ssl http2;
  server_name xln.finance;
  ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:18090;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;
  }
}

server {
  listen 8091 ssl http2;
  server_name xln.finance;
  ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:18091;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;
  }
}

server {
  listen 8092 ssl http2;
  server_name xln.finance;
  ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:18092;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;
  }
}

server {
  listen 8093 ssl http2;
  server_name xln.finance;
  ssl_certificate /etc/letsencrypt/live/xln.finance/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/xln.finance/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:18093;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;
  }
}
EOF

  if command -v ufw >/dev/null 2>&1; then
    ufw allow 8090:8093/tcp >/dev/null 2>&1 || true
  fi

  nginx -t
  systemctl reload nginx
}

ensure_production_host_hygiene() {
  echo "[deploy] enforcing production log and memory hygiene"

  install -d -m 700 /var/lib/xln /var/lib/xln/jdb /var/lib/xln/jdb/tmp /var/lib/xln/rdb
  ensure_production_foundry

  if command -v crontab >/dev/null 2>&1; then
    crontab -l 2>/dev/null | grep -v '/root/xln/auto-redeploy.sh' | crontab - 2>/dev/null || true
  fi

  mkdir -p /etc/systemd/journald.conf.d
  cat > /etc/systemd/journald.conf.d/xln-limits.conf <<'EOF'
[Journal]
SystemMaxUse=200M
RuntimeMaxUse=64M
SystemKeepFree=1G
RuntimeKeepFree=32M
MaxFileSec=7day
EOF

  systemctl restart systemd-journald || true
  journalctl --vacuum-size=200M || true

  if command -v pm2 >/dev/null 2>&1; then
    if ! pm2 ls --no-color 2>/dev/null | grep -q 'pm2-logrotate'; then
      pm2 install pm2-logrotate
    fi
    pm2 set pm2-logrotate:max_size 20M >/dev/null
    pm2 set pm2-logrotate:retain 5 >/dev/null
    pm2 set pm2-logrotate:compress true >/dev/null
    pm2 set pm2-logrotate:workerInterval 900 >/dev/null
    pm2 set pm2-logrotate:rotateInterval '0 0 * * *' >/dev/null
    pm2 set pm2-logrotate:rotateModule true >/dev/null
  fi

  install -d /etc/cron.hourly
  cat > /etc/cron.hourly/xln-log-hygiene <<'EOF'
#!/bin/sh
find /root/.pm2/logs -type f -mtime +7 -delete 2>/dev/null || true
find /root/xln/logs -type f -mtime +7 -delete 2>/dev/null || true
find /root/xln/.logs -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
find /root/xln/playwright-report -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
find /root/xln/test-results -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
find /root/xln/e2e/test-results -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
find /root/xln/tests/test-results -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
find /root/.foundry/anvil/tmp -mindepth 1 -mmin +180 -exec rm -rf {} + 2>/dev/null || true
find /var/lib/xln/jdb/tmp -mindepth 1 -mmin +180 -exec rm -rf {} + 2>/dev/null || true
if [ -d /root/.foundry/anvil/tmp ]; then
  find /root/.foundry/anvil/tmp -mindepth 1 -exec rm -rf {} + 2>/dev/null || true
fi
journalctl --vacuum-size=200M >/dev/null 2>&1 || true
curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 || true
EOF
  chmod +x /etc/cron.hourly/xln-log-hygiene

  cat > /etc/cron.hourly/xln-storage-guard <<'EOF'
#!/bin/sh
free_kb="$(df -Pk / | awk 'NR==2 { print $4 }')"
if [ "${free_kb:-0}" -lt $((10 * 1024 * 1024)) ]; then
  logger -t xln-storage-guard "low disk free: ${free_kb}KB"
fi

if ! XLN_JDB_ROOT=/var/lib/xln/jdb ANVIL_STORAGE_BUDGET_GIB=10 /root/xln/scripts/enforce-anvil-storage-budget.sh >/dev/null 2>&1; then
  logger -t xln-storage-guard "anvil storage exceeded 10GiB after temp cleanup"
fi

journalctl --vacuum-size=200M >/dev/null 2>&1 || true
EOF
  chmod +x /etc/cron.hourly/xln-storage-guard

  cat > /etc/logrotate.d/xln-runtime-logs <<'EOF'
/root/xln/logs/*.log {
  daily
  rotate 5
  missingok
  notifempty
  copytruncate
  compress
  delaycompress
  maxsize 20M
}
EOF

find /root/.foundry/anvil/tmp -mindepth 1 -mmin +180 -exec rm -rf {} + 2>/dev/null || true
find /var/lib/xln/jdb/tmp -mindepth 1 -mmin +180 -exec rm -rf {} + 2>/dev/null || true
if [ -d /root/.foundry/anvil/tmp ]; then
  find /root/.foundry/anvil/tmp -mindepth 1 -exec rm -rf {} + 2>/dev/null || true
fi
}

run_local_deploy() {
  export PATH="$HOME/.bun/bin:$PATH"

  if [ "$FRESH" = "1" ]; then
    echo "[deploy] removing local runtime state"
    rm -rf db db-tmp
    find logs -type f -name '*.log' -delete 2>/dev/null || true
  fi

  echo "[deploy] installing root dependencies"
  bun install --frozen-lockfile

  echo "[deploy] syncing contract artifacts"
  ./scripts/sync-contract-artifacts.sh

  echo "[deploy] building browser runtime bundle"
  ./scripts/build-runtime.sh

  if [ "$BUILD_FRONTEND" = "1" ] || [ ! -d frontend/build ]; then
    DEPLOY_BUILD_NUMBER="$(date -u +%Y%m%d%H%M%S)"
    if git rev-parse --short HEAD >/dev/null 2>&1; then
      DEPLOY_BUILD_NUMBER="${DEPLOY_BUILD_NUMBER}-$(git rev-parse --short HEAD)"
    fi
    echo "[deploy] building frontend"
    echo "[deploy] frontend version $DEPLOY_BUILD_NUMBER"
    (
      cd frontend
      bun install --frozen-lockfile
      XLN_BUILD_NUMBER="$DEPLOY_BUILD_NUMBER" bun run build
    )
  else
    echo "[deploy] skipping frontend build (pass --frontend to force)"
  fi

  if command -v pm2 >/dev/null 2>&1; then
    echo "[deploy] restarting pm2 service"
    if [ "$PRODUCTION" = "1" ]; then
      run_or_fail_deploy "failed to enforce production host hygiene" ensure_production_host_hygiene
      run_or_fail_deploy "failed to configure production direct hub ports" ensure_production_direct_hub_ports
      run_or_fail_deploy "failed to enforce nginx site consistency" ensure_production_nginx_site_consistency
      mkdir -p logs
      pkill -TERM -f 'scripts/start-custody.sh' >/dev/null 2>&1 || true
      pkill -TERM -f 'runtime/scripts/start-custody-prod.ts' >/dev/null 2>&1 || true
      sleep 1
      pkill -KILL -f 'scripts/start-custody.sh' >/dev/null 2>&1 || true
      pkill -KILL -f 'runtime/scripts/start-custody-prod.ts' >/dev/null 2>&1 || true

      lsof -ti TCP:8087 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
      lsof -ti TCP:8088 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
      pm2 delete xln-server >/dev/null 2>&1 || true
      pm2 delete xln-watchtower >/dev/null 2>&1 || true
      pm2 delete xln-custody >/dev/null 2>&1 || true
      pkill -TERM -f 'runtime/orchestrator/hub-node.ts' >/dev/null 2>&1 || true
      pkill -TERM -f 'runtime/orchestrator/mm-node.ts' >/dev/null 2>&1 || true
      pkill -TERM -f 'runtime/orchestrator/orchestrator.ts' >/dev/null 2>&1 || true
      sleep 1
      pkill -KILL -f 'runtime/orchestrator/hub-node.ts' >/dev/null 2>&1 || true
      pkill -KILL -f 'runtime/orchestrator/mm-node.ts' >/dev/null 2>&1 || true
      pkill -KILL -f 'runtime/orchestrator/orchestrator.ts' >/dev/null 2>&1 || true

      export XLN_STATE_ROOT="${XLN_STATE_ROOT:-/var/lib/xln}"
      export XLN_JDB_ROOT="${XLN_JDB_ROOT:-$XLN_STATE_ROOT/jdb}"
      export XLN_RDB_ROOT="${XLN_RDB_ROOT:-$XLN_STATE_ROOT/rdb}"
      install -d -m 700 "$XLN_STATE_ROOT" "$XLN_JDB_ROOT" "$XLN_RDB_ROOT"

      migrate_production_path() {
        local source="$1"
        local destination="$2"
        [ -e "$source" ] || return 0
        if [ -e "$destination" ]; then
          echo "PRODUCTION_STATE_MIGRATION_COLLISION: source=$source destination=$destination" >&2
          return 1
        fi
        install -d -m 700 "$(dirname "$destination")"
        mv "$source" "$destination"
      }

      if [ -e data/anvil-state.json ] || [ -e data/anvil2-state.json ]; then
        pm2 delete anvil >/dev/null 2>&1 || true
        pm2 delete anvil2 >/dev/null 2>&1 || true
        lsof -ti TCP:8545 -sTCP:LISTEN 2>/dev/null | xargs kill -TERM 2>/dev/null || true
        lsof -ti TCP:8546 -sTCP:LISTEN 2>/dev/null | xargs kill -TERM 2>/dev/null || true
        sleep 2
      fi
      run_or_fail_deploy "failed to migrate production JDB" migrate_production_path data/anvil-state.json "$XLN_JDB_ROOT/anvil-state.json"
      run_or_fail_deploy "failed to migrate production JDB2" migrate_production_path data/anvil2-state.json "$XLN_JDB_ROOT/anvil2-state.json"
      run_or_fail_deploy "failed to migrate production runtime DB" migrate_production_path db/runtime "$XLN_RDB_ROOT/runtime"
      run_or_fail_deploy "failed to migrate production custody DB" migrate_production_path db/custody "$XLN_RDB_ROOT/custody"
      run_or_fail_deploy "failed to migrate production watchtower DB" migrate_production_path db/watchtower "$XLN_RDB_ROOT/watchtower"
      run_or_fail_deploy "failed to migrate production custody temp DB" migrate_production_path db-tmp/prod-custody "$XLN_RDB_ROOT/custody-tmp"
      run_or_fail_deploy "failed to migrate production storage history" migrate_production_path data/storage-health-history.json "$XLN_RDB_ROOT/storage-health-history.json"
      rm -rf data/anvil-tmp
      rmdir data db db-tmp 2>/dev/null || true
      chmod -R go-rwx "$XLN_STATE_ROOT"
      touch "$XLN_STATE_ROOT/.checkout-state-migrated"

      if [ "$RESET_PRODUCTION_MESH" = "1" ]; then
        export XLN_MESH_PRESERVE_STATE_ON_RESET=1
        echo "[deploy] resetting production anvil + runtime state"
        rm -rf "$XLN_RDB_ROOT/runtime/prod-main" "$XLN_RDB_ROOT/runtime/prod-mesh" "$XLN_RDB_ROOT/custody/prod" "$XLN_RDB_ROOT/custody-tmp"
        rm -f "$XLN_JDB_ROOT/anvil-state.json" "$XLN_JDB_ROOT/anvil2-state.json"
        install -d -m 700 "$XLN_RDB_ROOT/runtime"
        rm -f "$XLN_RDB_ROOT/runtime/.mesh-reset-once" "$XLN_RDB_ROOT/runtime/.mesh-reset-once.claimed"
        install -m 600 /dev/null "$XLN_RDB_ROOT/runtime/.mesh-reset-once"
        lsof -ti TCP:8545 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
        lsof -ti TCP:8546 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
        pm2 delete anvil >/dev/null 2>&1 || true
        pm2 delete anvil2 >/dev/null 2>&1 || true
        run_or_fail_deploy "failed to start anvil via pm2" pm2 start scripts/start-anvil.sh --name anvil --interpreter bash --max-memory-restart 512M --kill-timeout 60000 --restart-delay 2000
        run_or_fail_deploy "failed to start anvil2 via pm2" pm2 start scripts/start-anvil2.sh --name anvil2 --interpreter bash --max-memory-restart 512M --kill-timeout 60000 --restart-delay 2000
      else
        export XLN_MESH_PRESERVE_STATE_ON_RESET=1
        echo "[deploy] restarting production services without resetting anvil/runtime state"
        if ! wait_for_rpc_chain "http://127.0.0.1:8545" "0x7a69"; then
          pm2 delete anvil >/dev/null 2>&1 || true
          run_or_fail_deploy "failed to start anvil via pm2" pm2 start scripts/start-anvil.sh --name anvil --interpreter bash --max-memory-restart 512M --kill-timeout 60000 --restart-delay 2000
        fi
        if ! wait_for_rpc_chain "http://127.0.0.1:8546" "0x7a6a"; then
          pm2 delete anvil2 >/dev/null 2>&1 || true
          run_or_fail_deploy "failed to start anvil2 via pm2" pm2 start scripts/start-anvil2.sh --name anvil2 --interpreter bash --max-memory-restart 512M --kill-timeout 60000 --restart-delay 2000
        fi
      fi
      if ! wait_for_rpc_chain "http://127.0.0.1:8545" "0x7a69"; then
        fail_deploy_with_debug "anvil did not become ready on :8545"
      fi
      if ! wait_for_rpc_chain "http://127.0.0.1:8546" "0x7a6a"; then
        fail_deploy_with_debug "anvil2 did not become ready on :8546"
      fi
      run_or_fail_deploy "unsafe Anvil PM2 supervision" bun scripts/check-anvil-supervision.ts
      run_or_fail_deploy "primary Anvil did not persist a valid checkpoint" wait_for_anvil_state_checkpoint "$XLN_JDB_ROOT/anvil-state.json"
      run_or_fail_deploy "secondary Anvil did not persist a valid checkpoint" wait_for_anvil_state_checkpoint "$XLN_JDB_ROOT/anvil2-state.json"

      export XLN_PROD_DEPLOY_STARTED_AT_MS="$(bun -e 'console.log(Date.now())')"
      run_or_fail_deploy "failed to start xln-server via pm2" pm2 start scripts/start-server.sh --name xln-server --interpreter bash --max-memory-restart 900M
      run_or_fail_deploy "failed to start xln-watchtower via pm2" pm2 start scripts/start-watchtower.sh --name xln-watchtower --interpreter bash --max-memory-restart 256M
      if ! wait_for_watchtower; then
        fail_deploy_with_debug "official watchtower did not become healthy"
      fi
      if ! wait_for_main_stack; then
        fail_deploy_with_debug "main XLN stack did not become healthy"
      fi
      if ! wait_for_custody; then
        fail_deploy_with_debug "custody endpoints did not become healthy"
      fi
      if ! wait_for_public_direct_mesh; then
        fail_deploy_with_debug "public direct ws mesh did not become reachable"
      fi
      if ! wait_for_public_production_stack; then
        fail_deploy_with_debug "public production stack did not become healthy"
      fi
    else
      # Recreate from the wrapper on every non-fresh deploy. Restarting the existing PM2
      # entry can preserve an old direct command/env and silently drop wrapper defaults.
      pm2 delete xln-server >/dev/null 2>&1 || true
      run_or_fail_deploy "failed to start xln-server via pm2" pm2 start scripts/start-server.sh --name xln-server --interpreter bash --max-memory-restart 900M
    fi
    pm2 save
  else
    echo "[deploy] pm2 not found; build completed but process restart was skipped"
  fi
}

if [ -n "$REMOTE_HOST" ]; then
  if [ "$PUSH" = "1" ]; then
    ensure_main_branch_for_push
    ensure_clean_worktree_for_push
    echo "[deploy] pushing main to origin"
    git push origin main
  fi

  ORIGIN_URL="$(git remote get-url origin 2>/dev/null || printf '%s' 'https://github.com/xlnfinance/xln.git')"
  case "$ORIGIN_URL" in
    git@github.com:*)
      ORIGIN_URL="https://github.com/${ORIGIN_URL#git@github.com:}"
      ;;
    ssh://git@github.com/*)
      ORIGIN_URL="https://github.com/${ORIGIN_URL#ssh://git@github.com/}"
      ;;
  esac
  remote_frontend_archive=""
  if [ "$BUILD_FRONTEND" = "1" ]; then
    build_remote_frontend_archive
    remote_frontend_archive="/tmp/$(basename "$PREBUILT_FRONTEND_ARCHIVE")"
    echo "[deploy] uploading prebuilt frontend to $REMOTE_HOST"
    scp "$PREBUILT_FRONTEND_ARCHIVE" "$REMOTE_HOST:$remote_frontend_archive"
  fi

  # Remote deploy keeps the checkout self-healing. Frontend compilation happens on the
  # caller so Vite cannot OOM-kill live Anvil processes on the production host.
  # some servers may retain /root/xln but lose .git metadata after disk cleanup or
  # manual recovery. In that case we must re-bootstrap the checkout before rebuilding
  # frontend/runtime. The first rollout preserves legacy checkout state for migration;
  # later rollouts clean it because production persistence lives in /var/lib/xln.
  remote_cmd="set -e; XLN_DIR=\"\"; if [ -d /root/xln ]; then XLN_DIR=/root/xln; elif [ -d \"\$HOME/xln\" ]; then XLN_DIR=\"\$HOME/xln\"; else XLN_DIR=/root/xln; mkdir -p \"\$XLN_DIR\"; fi; cd \"\$XLN_DIR\"; PATH=\"\$HOME/.bun/bin:\$PATH\"; if [ ! -d .git ]; then echo '[deploy] remote checkout missing .git; reinitializing repository'; git init; fi; if ! git remote get-url origin >/dev/null 2>&1; then git remote add origin '$ORIGIN_URL'; else git remote set-url origin '$ORIGIN_URL'; fi; git fetch origin main; git reset --hard; if [ -f /var/lib/xln/.checkout-state-migrated ]; then git clean -fd; else git clean -fd -e data/ -e db/ -e db-tmp/; fi; git checkout -B main origin/main; git reset --hard origin/main; if [ -f /var/lib/xln/.checkout-state-migrated ]; then git clean -fd; else git clean -fd -e data/ -e db/ -e db-tmp/; fi;"
  if [ -n "$remote_frontend_archive" ]; then
    remote_cmd="$remote_cmd rm -rf frontend/build; tar -xzf '$remote_frontend_archive' -C frontend; rm -f '$remote_frontend_archive';"
  fi
  if [ "$FRONTEND_ONLY" = "1" ]; then
    remote_cmd="$remote_cmd test -s frontend/build/index.html; echo '[deploy] frontend artifact installed without runtime restart';"
  else
    remote_cmd="$remote_cmd ./deploy.sh --runtime-only"
    if [ "$FRESH" = "1" ]; then
      remote_cmd="$remote_cmd --fresh"
    fi
    if [ "$PRODUCTION" = "1" ]; then
      remote_cmd="$remote_cmd --production"
    fi
    if [ "$RESET_PRODUCTION_MESH" = "1" ]; then
      remote_cmd="$remote_cmd --reset-mesh"
    else
      remote_cmd="$remote_cmd --code-only"
    fi
  fi

  echo "[deploy] running remote deploy on $REMOTE_HOST"
  ssh "$REMOTE_HOST" "$remote_cmd"
  exit 0
fi

if [ "$PRODUCTION" = "1" ] && [ "$BUILD_FRONTEND" = "1" ] && [ "${XLN_ALLOW_IN_PLACE_PRODUCTION_FRONTEND_BUILD:-0}" != "1" ]; then
  echo "PRODUCTION_FRONTEND_BUILD_FORBIDDEN: deploy from another host with --remote" >&2
  exit 1
fi

run_local_deploy
