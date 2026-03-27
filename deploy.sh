#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

REMOTE_HOST=""
PUSH=0
FRESH=0
BUILD_FRONTEND=0
PRODUCTION=0

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
    --production)
      PRODUCTION=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: ./deploy.sh [--remote host] [--push] [--fresh] [--frontend] [--production]" >&2
      exit 1
      ;;
  esac
done

ensure_main_branch_for_push() {
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != "main" ]; then
    echo "Refusing --push from branch '$branch'. Switch to main first." >&2
    exit 1
  fi
}

wait_for_rpc_chain() {
  local rpc_url="$1"
  local expected_chain_hex="$2"
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body
    body="$(curl -sS -X POST -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
      "$rpc_url" || true)"
    if printf '%s' "$body" | grep -q "\"result\":\"$expected_chain_hex\""; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_main_stack() {
  local deadline=$((SECONDS + 180))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body
    body="$(curl -fsS http://127.0.0.1:8080/api/health || true)"
    if [ -n "$body" ] && node -e '
      const payload = JSON.parse(process.argv[1]);
      const ok =
        payload?.system?.runtime === true &&
        payload?.system?.relay === true &&
        payload?.hubMesh?.ok === true &&
        payload?.marketMaker?.ok === true &&
        payload?.custody?.ok === true &&
        Array.isArray(payload?.hubs) &&
        payload.hubs.length >= 3;
      process.exit(ok ? 0 : 1);
    ' "$body"; then
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

wait_for_http_json_field() {
  local url="$1"
  local js_expr="$2"
  local deadline="$3"
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body
    body="$(curl -fsS "$url" || true)"
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
    "http://127.0.0.1:8088/api/health" \
    "return payload?.system?.runtime === true && payload?.system?.relay === true;" \
    "$deadline" \
    || return 1

  wait_for_http_json_field \
    "http://127.0.0.1:8087/api/me" \
    "return typeof payload?.custody?.entityId === 'string' && payload.custody.entityId.length > 0;" \
    "$deadline"
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

  install -d /root/xln/data /root/xln/data/anvil-tmp

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
    if ! pm2 module:list 2>/dev/null | grep -q 'pm2-logrotate'; then
      pm2 install pm2-logrotate || true
    fi
    pm2 set pm2-logrotate:max_size 20M >/dev/null || true
    pm2 set pm2-logrotate:retain 2 >/dev/null || true
    pm2 set pm2-logrotate:compress true >/dev/null || true
    pm2 set pm2-logrotate:workerInterval 1800 >/dev/null || true
    pm2 set pm2-logrotate:rotateInterval '0 0 * * *' >/dev/null || true
    pm2 set pm2-logrotate:rotateModule true >/dev/null || true
  fi

  install -d /etc/cron.hourly
  cat > /etc/cron.hourly/xln-log-hygiene <<'EOF'
#!/bin/sh
find /root/.pm2/logs -type f -name '*.log' -size +20M -exec truncate -s 0 {} \; 2>/dev/null || true
find /root/xln/logs -type f -name '*.log' -size +20M -exec truncate -s 0 {} \; 2>/dev/null || true
find /root/.pm2/logs -type f -mtime +1 -delete 2>/dev/null || true
find /root/xln/logs -type f -mtime +1 -delete 2>/dev/null || true
find /root/xln/.logs -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
find /root/xln/playwright-report -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
find /root/xln/test-results -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
find /root/xln/e2e/test-results -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
find /root/xln/tests/test-results -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
find /root/.foundry/anvil/tmp -mindepth 1 -mmin +180 -exec rm -rf {} + 2>/dev/null || true
find /root/xln/data/anvil-tmp -mindepth 1 -mmin +180 -exec rm -rf {} + 2>/dev/null || true
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

anvil_tmp_bytes="$(du -sk /root/xln/data/anvil-tmp /root/.foundry/anvil/tmp 2>/dev/null | awk '{sum+=$1} END {print sum+0}')"
if [ "${anvil_tmp_bytes:-0}" -gt $((8 * 1024 * 1024)) ]; then
  logger -t xln-storage-guard "anvil tmp high-water mark: ${anvil_tmp_bytes}KB"
fi

journalctl --vacuum-size=200M >/dev/null 2>&1 || true
EOF
  chmod +x /etc/cron.hourly/xln-storage-guard

  cat > /etc/logrotate.d/xln-runtime-logs <<'EOF'
/root/xln/logs/*.log {
  daily
  rotate 2
  compress
  missingok
  notifempty
  copytruncate
}
EOF

find /root/.pm2/logs -type f -name '*.log' -exec truncate -s 0 {} \; 2>/dev/null || true
find /root/xln/logs -type f -name '*.log' -exec truncate -s 0 {} \; 2>/dev/null || true
find /root/.foundry/anvil/tmp -mindepth 1 -mmin +180 -exec rm -rf {} + 2>/dev/null || true
find /root/xln/data/anvil-tmp -mindepth 1 -mmin +180 -exec rm -rf {} + 2>/dev/null || true
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
  bun install

  echo "[deploy] syncing contract artifacts"
  ./scripts/sync-contract-artifacts.sh

  echo "[deploy] building browser runtime bundle"
  ./scripts/build-runtime.sh

  if [ "$BUILD_FRONTEND" = "1" ] || [ ! -d frontend/build ]; then
    echo "[deploy] building frontend"
    (
      cd frontend
      bun install
      bun run build
    )
  else
    echo "[deploy] skipping frontend build (pass --frontend to force)"
  fi

  if command -v pm2 >/dev/null 2>&1; then
    echo "[deploy] restarting pm2 service"
    if [ "$PRODUCTION" = "1" ]; then
      ensure_production_host_hygiene
      ensure_production_direct_hub_ports
      echo "[deploy] resetting production anvil + runtime state"
      mkdir -p db/runtime db/custody data logs
      rm -rf db/runtime/prod-main db/runtime/prod-mesh db/custody/prod db-tmp/prod-custody
      rm -f data/anvil-state.json

      lsof -ti TCP:8545 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
      pm2 delete xln-server >/dev/null 2>&1 || true
      pm2 delete xln-custody >/dev/null 2>&1 || true
      pm2 delete anvil >/dev/null 2>&1 || true

      pm2 start scripts/start-anvil.sh --name anvil --interpreter bash --max-memory-restart 512M -- --reset
      if ! wait_for_rpc_chain "http://127.0.0.1:8545" "0x7a69"; then
        echo "[deploy] anvil did not become ready on :8545" >&2
        pm2 logs anvil --lines 120 --nostream || true
        exit 1
      fi

      pm2 delete xln-server >/dev/null 2>&1 || true
      pm2 start scripts/start-server.sh --name xln-server --interpreter bash --max-memory-restart 900M
      if ! wait_for_main_stack; then
        echo "[deploy] main XLN stack did not become healthy" >&2
        pm2 logs xln-server --lines 160 --nostream || true
        exit 1
      fi
      if ! wait_for_public_direct_mesh; then
        echo "[deploy] public direct ws mesh did not become reachable" >&2
        pm2 logs xln-server --lines 200 --nostream || true
        exit 1
      fi
    else
      pm2 describe xln-server >/dev/null 2>&1 \
        && pm2 restart xln-server \
        || pm2 start scripts/start-server.sh --name xln-server --interpreter bash --max-memory-restart 900M
    fi
    pm2 save
  else
    echo "[deploy] pm2 not found; build completed but process restart was skipped"
  fi
}

if [ -n "$REMOTE_HOST" ]; then
  if [ "$PUSH" = "1" ]; then
    ensure_main_branch_for_push
    echo "[deploy] pushing main to origin"
    git push origin main
  fi

  remote_cmd="cd /root/xln 2>/dev/null || cd ~/xln 2>/dev/null || exit 1; PATH=\"\$HOME/.bun/bin:\$PATH\" git fetch origin main && git stash push --include-untracked -m xln-deploy-prepull -- frontend/static/contracts jurisdictions/jurisdictions.json data/anvil-state.json >/dev/null 2>&1 || true && git checkout main && git pull --ff-only origin main && ./deploy.sh"
  if [ "$FRESH" = "1" ]; then
    remote_cmd="$remote_cmd --fresh"
  fi
  if [ "$BUILD_FRONTEND" = "1" ]; then
    remote_cmd="$remote_cmd --frontend"
  fi
  if [ "$PRODUCTION" = "1" ]; then
    remote_cmd="$remote_cmd --production"
  fi

  echo "[deploy] running remote deploy on $REMOTE_HOST"
  ssh "$REMOTE_HOST" "$remote_cmd"
  exit 0
fi

run_local_deploy
