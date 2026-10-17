#!/bin/bash
set -euo pipefail
local_artifacts=/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/backend-rollback
remote_artifacts=/root/xln-deployment-evidence/996773462/backend-rollback
ssh -o BatchMode=yes -o ConnectTimeout=10 xln.finance "test ! -e '$remote_artifacts' && mkdir -m 700 '$remote_artifacts' && mkdir -m 700 '$remote_artifacts/rollback' '$remote_artifacts/restore'"
scp "$local_artifacts/preflight.py" "$local_artifacts/snapshot.ts" "$local_artifacts/compatibility.json" "xln.finance:$remote_artifacts/"
for phase in rollback restore; do scp "$local_artifacts/$phase/compare-history.ts" "xln.finance:$remote_artifacts/$phase/"; done
ssh -o BatchMode=yes -o ConnectTimeout=10 xln.finance "cd /root/xln && export PATH=/root/.local/share/xln/toolchains/bun-1.4.0:/root/.bun/bin:/root/.foundry/bin:\$PATH && bun run stand:status && bun run stand:run --reason backend-rollback-preservation --timeout-ms 60000 -- python3 '$remote_artifacts/preflight.py'"
scp "xln.finance:$remote_artifacts/preflight.json" "xln.finance:$remote_artifacts/before.json" "xln.finance:$remote_artifacts/source.bundle" "$local_artifacts/"
