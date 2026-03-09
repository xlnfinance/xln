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

wait_for_custody() {
  local deadline=$((SECONDS + 120))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body
    body="$(curl -fsS http://127.0.0.1:8087/api/me || true)"
    if [ -n "$body" ] && node -e '
      const payload = JSON.parse(process.argv[1]);
      const ok = typeof payload?.custody?.entityId === "string" && payload.custody.entityId.length > 0;
      process.exit(ok ? 0 : 1);
    ' "$body"; then
      return 0
    fi
    sleep 1
  done
  return 1
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
      echo "[deploy] resetting production anvil + runtime state"
      mkdir -p db/runtime db/custody data logs
      rm -rf db/runtime/prod-main db/custody/prod db-tmp/prod-custody
      rm -f data/anvil-state.json

      lsof -ti TCP:8545 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
      pm2 delete xln-server >/dev/null 2>&1 || true
      pm2 delete xln-custody >/dev/null 2>&1 || true
      pm2 delete anvil >/dev/null 2>&1 || true

      pm2 start scripts/start-anvil.sh --name anvil --interpreter bash -- --reset
      if ! wait_for_rpc_chain "http://127.0.0.1:8545" "0x7a69"; then
        echo "[deploy] anvil did not become ready on :8545" >&2
        pm2 logs anvil --lines 120 --nostream || true
        exit 1
      fi

      pm2 delete xln-server >/dev/null 2>&1 || true
      pm2 start scripts/start-server.sh --name xln-server --interpreter bash
      if ! wait_for_main_stack; then
        echo "[deploy] main XLN stack did not become healthy" >&2
        pm2 logs xln-server --lines 160 --nostream || true
        exit 1
      fi

      pm2 delete xln-custody >/dev/null 2>&1 || true
      pm2 start scripts/start-custody.sh --name xln-custody --interpreter bash
      if ! wait_for_custody; then
        echo "[deploy] custody service did not become healthy" >&2
        pm2 logs xln-custody --lines 160 --nostream || true
        exit 1
      fi
    else
      pm2 describe xln-server >/dev/null 2>&1 \
        && pm2 restart xln-server \
        || pm2 start scripts/start-server.sh --name xln-server --interpreter bash
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

  remote_cmd="cd /root/xln 2>/dev/null || cd ~/xln 2>/dev/null || exit 1; PATH=\"\$HOME/.bun/bin:\$PATH\" git fetch origin main && git stash push --include-untracked -m xln-deploy-prepull -- frontend/static/contracts jurisdictions/jurisdictions.json >/dev/null 2>&1 || true && git checkout main && git pull --ff-only origin main && ./deploy.sh"
  if [ "$FRESH" = "1" ]; then
    remote_cmd="$remote_cmd --fresh"
  fi
  if [ "$BUILD_FRONTEND" = "1" ]; then
    remote_cmd="$remote_cmd --frontend"
  fi
  remote_cmd="$remote_cmd --production"

  echo "[deploy] running remote deploy on $REMOTE_HOST"
  ssh "$REMOTE_HOST" "$remote_cmd"
  exit 0
fi

run_local_deploy
