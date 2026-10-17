#!/bin/bash
set -euo pipefail
phase="${1:?exact phase required}"
case "$phase" in
 rollback) source=9967734624cd70bebf4bb60992791efc5a36cdc5 ;;
 restore) source=efb6f5d4181114457cf3d62077c5d624b9fef9b3 ;;
 *) exit 2 ;;
esac
remote_artifacts=/root/xln-deployment-evidence/996773462/backend-rollback
local_artifacts=/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/backend-rollback
ssh -o BatchMode=yes -o ConnectTimeout=10 xln.finance "cd /root/xln && export PATH=/root/.local/share/xln/toolchains/bun-1.4.0:/root/.bun/bin:/root/.foundry/bin:\$PATH && bun run stand:status && bun run stand:run --reason backend-$phase --timeout-ms 60000 -- python3 '$remote_artifacts/switch.py' '$phase' '$source'"
scp "xln.finance:$remote_artifacts/$phase/switch-result.json" "xln.finance:$remote_artifacts/$phase/switch-progress.json" "$local_artifacts/$phase/"
