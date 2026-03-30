#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BLOCKSCOUT_DIR="$REPO_ROOT/ops/blockscout"

REMOTE_HOST=""
HOST_LOCAL=0
DOMAIN="${BLOCKSCOUT_DOMAIN:-explorer.xln.finance}"
PROXY_PORT="${BLOCKSCOUT_PROXY_PORT:-18085}"
PROJECT_NAME="${BLOCKSCOUT_PROJECT_NAME:-xln-explorer}"
RPC_HTTP_URL="${BLOCKSCOUT_RPC_HTTP_URL:-http://host.docker.internal:8545/}"
RPC_TRACE_URL="${BLOCKSCOUT_RPC_TRACE_URL:-http://host.docker.internal:8545/}"
RPC_WS_URL="${BLOCKSCOUT_RPC_WS_URL:-ws://host.docker.internal:8545/}"
PUBLIC_RPC_URL="${BLOCKSCOUT_PUBLIC_RPC_URL:-https://xln.finance/rpc}"
NETWORK_NAME="${BLOCKSCOUT_NETWORK_NAME:-XLN Testnet}"
NETWORK_SHORT_NAME="${BLOCKSCOUT_NETWORK_SHORT_NAME:-XLN}"
NATIVE_NAME="${BLOCKSCOUT_NATIVE_NAME:-Ether}"
NATIVE_SYMBOL="${BLOCKSCOUT_NATIVE_SYMBOL:-ETH}"
NATIVE_DECIMALS="${BLOCKSCOUT_NATIVE_DECIMALS:-18}"
BACKEND_TAG="${BLOCKSCOUT_BACKEND_TAG:-latest}"
FRONTEND_TAG="${BLOCKSCOUT_FRONTEND_TAG:-latest}"
CHAIN_ID_DEC="${BLOCKSCOUT_CHAIN_ID:-}"
CERT_DOMAIN="${BLOCKSCOUT_CERT_DOMAIN:-xln.finance}"
ENV_FILE="$BLOCKSCOUT_DIR/.env.runtime"

usage() {
  cat <<EOF
Usage: $0 [--remote host] [--host-local] [--domain explorer.xln.finance] [--proxy-port 18085]

Runs Blockscout as a sidecar explorer for the local/prod Anvil RPC and configures nginx for the public domain.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --remote)
      REMOTE_HOST="${2:-}"
      shift 2
      ;;
    --host-local)
      HOST_LOCAL=1
      shift
      ;;
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --proxy-port)
      PROXY_PORT="${2:-}"
      shift 2
      ;;
    --project-name)
      PROJECT_NAME="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

detect_chain_id_dec() {
  local rpc_url="$1"
  local chain_hex
  chain_hex="$(curl -fsS -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
    "$rpc_url" | sed -n 's/.*"result":"\(0x[0-9a-fA-F]\+\)".*/\1/p')"
  if [ -z "$chain_hex" ]; then
    echo "Failed to detect chain id from $rpc_url" >&2
    exit 1
  fi
  printf '%d' "$((chain_hex))"
}

ensure_env_file() {
  mkdir -p "$BLOCKSCOUT_DIR"
  local db_password secret_key
  if [ -f "$ENV_FILE" ]; then
    db_password="$(grep '^BLOCKSCOUT_DB_PASSWORD=' "$ENV_FILE" | sed 's/^[^=]*=//')"
    secret_key="$(grep '^BLOCKSCOUT_SECRET_KEY_BASE=' "$ENV_FILE" | sed 's/^[^=]*=//')"
    CHAIN_ID_DEC="${CHAIN_ID_DEC:-$(grep '^BLOCKSCOUT_CHAIN_ID=' "$ENV_FILE" | sed 's/^[^=]*=//')}"
  fi
  if [ -z "${db_password:-}" ]; then
    db_password="$(openssl rand -base64 36 | tr -d '\n=+/')"
  fi
  if [ -z "${secret_key:-}" ]; then
    secret_key="$(openssl rand -base64 64 | tr -d '\n')"
  fi
  if [ -z "${CHAIN_ID_DEC:-}" ]; then
    CHAIN_ID_DEC="$(detect_chain_id_dec "${PUBLIC_RPC_URL}")"
  fi

  cat > "$ENV_FILE" <<EOF
BLOCKSCOUT_DOMAIN=${DOMAIN}
BLOCKSCOUT_PROXY_PORT=${PROXY_PORT}
BLOCKSCOUT_CHAIN_ID=${CHAIN_ID_DEC}
BLOCKSCOUT_NETWORK_NAME=${NETWORK_NAME}
BLOCKSCOUT_NETWORK_SHORT_NAME=${NETWORK_SHORT_NAME}
BLOCKSCOUT_NATIVE_NAME=${NATIVE_NAME}
BLOCKSCOUT_NATIVE_SYMBOL=${NATIVE_SYMBOL}
BLOCKSCOUT_NATIVE_DECIMALS=${NATIVE_DECIMALS}
BLOCKSCOUT_PUBLIC_RPC_URL=${PUBLIC_RPC_URL}
BLOCKSCOUT_RPC_HTTP_URL=${RPC_HTTP_URL}
BLOCKSCOUT_RPC_TRACE_URL=${RPC_TRACE_URL}
BLOCKSCOUT_RPC_WS_URL=${RPC_WS_URL}
BLOCKSCOUT_BACKEND_TAG=${BACKEND_TAG}
BLOCKSCOUT_FRONTEND_TAG=${FRONTEND_TAG}
BLOCKSCOUT_DB_NAME=blockscout
BLOCKSCOUT_DB_USER=blockscout
BLOCKSCOUT_DB_PASSWORD=${db_password}
BLOCKSCOUT_SECRET_KEY_BASE=${secret_key}
EOF
}

write_nginx_conf() {
  cat > /etc/nginx/conf.d/xln-explorer.conf <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    location / {
        return 301 https://\$server_name\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${CERT_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${CERT_DOMAIN}/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;

    location / {
        proxy_pass http://127.0.0.1:${PROXY_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
EOF
  nginx -t
  systemctl reload nginx
}

wait_for_http() {
  local url="$1"
  local deadline=$((SECONDS + 300))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for $url" >&2
  return 1
}

run_host_local() {
  require_cmd docker
  require_cmd curl
  require_cmd openssl
  require_cmd nginx

  cd "$REPO_ROOT"
  ensure_env_file
  docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$BLOCKSCOUT_DIR/docker-compose.yml" up -d
  write_nginx_conf
  wait_for_http "http://127.0.0.1:${PROXY_PORT}"
  wait_for_http "https://${DOMAIN}"
  echo "[explorer] ready: https://${DOMAIN}"
}

if [ -n "$REMOTE_HOST" ] && [ "$HOST_LOCAL" -eq 0 ]; then
  require_cmd tar
  require_cmd ssh
  tmp_archive="/tmp/xln-blockscout-$$.tar"
  tar -C "$REPO_ROOT" -cf "$tmp_archive" ops/blockscout scripts/deploy-blockscout-explorer.sh
  ssh "$REMOTE_HOST" "mkdir -p /root/xln"
  cat "$tmp_archive" | ssh "$REMOTE_HOST" "tar -C /root/xln -xf -"
  rm -f "$tmp_archive"
  ssh "$REMOTE_HOST" "cd /root/xln && bash scripts/deploy-blockscout-explorer.sh --host-local --domain '$DOMAIN' --proxy-port '$PROXY_PORT' --project-name '$PROJECT_NAME'"
  exit 0
fi

run_host_local
