#!/bin/bash
set -euo pipefail
phase="${1:?exact phase required}"
case "$phase" in rollback|restore) ;; *) exit 2 ;; esac
remote_artifacts=/root/xln-deployment-evidence/996773462/backend-rollback
local_artifacts=/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/backend-rollback
ssh -o BatchMode=yes -o ConnectTimeout=10 xln.finance "cd /root/xln && export PATH=/root/.local/share/xln/toolchains/bun-1.4.0:/root/.bun/bin:/root/.foundry/bin:\$PATH && bun run stand:status && bun run stand:run --reason backend-$phase-financial-recovery --timeout-ms 60000 -- bash -c 'for hub in H1 H2 H3; do bun $remote_artifacts/$phase/compare-history.ts --hub=\$hub || exit; done'"
scp "xln.finance:$remote_artifacts/$phase/history-comparison-*.json" "$local_artifacts/$phase/"
