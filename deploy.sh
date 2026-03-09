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
      pm2 delete ecosystem.production >/dev/null 2>&1 || true
      pm2 describe xln-server >/dev/null 2>&1 \
        && pm2 restart xln-server --update-env \
        || pm2 start scripts/start-server.sh --name xln-server --interpreter bash
      pm2 describe xln-custody >/dev/null 2>&1 \
        && pm2 restart xln-custody --update-env \
        || pm2 start scripts/start-custody.sh --name xln-custody --interpreter bash
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
