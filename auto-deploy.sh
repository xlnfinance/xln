#!/bin/bash
# Auto-deploy wrapper (delegates to unified deploy.sh)

set -euo pipefail

REMOTE_HOST="${XLN_DEPLOY_HOST:-root@xln.finance}"
ARGS=(--remote "$REMOTE_HOST" --push)

if [ "${XLN_DEPLOY_FRONTEND:-0}" = "1" ]; then
  ARGS+=(--frontend)
fi
if [ "${XLN_DEPLOY_FRESH:-0}" = "1" ]; then
  ARGS+=(--fresh)
fi

exec ./deploy.sh "${ARGS[@]}"
