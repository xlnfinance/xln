#!/bin/bash
set -euo pipefail
local_artifacts=/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/backend-rollback
remote_artifacts=/root/xln-deployment-evidence/996773462/backend-rollback
scp "$local_artifacts/snapshot-before-restore.ts" "xln.finance:$remote_artifacts/"
ssh -o BatchMode=yes -o ConnectTimeout=10 xln.finance "cd /root/xln && export PATH=/root/.local/share/xln/toolchains/bun-1.4.0:/root/.bun/bin:/root/.foundry/bin:\$PATH && test ! -e '$remote_artifacts/restore/before.json' && bun run stand:status && bun run stand:run --reason backend-restore-preservation --timeout-ms 60000 -- bun '$remote_artifacts/snapshot-before-restore.ts' before"
scp "xln.finance:$remote_artifacts/restore/before.json" "$local_artifacts/restore/"
